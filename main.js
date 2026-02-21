/**
 * main.js — ICQ Messenger
 * waWindow (hidden) = real WhatsApp Web, untouched
 * icqWindow (visible) = our ICQ UI, fed by DOM scraping waWindow every 2s
 */
const { app, BrowserWindow, ipcMain, session, Menu, shell } = require('electron');
const path = require('path');

let icqWindow   = null;
let waWindow    = null;
let dataTimer   = null;
let statusSent  = false;  // track whether we've sent 'ready' to ICQ

const WA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── CSP patch ─────────────────────────────────────────────────────────────────
function patchSession(sess) {
  try {
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
  } catch (e) { console.error('[ICQ] patchSession error:', e.message); }
}

// ── DOM scraper (runs inside waWindow) ───────────────────────────────────────
// Tries multiple selectors because WhatsApp changes class names frequently.
const SCRAPER = `
(function() {
  try {
    // ── CONTACTS: try every known selector ──
    let cells = [];
    const cSels = [
      '[data-testid="cell-frame-container"]',
      '[data-testid^="cell-frame"]',
      '#side [role="listitem"]',
      '[data-testid="chat-list"] > div > div',
      '[aria-label*="Chat list"] [role="listitem"]',
      '[aria-label*="Chat list"] > div > div',
    ];
    for (const s of cSels) {
      const found = Array.from(document.querySelectorAll(s));
      if (found.length > 0) { cells = found; break; }
    }

    const contacts = [];
    cells.forEach((cell, i) => {
      // Name: try multiple selectors
      const nameEl =
        cell.querySelector('[data-testid="cell-frame-title"] span') ||
        cell.querySelector('[data-testid="cell-frame-title"]') ||
        cell.querySelector('span[dir="auto"]') ||
        cell.querySelector('span[title]');
      if (!nameEl) return;
      const name = (nameEl.textContent || nameEl.getAttribute('title') || '').trim();
      if (!name || name.length > 100) return;

      const unreadEl = cell.querySelector('[data-testid="icon-unread-count"]') ||
                       cell.querySelector('[aria-label*="unread"]');
      const timeEl   = cell.querySelector('[data-testid="msg-time"]') ||
                       cell.querySelector('span[class*="time"]');
      const allSpans = Array.from(cell.querySelectorAll('span[dir="auto"]'));
      const preview  = allSpans[1]?.textContent?.trim() || '';

      contacts.push({
        index:   i,
        name,
        unread:  unreadEl?.textContent?.trim() || '',
        time:    timeEl?.textContent?.trim()   || '',
        preview,
      });
    });

    // ── MESSAGES: current open chat ──
    const messages = [];
    const msgSels = [
      '.message-in, .message-out',
      '[class*="message-in"], [class*="message-out"]',
      '[data-id][role="row"]',
    ];
    let msgEls = [];
    for (const s of msgSels) {
      msgEls = Array.from(document.querySelectorAll(s));
      if (msgEls.length > 0) break;
    }
    msgEls.forEach(msg => {
      const textEl =
        msg.querySelector('span.selectable-text') ||
        msg.querySelector('[data-testid="balloon-text"] span') ||
        msg.querySelector('[data-testid="balloon-text"]') ||
        msg.querySelector('span[class*="selectable"]');
      if (!textEl) return;
      const text = textEl.textContent.trim();
      if (!text) return;
      const timeEl = msg.querySelector('[data-testid="msg-meta"]') ||
                     msg.querySelector('span[class*="timestamp"]');
      const timeStr = (timeEl?.textContent || '').match(/\\d{1,2}:\\d{2}\\s*[APap][Mm]?/)?.[0] || '';
      const isOut = msg.classList.contains('message-out') ||
                    msg.className.includes('message-out') ||
                    !!msg.querySelector('[data-testid="msg-dblcheck"]') ||
                    !!msg.querySelector('[data-testid="msg-check"]');
      messages.push({ text, time: timeStr, isOut });
    });

    // ── Current chat name ──
    const chatEl =
      document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
      document.querySelector('[data-testid="conversation-header"] span[title]') ||
      document.querySelector('#main header span[dir="auto"]');

    // ── Is logged in? ──
    const isLoggedIn =
      contacts.length > 0 ||
      !!document.getElementById('side') ||
      !!document.querySelector('[data-testid="chat-list"]') ||
      !!document.querySelector('[aria-label*="Chat list"]');

    return {
      ok:          true,
      contacts,
      messages,
      chatName:    chatEl?.textContent?.trim() || '',
      isLoggedIn,
      cellSel:     cells.length > 0 ? 'found ' + cells.length : 'none',
    };
  } catch(e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
})()
`;

// ── Periodic data loop ────────────────────────────────────────────────────────
async function extractAndSend() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    const data = await waWindow.webContents.executeJavaScript(SCRAPER);
    if (!data?.ok) {
      console.error('[ICQ] scrape error:', data?.error);
      return;
    }

    // First time we get contacts → send 'ready'
    if (data.isLoggedIn && !statusSent) {
      statusSent = true;
      icqWindow.webContents.send('wa-status', { status: 'ready' });
      console.log('[ICQ] WA logged in, contacts:', data.contacts.length, 'sel:', data.cellSel);
    }

    icqWindow.webContents.send('wa-data', data);
  } catch (e) {
    console.error('[ICQ] extractAndSend error:', e.message);
  }
}

