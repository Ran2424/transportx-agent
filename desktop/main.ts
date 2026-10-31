const { hostPlatform } = require('../bin/host-platform.js');
const { createDiagnosticLogger } = require('../bin/diagnostic-log.js');
const { toPosixPath } = require('../bin/util/path.js');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import type { BrowserWindow as BrowserWindowType } from 'electron';
import { AgentHostSupervisor } from './agent-host-supervisor.js';
import { resolveDesktopPaths, resolveDesktopUserDataDir } from './app-paths.js';
import { UpdateService, assertUpdateSender } from './update-service.js';
import { restoreCachedUpdate } from './update-cache.js';
import { readWebsiteRelease } from './website-release.js';

let mainWindow: BrowserWindowType | null = null;
let supervisor: AgentHostSupervisor | null = null;
let quitting = false;
let workbenchOrigin = '';
let updateService: UpdateService | null = null;
let installingUpdate = false;

app.setPath('userData', resolveDesktopUserDataDir(app.getPath('home'), app.getPath('userData')));
const logDesktop = createDiagnosticLogger(path.join(app.getPath('userData'), 'logs', 'desktop.log'));
process.on('uncaughtExceptionMonitor', (error) => logDesktop('error', 'desktop_uncaught_exception', { message: error.message, stack: error.stack }));
app.on('render-process-gone', (_event: Electron.Event, contents: Electron.WebContents, details: Electron.RenderProcessGoneDetails) => logDesktop(details.reason === 'clean-exit' ? 'info' : 'error', 'renderer_exited', { webContentsId: contents.id, reason: details.reason, exitCode: details.exitCode }));

