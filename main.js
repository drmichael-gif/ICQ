/**
 * main.js — ICQ Messenger
 *
 * Architecture:
 *   waWindow  — hidden BrowserWindow running WhatsApp Web normally
 *   icqWindow — visible ICQ UI (app.html) fed by DOM scraping waWindow
 *
 * Every 2 seconds we executeJavaScript in waWindow to pull contact
 * names + messages, then relay to icqWindow via IPC.
 * User actions (click contact, send message) go the other way.
 */

const { app, BrowserWindow, ipcMain, session, Menu, shell } = require('electron');
const path = require('path');

let icqWindow = null;
let waWindow  = null;
let dataTimer = null;

const WA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Remove CSP headers so WA doesn't block anything ──────────────────────────
function patchSession(sess) {
  sess.webRequest.onHeadersReceived((details, callback) => {
    const h = { ...details.responseHeaders };
    delete h['content-security-policy'];
    delete h['Content-Security-Policy'];
    delete h['content-security-policy-report-only'];
    delete h['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: h });
  });
  sess.setPermissionRequestHandler((wc, perm, cb) =>
    cb(['notifications','media','mediaKeySystem','clipboard-read','clipboard-sanitized-write'].includes(perm))
  );
}

// ── Hidden WhatsApp window ────────────────────────────────────────────────────
function createWaWindow() {
  waWindow = new BrowserWindow({
    width: 1280, height: 900,
    show: false,   // ← stays hidden; WA runs normally in background
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:whatsapp',  // session persists across launches
    },
  });

  waWindow.webContents.setUserAgent(WA_UA);
  waWindow.loadURL('https://web.whatsapp.com/', { userAgent: WA_UA });

  // When WA finishes loading, check if user is logged in
  waWindow.webContents.on('did-finish-load', () => {
    setTimeout(checkLoginAndStart, 3000); // give WA React time to mount
  });

  // Forward console logs from WA window (useful for debug)
  waWindow.webContents.on('console-message', (e, level, msg) => {
    if (msg.startsWith('[ICQ]')) console.log('[WA]', msg);
  });

  waWindow.on('closed', () => { waWindow = null; });
}

// ── Check login state; show WA window if QR needed ───────────────────────────
async function checkLoginAndStart() {
  if (!waWindow || waWindow.isDestroyed()) return;
  try {
    const loggedIn = await waWindow.webContents.executeJavaScript(`
      !!(document.getElementById('side') ||
         document.querySelector('[data-testid="chat-list"]') ||
         document.querySelector('[data-testid^="cell-frame"]'))
    `);

    if (loggedIn) {
      console.log('[ICQ] WA logged in — starting data loop');
      icqWindow?.webContents.send('wa-status', { status: 'ready' });
      startDataLoop();
    } else {
      console.log('[ICQ] WA not logged in — showing WA window for QR scan');
      waWindow.show();
      icqWindow?.webContents.send('wa-status', {
        status: 'qr',
        msg: 'Scan the QR code in the WhatsApp window to sign in.',
      });
      // Re-check every 4 seconds until logged in
      const pollLogin = setInterval(async () => {
        if (!waWindow || waWindow.isDestroyed()) { clearInterval(pollLogin); return; }
        try {
          const in2 = await waWindow.webContents.executeJavaScript(
            `!!(document.getElementById('side') || document.querySelector('[data-testid^="cell-frame"]'))`
          );
          if (in2) {
            clearInterval(pollLogin);
            waWindow.hide();
            icqWindow?.webContents.send('wa-status', { status: 'ready' });
            startDataLoop();
          }
        } catch (_) {}
      }, 4000);
    }
  } catch (e) {
    console.error('[ICQ] checkLogin error:', e.message);
    setTimeout(checkLoginAndStart, 5000);
  }
}

