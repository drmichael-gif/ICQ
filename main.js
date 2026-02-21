const { app, BrowserWindow, session, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;
let splashWindow;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Splash ─────────────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380, height: 520,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splashWindow.loadFile('splash.html');
  splashWindow.center();
}

// ── Main window ────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 900, minHeight: 600,
    title: 'ICQ', frame: false,
    backgroundColor: '#C0C0C0',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,          // ← enable <webview> in app.html
    },
  });

  // Remove CSP on BOTH default session AND the webview's persist:whatsapp session
  const { session: electronSession } = require('electron');
  function patchSession(sess) {
    sess.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
      delete headers['content-security-policy-report-only'];
      delete headers['Content-Security-Policy-Report-Only'];
      callback({ responseHeaders: headers });
    });
    sess.setPermissionRequestHandler((wc, permission, callback) => {
      callback(['notifications','media','mediaKeySystem','clipboard-read','clipboard-sanitized-write'].includes(permission));
    });
  }
  patchSession(session.defaultSession);
  // Patch the webview partition session once it's created
  app.on('session-created', (newSession) => patchSession(newSession));

  // Load OUR wrapper page (not WhatsApp directly)
  mainWindow.loadFile('app.html');

  // Show main window once our app.html has loaded
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow.show();
      mainWindow.focus();
    }, 800);
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[ICQ] main load failed:', code, desc);
  });

  // ── IPC: window controls (called from app.html title bar) ──
  ipcMain.on('win-minimize', () => mainWindow.minimize());
  ipcMain.on('win-maximize', () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('win-close',    () => mainWindow.close());

  // ── IPC: serve CSS/JS files to the webview (called from app.html) ──
  ipcMain.handle('get-wa-css', () =>
    fs.readFileSync(path.join(__dirname, 'icq-theme.css'), 'utf8'));
  ipcMain.handle('get-wa-js',  () =>
    fs.readFileSync(path.join(__dirname, 'inject.js'),    'utf8'));
  ipcMain.handle('get-ua',     () => USER_AGENT);

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Minimal menu
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ICQ', submenu: [
      { label: 'About ICQ', role: 'about' },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]},
    { label: 'View', submenu: [
      { label: 'Reload WhatsApp', click: () => mainWindow.webContents.executeJavaScript(
          'document.getElementById("wa-view").reload()') },
      { role: 'toggleDevTools' },
    ]},
  ]));
}

app.whenReady().then(() => {
  createSplashWindow();
  setTimeout(createMainWindow, 800);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate',          () => { if (!mainWindow) createMainWindow(); });
