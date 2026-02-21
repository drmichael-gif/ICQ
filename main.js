/**
 * main.js — ICQ Messenger
 *
 * waWindow: visible, off-screen (right of display) — full rendering, clicks work
 * icqWindow: always-on-top — ICQ UI
 *
 * Contacts: DOM-scraped every 2s
 * Messages: capturePage() screenshot → parse [data-pre-plain-text] attrs for text
 *           Falls back to showing raw screenshot if text extraction fails.
 */
const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');
const path = require('path');

let icqWindow    = null;
let waWindow     = null;
let contactTimer = null;
let screenTimer  = null;
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

// ── Contact scraper ───────────────────────────────────────────────────────────
const CONTACT_SCRAPER = `
(function() {
  try {
    let cells = [];
    const sels = [
      '[data-testid="cell-frame-container"]',
      '[data-testid^="cell-frame"]',
      '[data-testid="chat-list-item"]',
      '#side [role="listitem"]',
      '#pane-side [role="listitem"]',
      '[aria-label*="Chat list"] [role="listitem"]',
      '[aria-label*="Chat list"] > div > div',
    ];
    for (const s of sels) {
      try {
        const found = Array.from(document.querySelectorAll(s));
        if (found.length > 0) { cells = found; break; }
      } catch(_) {}
    }
    if (!cells.length) {
      const side = document.getElementById('side') ||
                   document.querySelector('[aria-label*="Chat list"]');
      if (side) {
        cells = Array.from(side.querySelectorAll('[tabindex="-1"],[tabindex="0"]'))
          .filter(el => el.querySelector('span[dir="auto"], [title]') && el.offsetHeight > 20);
      }
    }
    const contacts = [];
    cells.forEach((cell, i) => {
      const nameEl =
        cell.querySelector('[data-testid="cell-frame-title"] span') ||
        cell.querySelector('[data-testid="cell-frame-title"]') ||
        cell.querySelector('span[dir="auto"]') ||
        cell.querySelector('[title]');
      if (!nameEl) return;
      const name = (nameEl.textContent || nameEl.getAttribute('title') || '').trim();
      if (!name || name.length > 100 || name.length < 1) return;
      const unreadEl = cell.querySelector('[data-testid="icon-unread-count"]') ||
                       cell.querySelector('[aria-label*="unread"]');
      const timeEl   = cell.querySelector('[data-testid="msg-time"]');
      contacts.push({
        index: i, name,
        unread: unreadEl?.textContent?.trim() || '',
        time:   timeEl?.textContent?.trim()   || '',
      });
    });
    const chatEl =
      document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
      document.querySelector('#main header span[dir="auto"]');
    const isLoggedIn =
      contacts.length > 0 ||
      !!document.getElementById('side') ||
      !!document.querySelector('[data-testid="chat-list"]') ||
      !!document.querySelector('[aria-label*="Chat list"]');
    return { ok: true, contacts, chatName: chatEl?.textContent?.trim() || '', isLoggedIn };
  } catch(e) { return { ok: false, error: e.message }; }
})()
`;

