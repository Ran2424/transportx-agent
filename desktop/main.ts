const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import type { BrowserWindow as BrowserWindowType } from 'electron';
import { AgentHostSupervisor } from './agent-host-supervisor.js';
import { resolveDesktopPaths, resolveDesktopUserDataDir } from './app-paths.js';

let mainWindow: BrowserWindowType | null = null;
let supervisor: AgentHostSupervisor | null = null;
let quitting = false;
let workbenchOrigin = '';

app.setPath('userData', resolveDesktopUserDataDir(app.getPath('home'), app.getPath('userData')));

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
        else finish(new Error(`PDF download ${state}`));
      });
    };
    const timeout = setTimeout(() => finish(new Error('PDF download timed out')), 30_000);
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
  const isMac = process.platform === 'darwin';
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.loadURL(windowUrl.toString()).catch((error: Error) => {
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
    ipcMain.handle('transportx:download', async (event: Electron.IpcMainInvokeEvent, value: unknown) => {
      if (event.sender !== mainWindow?.webContents || typeof value !== 'string') throw new Error('Invalid download request');
      const target = new URL(value, workbenchOrigin);
      if (target.origin !== workbenchOrigin || !/^\/api\/reports\/pdf\/download\/[a-f0-9-]+$/.test(target.pathname)) throw new Error('Invalid download URL');
      return await downloadToFile(event.sender, target.toString());
    });
    const paths = resolveDesktopPaths(app.getAppPath(), process.resourcesPath, app.getPath('userData'));
    supervisor = new AgentHostSupervisor({
      paths,
      onUnexpectedExit: (message) => {
        dialog.showErrorBox('TransportX Agent', `${message}\n${nativeText(`请查看 ${paths.logsDir} 中的日志。`, `See the logs in ${paths.logsDir}.`)}`);
        app.quit();
      },
      renderPdf,
    });
    try { createWindow(await supervisor.start()); }
    catch (error) {
      dialog.showErrorBox(nativeText('TransportX Agent 启动失败', 'TransportX Agent failed to start'), error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on('before-quit', (event: Electron.Event) => {
    if (quitting || !supervisor) return;
    event.preventDefault();
    quitting = true;
    supervisor.stop().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}