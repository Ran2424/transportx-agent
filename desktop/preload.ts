const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('transportxDesktop', {
  download(url: string): Promise<string> { return ipcRenderer.invoke('transportx:download', url); },
  filePath(file: File): string { return webUtils.getPathForFile(file); },
});