function isHttpUrl(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function nativeText(zh: string, en: string) {
  return app.getLocale().toLowerCase().startsWith('zh') ? zh : en;
}

function nextDownloadPath(fileName: string) {
  const name = path.basename(fileName) || 'download.pdf';
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  const directory = app.getPath('downloads');
  let candidate = path.join(directory, name);
  for (let index = 1; fs.existsSync(candidate); index += 1) candidate = path.join(directory, `${base} (${index})${extension}`);
  return candidate;
}

function downloadToFile(sender: Electron.WebContents, url: string) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, destination?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sender.session.removeListener('will-download', onWillDownload);
      if (error) reject(error);
      else resolve(destination!);
    };
    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents) => {
      if (contents !== sender) return;
      const destination = nextDownloadPath(item.getFilename());
      item.setSavePath(destination);
      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') finish(undefined, destination);
        else finish(new Error(`Download ${state}`));
      });
    };
    const timeout = setTimeout(() => finish(new Error('Download timed out')), 30_000);
    sender.session.on('will-download', onWillDownload);
    try { sender.downloadURL(url); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function renderPdf(_title: string, html: string) {
  const temporaryDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'transportx-pdf-'));
  const reportPath = path.join(temporaryDir, 'report.html');
  const reportUrl = pathToFileURL(reportPath).toString();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: false,
      partition: `temp:transportx-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  window.webContents.session.webRequest.onBeforeRequest((details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) => {
    callback({ cancel: details.url !== reportUrl && !/^(?:about:|data:)/.test(details.url) });
  });
  try {
    await fs.promises.writeFile(reportPath, html, 'utf8');
    await window.loadFile(reportPath);
    return await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;padding:0 16mm;color:#999;font-size:7px;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margins: { top: 0.71, right: 0.63, bottom: 0.79, left: 0.63 },
    });
  } finally {
    window.destroy();
    await fs.promises.rm(temporaryDir, { recursive: true, force: true });
  }
}

function createWindow(url: string) {
  const windowUrl = new URL(url);
  workbenchOrigin = windowUrl.origin;
  windowUrl.searchParams.set('desktop-platform', process.platform);
  const isMac = hostPlatform.insetTitleBar;
  const window = new BrowserWindow({
    title: 'TransportX Agent',
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fa',
    // macOS keeps 'hiddenInset' so the React header can extend under the
    // traffic-lights; every other OS gets a fully frameless chrome and the
    // React header renders custom minimise / maximise / close buttons.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // On non-mac hosts the application menu (File / Edit / View / Window)
  // would surface the OS chrome that makes the app feel like a wrapped
  // web view. Remove it; the in-app Command Palette (⌘K) and the React
  // workspace header replace those affordances.
  if (!isMac) Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(({ url: target }: { url: string }) => {
    if (isHttpUrl(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event: Electron.Event, target: string) => {
    if (target.startsWith(url)) return;
    event.preventDefault();
    if (isHttpUrl(target)) shell.openExternal(target).catch(() => {});
  });
  window.once('ready-to-show', () => {
    window.show();
    void updateService?.check();
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.loadURL(windowUrl.toString()).catch((error: Error) => {
    logDesktop('error', 'workbench_load_failed', { message: error.message, stack: error.stack });
    dialog.showErrorBox('TransportX Agent', `${nativeText('无法加载本地工作台', 'Could not load the local workbench')}: ${error.message}`);
    app.quit();
  });
  mainWindow = window;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    logDesktop('info', 'desktop_started', { version: app.getVersion() });
    const paths = resolveDesktopPaths(app.getAppPath(), process.resourcesPath, app.getPath('userData'));
    const logUpdate = createDiagnosticLogger(path.join(paths.logsDir, 'updates.log'));
    const { autoUpdater } = require('electron-updater');
    // Updater diagnostics can include complete URLs. Log only our state codes.
    autoUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    autoUpdater.disableWebInstaller = true;
    updateService = new UpdateService(autoUpdater, app.getVersion(), app.isPackaged, {
      prepare: async () => {
        if (!supervisor) throw new Error('Agent Host is unavailable');
        await supervisor.stopForUpdate();
      },
      recover: async () => {
        installingUpdate = false;
        const url = await supervisor?.recoverAfterUpdate();
        if (url && mainWindow) {
          workbenchOrigin = new URL(url).origin;
          const target = new URL(url);
          target.searchParams.set('desktop-platform', process.platform);
          await mainWindow.loadURL(target.toString());
        }
      },
      onInstalling: () => { installingUpdate = true; },
    }, () => restoreCachedUpdate(autoUpdater), () => readWebsiteRelease(hostPlatform.updateInstallerPattern));
    let loggedState = '';
    updateService.subscribe((state) => {
      const key = `${state.phase}:${state.errorCode || ''}`;
      if (key !== loggedState) {
        loggedState = key;
        logUpdate('info', 'update_state', { currentVersion: state.currentVersion, targetVersion: state.targetVersion, phase: state.phase, errorCode: state.errorCode });
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transportx:update:state', state);
    });
    for (const action of ['getState', 'check', 'download', 'install'] as const) {
      ipcMain.handle(`transportx:update:${action}`, (event: Electron.IpcMainInvokeEvent) => {
        assertUpdateSender(event, mainWindow, workbenchOrigin);
        return updateService![action]();
      });
    }
    // Window-control IPC for the frameless Win/Linux chrome. The renderer
    // sends 'transportx:window:minimize' / 'maximize' / 'close' and the main
    // process drives the underlying BrowserWindow. isMaximized() lets the UI
    // flip the maximise glyph between restore / maximise.
    ipcMain.handle('transportx:window:minimize', () => { mainWindow?.minimize(); });
    ipcMain.handle('transportx:window:toggle-maximize', () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.handle('transportx:window:is-maximized', () => Boolean(mainWindow?.isMaximized()));
    ipcMain.handle('transportx:window:close', () => { mainWindow?.close(); });
    ipcMain.handle('transportx:workspace:select-directory', async (event: Electron.IpcMainInvokeEvent) => {
      assertUpdateSender(event, mainWindow, workbenchOrigin);
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
      return result.canceled || !result.filePaths[0] ? null : toPosixPath(fs.realpathSync(result.filePaths[0]));
    });
    ipcMain.handle('transportx:download', async (event: Electron.IpcMainInvokeEvent, value: unknown) => {
      if (event.sender !== mainWindow?.webContents || typeof value !== 'string') throw new Error('Invalid download request');
      const target = new URL(value, workbenchOrigin);
      const reportPdf = /^\/api\/reports\/pdf\/download\/[a-f0-9-]+$/.test(target.pathname);
      const sessionFile = /^\/api\/conversations\/[^/]+\/(?:files\/raw|attachments\/[^/]+\/file)$/.test(target.pathname) && target.searchParams.get('download') === '1';
      const citationFile = /^\/api\/conversations\/[^/]+\/citation-resources\/[^/]+\/content$/.test(target.pathname) && target.searchParams.get('download') === '1';
      if (target.origin !== workbenchOrigin || (!reportPdf && !sessionFile && !citationFile)) throw new Error('Invalid download URL');
      return await downloadToFile(event.sender, target.toString());
    });
    supervisor = new AgentHostSupervisor({
      paths,
      onUnexpectedExit: (message) => {
        logDesktop('error', 'host_unexpected_exit', { message });
        dialog.showErrorBox('TransportX Agent', `${message}\n${nativeText(`请查看 ${paths.logsDir} 中的日志。`, `See the logs in ${paths.logsDir}.`)}`);
        app.quit();
      },
      confirmModuleTrust: async (request) => {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: nativeText('信任模块代码', 'Trust module code'),
          message: `${request.name} (${request.id}@${request.version})`,
          detail: nativeText(
            `来源：${request.packageRoot}\n入口：${request.entrypoints.join(', ') || '无'}\n依赖：${request.dependencies.join(', ') || '无'}\n\n此模块及其脚本、程序将以您的本机权限运行，可访问文件和网络。具体访问需求未经平台验证；这不是沙箱。仅信任您了解来源的代码。接受后允许此版本的安装、启用、样例测试和后续执行；代码可在该版本目录内编辑，新增入口或依赖及升级版本需重新确认。`,
            `Source: ${request.packageRoot}\nEntries: ${request.entrypoints.join(', ') || 'none'}\nDependencies: ${request.dependencies.join(', ') || 'none'}\n\nThis module and its scripts/programs run with your local permissions and can access files and networks. Specific access requirements have not been verified; this is not a sandbox. Only trust code whose source you understand. Acceptance covers installation, enabling, sample tests and subsequent execution of this version, including edits within its package. New entries, dependencies or versions require another review.`,
          ),
          buttons: [nativeText('取消', 'Cancel'), nativeText('信任并继续', 'Trust and continue')],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1;
      },
      renderPdf,
    });
    try { createWindow(await supervisor.start()); }
    catch (error) {
      logDesktop('error', 'desktop_start_failed', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      dialog.showErrorBox(nativeText('TransportX Agent 启动失败', 'TransportX Agent failed to start'), error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on('before-quit', (event: Electron.Event) => {
    if (installingUpdate) return;
    if (quitting || !supervisor) return;
    event.preventDefault();
    quitting = true;
    supervisor.stop().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}
