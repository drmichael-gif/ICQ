/**
 * main.js — ICQ Messenger
 *
 * Architecture:
 *   waWindow  — hidden-but-rendered WhatsApp window (opacity=0, skipTaskbar)
 *   icqWindow — visible ICQ UI (app.html)
 *
 * Contacts : DOM-scraped every 2s from waWindow
 * Messages : capturePage() screenshots of waWindow's #main panel, sent as base64
 */
const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');

let icqWindow    = null;
let waWindow     = null;
let contactTimer = null;   // 2s contact scrape loop
let screenTimer  = null;   // 1.5s screenshot loop
let statusSent   = false;

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

// ── CONTACTS SCRAPER (runs inside waWindow every 2s) ──────────────────────────
const CONTACT_SCRAPER = `
(function() {
  try {
    let cells = [];
    const sels = [
      '[data-testid="cell-frame-container"]',
      '[data-testid^="cell-frame"]',
      '#side [role="listitem"]',
      '[aria-label*="Chat list"] [role="listitem"]',
    ];
    for (const s of sels) {
      const found = Array.from(document.querySelectorAll(s));
      if (found.length > 0) { cells = found; break; }
    }

    const contacts = [];
    cells.forEach((cell, i) => {
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

      contacts.push({ index: i, name,
        unread: unreadEl?.textContent?.trim() || '',
        time:   timeEl?.textContent?.trim()   || '', preview });
    });

    const chatEl = document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
                   document.querySelector('#main header span[dir="auto"]');

    const isLoggedIn = contacts.length > 0 ||
                       !!document.getElementById('side') ||
                       !!document.querySelector('[data-testid="chat-list"]') ||
                       !!document.querySelector('[aria-label*="Chat list"]');

    return { ok: true, contacts, chatName: chatEl?.textContent?.trim() || '', isLoggedIn };
  } catch(e) {
    return { ok: false, error: e.message };
  }
})()
`;

// ── Contact scrape loop ───────────────────────────────────────────────────────
async function scrapeContacts() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    const data = await waWindow.webContents.executeJavaScript(CONTACT_SCRAPER);
    if (!data?.ok) return;

    if (data.isLoggedIn && !statusSent) {
      statusSent = true;
      icqWindow.webContents.send('wa-status', { status: 'ready' });
      console.log('[ICQ] WA ready — contacts:', data.contacts.length);
    }
    icqWindow.webContents.send('wa-data', data);
  } catch (e) { console.error('[ICQ] scrapeContacts error:', e.message); }
}

function startContactLoop() {
  if (contactTimer) return;
  scrapeContacts();
  contactTimer = setInterval(scrapeContacts, 2000);
}

// ── Screenshot capture (for messages) ────────────────────────────────────────
async function captureChat() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    // Get #main bounding box for cropping to just the chat panel
    const rect = await waWindow.webContents.executeJavaScript(`
      (function(){
        const m = document.getElementById('main');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y),
                 width: Math.round(r.width), height: Math.round(r.height) };
      })()
    `);
    if (!rect || rect.width < 10 || rect.height < 10) {
      console.log('[ICQ] #main not found or too small:', rect);
      return;
    }

    const img = await waWindow.webContents.capturePage(rect);
    if (img.isEmpty()) { console.log('[ICQ] capturePage returned empty'); return; }

    // Resize for efficiency
    const resized = img.resize({ width: Math.min(rect.width, 900), quality: 'good' });
    const b64 = resized.toPNG().toString('base64');
    icqWindow.webContents.send('wa-chat-img', 'data:image/png;base64,' + b64);
  } catch (e) { console.error('[ICQ] captureChat error:', e.message); }
}

function startCapture() {
  captureChat(); // immediately
  if (screenTimer) return;
  screenTimer = setInterval(captureChat, 1500);
}

function stopCapture() {
  if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
}

// ── Hidden (but rendered) WhatsApp window ────────────────────────────────────
function createWaWindow() {
  try {
    const waSess = session.fromPartition('persist:whatsapp');
    patchSession(waSess);
  } catch (e) { console.error('[ICQ] wa session patch error:', e.message); }

  waWindow = new BrowserWindow({
    width: 1280, height: 900,
    skipTaskbar: true,   // don't show in Windows taskbar
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:whatsapp',
    },
  });

  waWindow.webContents.setUserAgent(WA_UA);
  waWindow.webContents.setBackgroundThrottling(false);

  // Make it invisible but RENDERED so virtual scroll & capturePage work
  waWindow.setOpacity(0);
  waWindow.showInactive();  // show without stealing focus

  // Force a real viewport so virtual scrolling renders items
  waWindow.webContents.enableDeviceEmulation({
    screenPosition:    'desktop',
    screenSize:        { width: 1280, height: 900 },
    viewPosition:      { x: 0, y: 0 },
    deviceScaleFactor: 1,
    viewSize:          { width: 1280, height: 900 },
    fitToView:         false,
  });

  waWindow.webContents.setUserAgent(WA_UA);
  waWindow.loadURL('https://web.whatsapp.com/', { userAgent: WA_UA });

  waWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[ICQ] WA load failed:', code, desc);
    icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
  });

  const onLoaded = () => {
    console.log('[ICQ] WA page loaded — nudging virtual scroll in 4s, scraping in 5s');
    // Nudge contact list virtual scroll
    setTimeout(() => {
      waWindow.webContents.executeJavaScript(`
        (function(){
          window.dispatchEvent(new Event('resize'));
          ['[data-testid="chat-list"]','#side','[aria-label*="Chat list"]']
            .map(s => document.querySelector(s)).filter(Boolean)
            .forEach(el => {
              el.scrollTop = 1;
              el.dispatchEvent(new Event('scroll', {bubbles:true}));
              el.scrollTop = 0;
              el.dispatchEvent(new Event('scroll', {bubbles:true}));
            });
        })()
      `).catch(() => {});
    }, 4000);
    setTimeout(startContactLoop, 5000);
    // If no contacts after 20s, show sign-in
    setTimeout(() => {
      if (!statusSent) {
        console.log('[ICQ] No contacts after 20s — prompting sign-in');
        icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
      }
    }, 20000);
  };

  let loaded = false;
  waWindow.webContents.on('did-finish-load',  () => { if (!loaded) { loaded = true; onLoaded(); } });
  waWindow.webContents.on('did-stop-loading', () => { if (!loaded) { loaded = true; onLoaded(); } });
  waWindow.on('closed', () => { waWindow = null; });
}

// ── IPC: show WA window for QR scan ──────────────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow || waWindow.isDestroyed()) return;
  waWindow.setOpacity(1);
  waWindow.show();
  waWindow.focus();
  const poll = setInterval(async () => {
    if (!waWindow || waWindow.isDestroyed()) { clearInterval(poll); return; }
    try {
      const ok = await waWindow.webContents.executeJavaScript(
        `!!(document.getElementById('side') || document.querySelector('[aria-label*="Chat list"]'))`
      );
      if (ok) {
        clearInterval(poll);
        waWindow.setOpacity(0);
        waWindow.blur();
        statusSent = false;
        startContactLoop();
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
    // Give WA time to open the chat, then start screenshotting
    setTimeout(startCapture, 1500);
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
        document.execCommand('insertText', false, ${escaped});
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

// ── ICQ visible window ────────────────────────────────────────────────────────
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
      { label: 'Show WhatsApp window', click: () => { waWindow?.setOpacity(1); waWindow?.show(); waWindow?.focus(); } },
      { label: 'Reload WhatsApp',      click: () => { statusSent = false; stopCapture(); waWindow?.webContents.reload(); } },
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