// ── Message text extractor (uses data-pre-plain-text + selectable spans) ──────
const MESSAGE_EXTRACTOR = `
(function() {
  try {
    // data-pre-plain-text is a WA attribute like "[10:30 AM, 1/15/2024] Mike: "
    // It appears on message bubble wrapper divs
    const bubbles = Array.from(document.querySelectorAll('[data-pre-plain-text]'));
    if (bubbles.length > 0) {
      const messages = bubbles.map((el, idx) => {
        const pre  = el.getAttribute('data-pre-plain-text') || '';
        // Parse: "[HH:MM AM, D/M/YYYY] Sender: "  or  "[HH:MM AM, D/M/YYYY] You: "
        const m    = pre.match(/\\[([^\\]]+)\\]\\s*(.*?):\\s*$/);
        const time   = m ? m[1].split(',')[0].trim() : '';
        const sender = m ? m[2].trim() : '';
        // Get text content
        const textEl = el.querySelector('span.selectable-text') ||
                       el.querySelector('[data-testid="msg-text"]') ||
                       el.querySelector('span[dir="ltr"], span[dir="rtl"]');
        const text = (textEl?.innerText || textEl?.textContent || '').trim();
        // Outgoing if sender is empty or "You" or has delivery icon
        const isOut = sender === '' || sender === 'You' ||
                      !!el.querySelector('[data-testid="msg-dbl-check"],[data-testid="msg-check"],[data-icon="msg-dbl-check"]');
        const id = idx + ':' + pre.slice(0,30) + text.slice(0,10);
        return { id, text: text || '📎 Media', sender: isOut ? '' : sender, time, isOut };
      }).filter(m => m.text);
      return { ok: true, method: 'pre-plain-text', messages };
    }

    // Fallback: selectable-text spans in #main area
    const main = document.getElementById('main') ||
                 document.querySelector('[data-testid="conversation-panel"]');
    if (!main) return { ok: false, error: 'no main' };

    const spans = Array.from(main.querySelectorAll('span.selectable-text.copyable-text'));
    if (spans.length > 0) {
      const messages = spans.map((el, idx) => {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) return null;
        const row = el.closest('[data-id]') || el.closest('[role="row"]');
        const isOut = !!(row?.querySelector('[data-testid="msg-dbl-check"],[data-icon="msg-dbl-check"]'));
        const timeEl = row?.querySelector('[data-testid="msg-time"]');
        return { id: idx + ':' + text.slice(0,20), text, sender: '', time: timeEl?.textContent?.trim()||'', isOut };
      }).filter(Boolean);
      if (messages.length) return { ok: true, method: 'selectable-text', messages };
    }

    return { ok: false, error: 'no messages found' };
  } catch(e) { return { ok: false, error: e.message }; }
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

// ── Screenshot + text extraction ──────────────────────────────────────────────
async function captureAndExtract() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    // 1. Try to extract structured message text first
    const extracted = await waWindow.webContents.executeJavaScript(MESSAGE_EXTRACTOR);
    if (extracted?.ok && extracted.messages?.length > 0) {
      console.log('[ICQ] text extracted via', extracted.method, '—', extracted.messages.length, 'messages');
      icqWindow.webContents.send('wa-messages', extracted.messages);
      return; // no screenshot needed
    }

    // 2. Fallback: capturePage screenshot of #main panel
    const rect = await waWindow.webContents.executeJavaScript(`
      (function(){
        const m = document.getElementById('main') ||
                  document.querySelector('[data-testid="conversation-panel"]');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { x: Math.round(r.x), y: Math.round(r.y),
                 width: Math.round(r.width), height: Math.round(r.height) };
      })()`);

    let img;
    if (rect) {
      img = await waWindow.webContents.capturePage(rect);
    } else {
      console.log('[ICQ] #main not found — capturing full window');
      img = await waWindow.webContents.capturePage();
    }
    if (!img || img.isEmpty()) { console.log('[ICQ] empty screenshot'); return; }

    const sz      = img.getSize();
    const resized = img.resize({ width: Math.min(sz.width, 900), quality: 'good' });
    const b64     = resized.toPNG().toString('base64');
    icqWindow.webContents.send('wa-chat-img', 'data:image/png;base64,' + b64);
  } catch (e) { console.error('[ICQ] captureAndExtract error:', e.message); }
}

function startCaptureLoop() {
  captureAndExtract();
  if (screenTimer) return;
  screenTimer = setInterval(captureAndExtract, 2000);
}

function stopCaptureLoop() {
  if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
}

// ── Off-screen position ───────────────────────────────────────────────────────
function getOffscreenPos() {
  try {
    const d = screen.getPrimaryDisplay();
    return { x: d.bounds.x + d.bounds.width + 50, y: d.bounds.y };
  } catch (_) { return { x: 1500, y: 0 }; }
}

// ── WhatsApp window — visible but off-screen ──────────────────────────────────
function createWaWindow() {
  try {
    const waSess = session.fromPartition('persist:whatsapp');
    patchSession(waSess);
  } catch (e) { console.error('[ICQ] wa session patch error:', e.message); }

  const pos = getOffscreenPos();
  waWindow = new BrowserWindow({
    width: 1280, height: 900,
    x: pos.x, y: pos.y,
    show: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation:     false,
      nodeIntegration:      false,
      partition:            'persist:whatsapp',
      backgroundThrottling: false,
    },
  });

  waWindow.webContents.setUserAgent(WA_UA);
  waWindow.loadURL('https://web.whatsapp.com/', { userAgent: WA_UA });

  waWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[ICQ] WA load failed:', code, desc);
    icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
  });

  let loaded = false;
  const onLoaded = () => {
    if (loaded) return;
    loaded = true;
    console.log('[ICQ] WA loaded');

    setTimeout(async () => {
      try {
        await waWindow.webContents.executeJavaScript(`
          (function(){
            window.dispatchEvent(new Event('resize'));
            ['[data-testid="chat-list"]','#side','[aria-label*="Chat list"]']
              .map(s => document.querySelector(s)).filter(Boolean)
              .forEach(el => {
                el.scrollTop = 1;
                el.dispatchEvent(new Event('scroll',{bubbles:true}));
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll',{bubbles:true}));
              });
          })()`);
      } catch(e) {}
    }, 4000);

    setTimeout(startContactLoop, 5000);
    setTimeout(() => {
      if (!statusSent) icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
    }, 30000);
  };

  waWindow.webContents.on('did-finish-load',  onLoaded);
  waWindow.webContents.on('did-stop-loading', onLoaded);
  waWindow.on('closed', () => { waWindow = null; });
}

// ── IPC: show WA for QR sign-in ───────────────────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow || waWindow.isDestroyed()) return;
  try {
    const d = screen.getPrimaryDisplay();
    waWindow.setPosition(
      d.bounds.x + Math.floor((d.bounds.width  - 1280) / 2),
      d.bounds.y + Math.floor((d.bounds.height - 900)  / 2)
    );
  } catch (_) { waWindow.center(); }
  waWindow.focus();

  const poll = setInterval(async () => {
    if (!waWindow || waWindow.isDestroyed()) { clearInterval(poll); return; }
    try {
      const ok = await waWindow.webContents.executeJavaScript(
        `!!(document.getElementById('side') || document.querySelector('[aria-label*="Chat list"]'))`
      );
      if (ok) {
        clearInterval(poll);
        const pos = getOffscreenPos();
        waWindow.setPosition(pos.x, pos.y);
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
  stopCaptureLoop();
  try {
    // JS element.click() works for opening chats (React handles it via event bubbling)
    const result = await waWindow.webContents.executeJavaScript(`
      (function(){
        const sels = [
          '[data-testid="cell-frame-container"]',
          '[data-testid^="cell-frame"]',
          '[data-testid="chat-list-item"]',
          '#side [role="listitem"]',
          '[aria-label*="Chat list"] [role="listitem"]',
        ];
        let cells = [];
        for (const s of sels) {
          cells = Array.from(document.querySelectorAll(s));
          if (cells.length > 0) break;
        }
        const cell = cells[${i}];
        if (!cell) return { ok: false, total: cells.length };
        cell.click();
        return { ok: true, name: cell.textContent?.slice(0,40)||'', total: cells.length };
      })()`);
    console.log('[ICQ] click contact', i, JSON.stringify(result));

    // Wait for WA to open the chat, then start capture+extraction loop
    setTimeout(startCaptureLoop, 1500);
  } catch (err) { console.error('[ICQ] click error:', err.message); }
});

// ── IPC: send message ─────────────────────────────────────────────────────────
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
        if (!input) return;
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete',    false, null);
        document.execCommand('insertText', false, ${escaped});
        setTimeout(() => {
          const btn = document.querySelector('[data-testid="send"]') ||
                      document.querySelector('button[aria-label="Send"]');
          if (btn) btn.click();
        }, 120);
      })()`);
  } catch (err) { console.error('[ICQ] send error:', err.message); }
});

