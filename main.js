const { app, BrowserWindow, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let splashWindow;

// WhatsApp Web user agent
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 520,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  splashWindow.loadFile('splash.html');
  splashWindow.center();
}

function getCSS() {
  return fs.readFileSync(path.join(__dirname, 'icq-theme.css'), 'utf8');
}

function getJS() {
  return fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ICQ',
    icon: path.join(__dirname, 'assets', 'icq-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    show: false,
    frame: false,
    backgroundColor: '#C0C0C0',
  });

  mainWindow.webContents.setUserAgent(USER_AGENT);

  // Remove Content-Security-Policy headers that block injection
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: headers });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['notifications', 'media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  mainWindow.loadURL('https://web.whatsapp.com/', { userAgent: USER_AGENT });

  let cssKey = null;
  let jsInjected = false;

  async function injectCSS() {
    try {
      // Remove old CSS first
      if (cssKey) {
        try { await mainWindow.webContents.removeInsertedCSS(cssKey); } catch (e) {}
      }
      // Insert with 'user' origin = highest CSS priority (beats !important from page)
      cssKey = await mainWindow.webContents.insertCSS(getCSS(), { cssOrigin: 'user' });
      console.log('[ICQ] CSS injected OK');
    } catch (e) {
      console.error('[ICQ] CSS inject error:', e.message);
    }
  }

  async function injectJS() {
    if (jsInjected) return;
    try {
      await mainWindow.webContents.executeJavaScript(getJS());
      jsInjected = true;
      console.log('[ICQ] JS injected OK');
    } catch (e) {
      console.error('[ICQ] JS inject error:', e.message);
      jsInjected = false;
    }
  }

  // Inject on initial page load
  mainWindow.webContents.on('dom-ready', () => {
    console.log('[ICQ] dom-ready');
    injectCSS();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[ICQ] did-finish-load');
    injectCSS();
    injectJS();
  });

  // Re-inject when SPA navigates
  mainWindow.webContents.on('did-navigate-in-page', () => {
    console.log('[ICQ] did-navigate-in-page');
    injectCSS();
    if (!jsInjected) injectJS();
  });

  // Also re-inject when frames load (WhatsApp uses service workers etc.)
  mainWindow.webContents.on('did-frame-finish-load', (event, isMainFrame) => {
    if (isMainFrame) {
      console.log('[ICQ] did-frame-finish-load (main)');
      injectCSS();
      injectJS();
    }
  });

  // Periodic re-injection as a safety net — WhatsApp dynamically loads styles
  let reinjCounter = 0;
  const reinjInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      injectCSS();
      if (!jsInjected) injectJS();
      reinjCounter++;
      // Keep re-injecting CSS for 2 min, then every 10s after
      if (reinjCounter > 24) { // after 2 min at 5s intervals
        clearInterval(reinjInterval);
        // Switch to slower interval
        setInterval(() => {
          if (mainWindow && !mainWindow.isDestroyed()) injectCSS();
        }, 10000);
      }
    }
  }, 5000);

  mainWindow.webContents.on('did-stop-loading', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow.show();
      mainWindow.focus();
    }, 2000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  const menu = Menu.buildFromTemplate([
    {
      label: 'ICQ',
      submenu: [
        { label: 'About ICQ', role: 'about' },
        { type: 'separator' },
        { label: 'Quit ICQ', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createSplashWindow();
  setTimeout(() => { createMainWindow(); }, 800);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
});