// ── DOM scraper — runs inside hidden WA window ────────────────────────────────
const SCRAPER = `
(function() {
  try {
    // ── CONTACTS ──
    const contacts = [];
    const cells = document.querySelectorAll('[data-testid^="cell-frame"]');
    cells.forEach((cell, i) => {
      const spans = cell.querySelectorAll('span[dir="auto"]');
      const name = spans[0]?.textContent?.trim();
      if (!name) return;
      const unreadEl = cell.querySelector('[data-testid="icon-unread-count"]');
      const timeEl   = cell.querySelector('[data-testid="msg-time"]');
      const prevEl   = spans[1];
      contacts.push({
        index:   i,
        name:    name,
        unread:  unreadEl?.textContent?.trim() || '',
        time:    timeEl?.textContent?.trim()   || '',
        preview: prevEl?.textContent?.trim()   || '',
      });
    });

    // ── CURRENT CHAT MESSAGES ──
    const messages = [];
    document.querySelectorAll('.message-in, .message-out, [class*="message-in"], [class*="message-out"]')
      .forEach(msg => {
        const textEl = msg.querySelector('span.selectable-text') ||
                       msg.querySelector('[data-testid="balloon-text"]');
        if (!textEl) return;
        const timeEl = msg.querySelector('[data-testid="msg-meta"]');
        const timeStr = (timeEl?.textContent || '').match(/\\d{1,2}:\\d{2}\\s*[APap][Mm]?/)?.[0] || '';
        const isOut = msg.classList.contains('message-out') || msg.className.includes('message-out');
        messages.push({ text: textEl.textContent.trim(), time: timeStr, isOut });
      });

    // ── CURRENT CHAT NAME ──
    const chatNameEl =
      document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
      document.querySelector('[data-testid="conversation-header"] span[title]');

    return {
      ok: true,
      contacts,
      messages,
      chatName: chatNameEl?.textContent?.trim() || '',
    };
  } catch(e) {
    return { ok: false, error: e.message };
  }
})()
`;

// ── Periodic data loop ────────────────────────────────────────────────────────
function startDataLoop() {
  if (dataTimer) clearInterval(dataTimer);
  dataTimer = setInterval(async () => {
    if (!waWindow || waWindow.isDestroyed()) return;
    if (!icqWindow || icqWindow.isDestroyed()) return;
    try {
      const data = await waWindow.webContents.executeJavaScript(SCRAPER);
      if (data?.ok) {
        icqWindow.webContents.send('wa-data', data);
      }
    } catch (e) {
      console.error('[ICQ] scrape error:', e.message);
    }
  }, 2000);
}

// ── IPC: user clicked a contact in ICQ UI ────────────────────────────────────
ipcMain.on('wa-click-contact', async (e, index) => {
  if (!waWindow || waWindow.isDestroyed()) return;
  try {
    await waWindow.webContents.executeJavaScript(`
      (function(){
        const cells = document.querySelectorAll('[data-testid^="cell-frame"]');
        if (cells[${index|0}]) cells[${index|0}].click();
      })()
    `);
  } catch (err) { console.error('[ICQ] click contact error:', err.message); }
});

// ── IPC: user sent a message from ICQ UI ─────────────────────────────────────
ipcMain.on('wa-send-message', async (e, text) => {
  if (!waWindow || waWindow.isDestroyed() || !text) return;
  const escaped = JSON.stringify(String(text));
  try {
    await waWindow.webContents.executeJavaScript(`
      (function(){
        const input =
          document.querySelector('[data-testid="compose-box-input"] [contenteditable="true"]') ||
          document.querySelector('footer [role="textbox"][contenteditable="true"]') ||
          document.querySelector('[role="textbox"][contenteditable="true"]');
        if (!input) { console.log('[ICQ] no compose input found'); return; }
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete',    false, null);
        document.execCommand('insertText',false, ${escaped});
        setTimeout(() => {
          const btn = document.querySelector('[data-testid="send"]') ||
                      document.querySelector('button[aria-label="Send"]') ||
                      document.querySelector('[data-icon="send"]');
          if (btn) btn.click();
        }, 120);
      })()
    `);
  } catch (err) { console.error('[ICQ] send error:', err.message); }
});

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => icqWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (!icqWindow) return;
  icqWindow.isMaximized() ? icqWindow.unmaximize() : icqWindow.maximize();
});
ipcMain.on('win-close', () => app.quit());

// ── ICQ (visible) window ──────────────────────────────────────────────────────
function createIcqWindow() {
  icqWindow = new BrowserWindow({
    width: 1100, height: 780,
    minWidth: 800, minHeight: 580,
    title: 'ICQ',
    frame: false,
    backgroundColor: '#C0C0C0',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  icqWindow.loadFile('app.html');
  icqWindow.on('closed', () => { icqWindow = null; app.quit(); });

  const menu = Menu.buildFromTemplate([
    { label: 'ICQ', submenu: [
      { label: 'Show WhatsApp window', click: () => waWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]},
    { label: 'View', submenu: [
      { label: 'ICQ DevTools',       click: () => icqWindow?.webContents.openDevTools() },
      { label: 'WhatsApp DevTools',  click: () => waWindow?.webContents.openDevTools() },
    ]},
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  patchSession(session.defaultSession);
  app.on('session-created', patchSession);

  createIcqWindow(); // show ICQ UI immediately
  createWaWindow();  // WhatsApp starts loading in background
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!icqWindow) createIcqWindow(); });
