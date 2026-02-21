const { contextBridge, ipcRenderer } = require('electron');

// Expose minimal API to renderer
contextBridge.exposeInMainWorld('icqBridge', {
  platform: process.platform,
});

// Play ICQ notification sound when WhatsApp notifications fire
window.addEventListener('DOMContentLoaded', () => {
  // Watch for new message indicators
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Check for unread badge changes in the title
      if (document.title.match(/\(\d+\)/)) {
        // Title changed to show unread count — ICQ "uh oh" moment
        document.title = document.title.replace('WhatsApp', 'ICQ');
      }
    }
  });

  // Observe title changes
  const titleEl = document.querySelector('title');
  if (titleEl) {
    observer.observe(titleEl, { childList: true, subtree: true, characterData: true });
  }

  // Also observe the whole document for title element creation
  const headObserver = new MutationObserver(() => {
    const title = document.querySelector('title');
    if (title) {
      observer.observe(title, { childList: true, subtree: true, characterData: true });
      headObserver.disconnect();
    }
  });
  headObserver.observe(document.head || document.documentElement, { childList: true, subtree: true });
});
