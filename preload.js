const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icq', {
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
  close:        () => ipcRenderer.send('win-close'),
  clickContact: (i)    => ipcRenderer.send('wa-click-contact', i),
  sendMessage:  (text) => ipcRenderer.send('wa-send-message',  text),
  showWa:       ()     => ipcRenderer.send('wa-show'),
  onData:       (cb) => ipcRenderer.on('wa-data',     (e, d) => cb(d)),
  onStatus:     (cb) => ipcRenderer.on('wa-status',   (e, d) => cb(d)),
  onMessages:   (cb) => ipcRenderer.on('wa-messages', (e, d) => cb(d)),  // structured text
  onChatImg:    (cb) => ipcRenderer.on('wa-chat-img', (e, s) => cb(s)),  // screenshot fallback
});
