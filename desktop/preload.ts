const { contextBridge, ipcRenderer, webUtils } = require('electron');
import type { DesktopUpdateState } from '../src/contracts/desktop-update.js';

contextBridge.exposeInMainWorld('transportxDesktop', {
  update: {
    getState() { return ipcRenderer.invoke('transportx:update:getState'); },
    check() { return ipcRenderer.invoke('transportx:update:check'); },
    download() { return ipcRenderer.invoke('transportx:update:download'); },
    install() { return ipcRenderer.invoke('transportx:update:install'); },
    subscribe(listener: (state: DesktopUpdateState) => void) {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
      ipcRenderer.on('transportx:update:state', handler);
      return () => ipcRenderer.removeListener('transportx:update:state', handler);
    },
  },
  download(url: string): Promise<string> { return ipcRenderer.invoke('transportx:download', url); },
  filePath(file: File): string { return webUtils.getPathForFile(file); },
  // Window controls used by the frameless Win/Linux chrome. macOS already
  // exposes its own traffic-lights, so the renderer only mounts these on
  // data-desktop-platform=win32|linux.
  window: {
    minimize(): Promise<void> { return ipcRenderer.invoke('transportx:window:minimize'); },
    toggleMaximize(): Promise<void> { return ipcRenderer.invoke('transportx:window:toggle-maximize'); },
    isMaximized(): Promise<boolean> { return ipcRenderer.invoke('transportx:window:is-maximized'); },
    close(): Promise<void> { return ipcRenderer.invoke('transportx:window:close'); },
  },
});
