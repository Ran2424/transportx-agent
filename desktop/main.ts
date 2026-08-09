const { app, BrowserWindow, dialog, shell } = require('electron');

import type { BrowserWindow as BrowserWindowType } from 'electron';
import { AgentHostSupervisor } from './agent-host-supervisor.js';
import { resolveDesktopPaths, resolveDesktopUserDataDir } from './app-paths.js';

let mainWindow: BrowserWindowType | null = null;
let supervisor: AgentHostSupervisor | null = null;
let quitting = false;

app.setPath('userData', resolveDesktopUserDataDir(app.getPath('home'), app.getPath('userData')));

function isHttpUrl(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

async function renderPdf(_title: string, html: string) {
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
    callback({ cancel: !/^(?:about:|data:)/.test(details.url) });
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
  }
}

function createWindow(url: string) {
  const windowUrl = new URL(url);
  windowUrl.searchParams.set('desktop-platform', process.platform);
  const window = new BrowserWindow({
    title: 'TransportX Traffic Agent',
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });
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
    dialog.showErrorBox('TransportX Traffic Agent', `无法加载本地工作台：${error.message}`);
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
    const paths = resolveDesktopPaths(app.getAppPath(), process.resourcesPath, app.getPath('userData'));
    supervisor = new AgentHostSupervisor({
      paths,
      onUnexpectedExit: (message) => {
        dialog.showErrorBox('TransportX Traffic Agent', `${message}\n请查看 ${paths.logsDir} 中的日志。`);
        app.quit();
      },
      renderPdf,
    });
    try { createWindow(await supervisor.start()); }
    catch (error) {
      dialog.showErrorBox('TransportX Traffic Agent 启动失败', error instanceof Error ? error.message : String(error));
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