// ── IPC: window chrome ────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => icqWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (!icqWindow) return;
  icqWindow.isMaximized() ? icqWindow.unmaximize() : icqWindow.maximize();
});
ipcMain.on('win-close', () => app.quit());

// ── ICQ window ────────────────────────────────────────────────────────────────
function createIcqWindow() {
  icqWindow = new BrowserWindow({
    width: 1100, height: 780,
    minWidth: 800, minHeight: 580,
    title: 'ICQ', frame: false,
    alwaysOnTop: true,
    backgroundColor: '#C0C0C0', show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  icqWindow.loadFile('app.html');
  icqWindow.on('closed', () => { icqWindow = null; app.quit(); });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ICQ', submenu: [
      { label: 'Show WhatsApp window', click: () => {
        const d = screen.getPrimaryDisplay();
        waWindow?.setPosition(
          d.bounds.x + Math.floor((d.bounds.width  - 1280) / 2),
          d.bounds.y + Math.floor((d.bounds.height - 900)  / 2)
        );
        waWindow?.focus();
      }},
      { label: 'Send WA off-screen', click: () => {
        const pos = getOffscreenPos();
        waWindow?.setPosition(pos.x, pos.y);
      }},
      { label: 'Reload WhatsApp', click: () => {
        statusSent = false;
        if (contactTimer) { clearInterval(contactTimer); contactTimer = null; }
        waWindow?.webContents.reload();
      }},
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
