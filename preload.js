/**
 * preload.js — bridge for app.html (ICQ UI)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icq', {
  // Window chrome
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
  close:        () => ipcRenderer.send('win-close'),

  // User actions → hidden WhatsApp
  clickContact: (index) => ipcRenderer.send('wa-click-contact', index),
  sendMessage:  (text)  => ipcRenderer.send('wa-send-message', text),

  // Data from hidden WhatsApp → ICQ UI
  onData:   (cb) => ipcRenderer.on('wa-data',   (e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('wa-status', (e, d) => cb(d)),
});
