const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('transportxDesktop', {
  download(url: string): Promise<string> { return ipcRenderer.invoke('transportx:download', url); },
});