function startDataLoop() {
  if (dataTimer) return;
  console.log('[ICQ] Data loop started');
  extractAndSend(); // immediately
  dataTimer = setInterval(extractAndSend, 2000);
}

// ── Hidden WhatsApp window ────────────────────────────────────────────────────
function createWaWindow() {
  // Patch the persist:whatsapp session BEFORE creating the window
  try {
    const waSess = session.fromPartition('persist:whatsapp');
    patchSession(waSess);
  } catch (e) { console.error('[ICQ] wa session patch error:', e.message); }

  waWindow = new BrowserWindow({
    width: 1280, height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:whatsapp',
    },
  });

  waWindow.webContents.setUserAgent(WA_UA);
  waWindow.loadURL('https://web.whatsapp.com/', { userAgent: WA_UA });

  // Log any load errors
  waWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[ICQ] WA load failed:', code, desc, url);
    icqWindow?.webContents.send('wa-status', {
      status: 'needsLogin',
      msg: `WhatsApp failed to load (${code}). Click "Sign in" to retry.`,
    });
  });

  // Start data loop 5s after WA finishes loading (give React time to mount)
  const startAfterLoad = () => {
    console.log('[ICQ] WA page loaded — starting scrape in 5s');
    setTimeout(startDataLoop, 5000);

    // After 20s, if still not logged in, tell ICQ to show sign-in button
    setTimeout(() => {
      if (!statusSent) {
        console.log('[ICQ] No contacts after 20s — prompting sign-in');
        icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
      }
    }, 20000);
  };

  waWindow.webContents.on('did-finish-load', startAfterLoad);

  // Fallback: also start on did-stop-loading in case did-finish-load doesn't fire
  let loopStarted = false;
  waWindow.webContents.on('did-stop-loading', () => {
    if (!loopStarted) { loopStarted = true; startAfterLoad(); }
  });

  waWindow.on('closed', () => { waWindow = null; });
}

// ── IPC: show WA window for QR scan ──────────────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow || waWindow.isDestroyed()) return;
  waWindow.show();
  waWindow.focus();
  // Poll for login every 3s, hide once confirmed
  const poll = setInterval(async () => {
    if (!waWindow || waWindow.isDestroyed()) { clearInterval(poll); return; }
    try {
      const ok = await waWindow.webContents.executeJavaScript(
        `!!(document.getElementById('side') || document.querySelectorAll('[data-testid^="cell-frame"]').length > 0 || document.querySelector('[aria-label*="Chat list"]'))`
      );
      if (ok) {
        clearInterval(poll);
        waWindow.hide();
        statusSent = false; // allow ready to be sent again
        if (!dataTimer) startDataLoop();
      }
    } catch (_) {}
  }, 3000);
});

// ── IPC: click a contact ──────────────────────────────────────────────────────
ipcMain.on('wa-click-contact', async (e, index) => {
  if (!waWindow || waWindow.isDestroyed()) return;
  const i = index | 0;
  try {
    await waWindow.webContents.executeJavaScript(`
      (function(){
        const sels = [
          '[data-testid="cell-frame-container"]',
          '[data-testid^="cell-frame"]',
          '#side [role="listitem"]',
          '[aria-label*="Chat list"] [role="listitem"]',
        ];
        let cells = [];
        for (const s of sels) {
          cells = Array.from(document.querySelectorAll(s));
          if (cells.length > 0) break;
        }
        if (cells[${i}]) cells[${i}].click();
      })()
    `);
  } catch (err) { console.error('[ICQ] click error:', err.message); }
});

// ── IPC: send a message ───────────────────────────────────────────────────────
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
        if (!input) { console.log('[ICQ] compose input not found'); return; }
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete',    false, null);
        document.execCommand('insertText',false, ${escaped});
        setTimeout(() => {
          const btn =
            document.querySelector('[data-testid="send"]') ||
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
    title: 'ICQ', frame: false,
    backgroundColor: '#C0C0C0', show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  icqWindow.loadFile('app.html');
  icqWindow.on('closed', () => { icqWindow = null; app.quit(); });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ICQ', submenu: [
      { label: 'Show WhatsApp window', click: () => { waWindow?.show(); waWindow?.focus(); } },
      { label: 'Reload WhatsApp',      click: () => { statusSent = false; waWindow?.webContents.reload(); } },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]},
    { label: 'View', submenu: [
      { label: 'ICQ DevTools',      click: () => icqWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'WhatsApp DevTools', click: () => waWindow?.webContents.openDevTools({ mode: 'detach' }) },
    ]},
  ]));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  patchSession(session.defaultSession);
  app.on('session-created', patchSession);

  createIcqWindow();
  createWaWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!icqWindow) createIcqWindow(); });
