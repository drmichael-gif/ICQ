/**
 * preload.js — runs in the main BrowserWindow (app.html)
 * Exposes IPC bridges via contextBridge (contextIsolation: true)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icqBridge', {
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // Get the WhatsApp CSS/JS from main process (reads files fresh each time)
  getWaCss: () => ipcRenderer.invoke('get-wa-css'),
  getWaJs:  () => ipcRenderer.invoke('get-wa-js'),
});
