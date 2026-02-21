/**
 * main.js — ICQ Messenger
 *
 * KEY ARCHITECTURE:
 * - icqWindow: alwaysOnTop, visible, centered on screen
 * - waWindow:  same position as icqWindow, hidden UNDER icqWindow
 *   → on-screen → macOS compositor renders it → capturePage() works
 *   → sendInputEvent works (macOS routes input to on-screen windows)
 *   → DOM fully rendered → executeJavaScript finds all elements
 *
 * WHY NOT OFF-SCREEN: macOS GPU compositor skips windows outside display
 * bounds → capturePage() returns empty → input events are dropped.
 */
const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');
const path = require('path');

let icqWindow    = null;
let waWindow     = null;
let contactTimer = null;
let captureTimer = null;
let statusSent   = false;

const WA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ICQ_W = 1100, ICQ_H = 780;
const WA_W  = 1100, WA_H  = 780;

// ── Session patch (CSP removal) ───────────────────────────────────────────────
function patchSession(sess) {
  try {
    sess.webRequest.onHeadersReceived((details, cb) => {
      const h = { ...details.responseHeaders };
      ['content-security-policy','Content-Security-Policy',
       'content-security-policy-report-only','Content-Security-Policy-Report-Only']
        .forEach(k => delete h[k]);
      cb({ responseHeaders: h });
    });
    sess.setPermissionRequestHandler((wc, perm, cb) =>
      cb(['notifications','media','mediaKeySystem','clipboard-read','clipboard-sanitized-write'].includes(perm))
    );
  } catch (e) { console.error('[ICQ] patchSession:', e.message); }
}

// ── Screen center ─────────────────────────────────────────────────────────────
function getCenter() {
  try {
    const d = screen.getPrimaryDisplay();
    return {
      x: d.bounds.x + Math.floor((d.bounds.width  - ICQ_W) / 2),
      y: d.bounds.y + Math.floor((d.bounds.height - ICQ_H) / 2),
    };
  } catch (_) { return { x: 100, y: 100 }; }
}

// ── Contact scraper ───────────────────────────────────────────────────────────
const CONTACT_SCRAPER = `(function(){
  try {
    let cells = [];
    const sels = [
      '[data-testid="cell-frame-container"]',
      '[data-testid^="cell-frame"]',
      '[data-testid="chat-list-item"]',
      '#side [role="listitem"]',
      '[aria-label*="Chat list"] [role="listitem"]',
    ];
    for (const s of sels) {
      const f = Array.from(document.querySelectorAll(s));
      if (f.length) { cells = f; break; }
    }
    if (!cells.length) {
      const side = document.getElementById('side');
      if (side) cells = Array.from(side.querySelectorAll('[tabindex="-1"],[tabindex="0"]'))
                          .filter(el => el.querySelector('span[dir="auto"]') && el.offsetHeight > 20);
    }
    const contacts = [];
    cells.forEach((cell, i) => {
      const nameEl = cell.querySelector('[data-testid="cell-frame-title"] span')
                  || cell.querySelector('span[dir="auto"]')
                  || cell.querySelector('[title]');
      const name = (nameEl?.textContent || nameEl?.getAttribute('title') || '').trim();
      if (!name || name.length > 100) return;
      const unread = cell.querySelector('[data-testid="icon-unread-count"]')?.textContent?.trim() || '';
      contacts.push({ index: i, name, unread });
    });
    const isLoggedIn = !!document.getElementById('side') || contacts.length > 0;
    return { ok: true, contacts, isLoggedIn };
  } catch(e) { return { ok: false, error: e.message }; }
})()`;

async function scrapeContacts() {
  if (!waWindow?.webContents || !icqWindow?.webContents) return;
  try {
    const d = await waWindow.webContents.executeJavaScript(CONTACT_SCRAPER);
    if (!d?.ok) return;
    if (d.isLoggedIn && !statusSent) {
      statusSent = true;
      icqWindow.webContents.send('wa-status', { status: 'ready' });
      console.log('[ICQ] WA ready, contacts:', d.contacts.length);
    }
    icqWindow.webContents.send('wa-data', d);
  } catch (e) { console.error('[ICQ] scrapeContacts:', e.message); }
}

function startContactLoop() {
  if (contactTimer) return;
  scrapeContacts();
  contactTimer = setInterval(scrapeContacts, 2000);
}

// ── Step 1: Take screenshot of WA chat panel ──────────────────────────────────
async function takeScreenshot() {
  if (!waWindow?.webContents) return null;
  try {
    // Try to capture just #main (the chat panel)
    const info = await waWindow.webContents.executeJavaScript(`(function(){
      const m = document.getElementById('main')
             || document.querySelector('[data-testid="conversation-panel"]');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return r.width > 10 ? { x:Math.round(r.x), y:Math.round(r.y), width:Math.round(r.width), height:Math.round(r.height) } : null;
    })()`);

    let img;
    if (info) {
      img = await waWindow.webContents.capturePage(info);
      console.log('[ICQ] screenshot: #main rect', JSON.stringify(info), 'size:', img?.getSize());
    } else {
      img = await waWindow.webContents.capturePage();
      console.log('[ICQ] screenshot: full window, size:', img?.getSize());
    }
    if (!img || img.isEmpty()) { console.log('[ICQ] screenshot: EMPTY'); return null; }
    const sz = img.getSize();
    return img.resize({ width: Math.min(sz.width, 900), quality: 'good' }).toPNG();
  } catch (e) { console.error('[ICQ] takeScreenshot:', e.message); return null; }
}

// ── Step 2: Extract text from screenshot (data-pre-plain-text DOM attr) ───────
const TEXT_EXTRACTOR = `(function(){
  try {
    // data-pre-plain-text format: "[10:30 AM, 1/15/2024] SenderName: "
    const bubbles = Array.from(document.querySelectorAll('[data-pre-plain-text]'));
    if (bubbles.length) {
      console.log('[ICQ extract] found', bubbles.length, 'data-pre-plain-text bubbles');
      return { method: 'pre', messages: bubbles.map((el, idx) => {
        const pre  = el.getAttribute('data-pre-plain-text') || '';
        const m    = pre.match(/\\[([^,\\]]+)[^\\]]*\\]\\s*(.*?):\\s*$/);
        const time   = m?.[1]?.trim() || '';
        const sender = m?.[2]?.trim() || '';
        const text   = (el.querySelector('span.selectable-text')?.innerText
                     || el.querySelector('[data-testid="msg-text"]')?.innerText
                     || '').trim();
        const isOut  = !sender || sender === 'You'
                    || !!el.querySelector('[data-testid="msg-dbl-check"],[data-icon="msg-dbl-check"]');
        return { id: idx+':'+pre.slice(0,20), text: text||'📎', sender: isOut ? '' : sender, time, isOut };
      }).filter(m => m.text) };
    }

    // Fallback: any selectable-text spans inside main/conversation area
    const main = document.getElementById('main')
              || document.querySelector('[data-testid="conversation-panel"]');
    if (main) {
      const spans = Array.from(main.querySelectorAll('span.selectable-text.copyable-text'));
      console.log('[ICQ extract] fallback: found', spans.length, 'selectable spans in main');
      if (spans.length) {
        return { method: 'spans', messages: spans.map((el, i) => {
          const text = el.innerText?.trim() || '';
          const row  = el.closest('[data-id]');
          const isOut = !!row?.querySelector('[data-testid="msg-dbl-check"],[data-icon="msg-dbl-check"]');
          const time  = row?.querySelector('[data-testid="msg-time"]')?.textContent?.trim() || '';
          return { id: i+':'+text.slice(0,15), text, sender:'', time, isOut };
        }).filter(m => m.text) };
      }
    }

    console.log('[ICQ extract] no messages found — will use screenshot');
    return { method: 'none', messages: [] };
  } catch(e) { return { method: 'error', messages: [], error: e.message }; }
})()`;

// ── Capture loop: screenshot → try text extract → send to ICQ ─────────────────
async function captureAndSend() {
  if (!waWindow?.webContents || !icqWindow?.webContents) return;
  try {
    // Step 2: try to extract text from DOM first (fastest)
    const extracted = await waWindow.webContents.executeJavaScript(TEXT_EXTRACTOR);
    console.log('[ICQ] extract result:', extracted.method, 'msgs:', extracted.messages?.length);

    if (extracted.messages?.length > 0) {
      // Got structured text — send as native ICQ bubbles
      icqWindow.webContents.send('wa-messages', extracted.messages);
      return;
    }

    // Step 1: take screenshot (fallback when chat hasn't rendered text yet)
    const png = await takeScreenshot();
    if (png) {
      icqWindow.webContents.send('wa-chat-img', 'data:image/png;base64,' + png.toString('base64'));
    }
  } catch (e) { console.error('[ICQ] captureAndSend:', e.message); }
}

function startCaptureLoop() {
  captureAndSend();
  if (captureTimer) return;
  captureTimer = setInterval(captureAndSend, 2000);
}

function stopCaptureLoop() {
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
}

// ── WhatsApp window — UNDER icqWindow, on-screen ─────────────────────────────
function createWaWindow() {
  try { patchSession(session.fromPartition('persist:whatsapp')); } catch(_) {}

  const c = getCenter();
  waWindow = new BrowserWindow({
    width: WA_W, height: WA_H,
    x: c.x, y: c.y,
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

  let loaded = false;
  const onLoad = () => {
    if (loaded) return; loaded = true;
    console.log('[ICQ] WA loaded — starting in 5s');
    setTimeout(() => {
      // Nudge virtual scroll
      waWindow.webContents.executeJavaScript(`
        window.dispatchEvent(new Event('resize'));
        ['#side','[aria-label*="Chat list"]'].map(s => document.querySelector(s))
          .filter(Boolean).forEach(el => { el.scrollTop=1; el.scrollTop=0; });`
      ).catch(() => {});
    }, 4000);
    setTimeout(startContactLoop, 5000);
    setTimeout(() => {
      if (!statusSent) icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
    }, 30000);
  };

  waWindow.webContents.on('did-finish-load',  onLoad);
  waWindow.webContents.on('did-stop-loading', onLoad);
  waWindow.on('closed', () => { waWindow = null; });

  // Keep WA behind ICQ whenever focus changes
  waWindow.on('focus', () => icqWindow?.focus());
}

// ── IPC: show WA for QR login ─────────────────────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow) return;
  waWindow.show();
  waWindow.setAlwaysOnTop(true);
  waWindow.focus();
  const poll = setInterval(async () => {
    if (!waWindow?.webContents) { clearInterval(poll); return; }
    try {
      const ok = await waWindow.webContents.executeJavaScript(
        `!!(document.getElementById('side') || document.querySelector('[aria-label*="Chat list"]'))`
      );
      if (ok) {
        clearInterval(poll);
        waWindow.setAlwaysOnTop(false);
        icqWindow?.focus();
        statusSent = false;
        startContactLoop();
      }
    } catch(_) {}
  }, 3000);
});

// ── IPC: click a contact ──────────────────────────────────────────────────────
ipcMain.on('wa-click-contact', async (e, index) => {
  if (!waWindow?.webContents) return;
  stopCaptureLoop();
  const i = index | 0;
  try {
    // Get cell center in viewport pixels
    const info = await waWindow.webContents.executeJavaScript(`(function(){
      const sels = ['[data-testid="cell-frame-container"]','[data-testid^="cell-frame"]',
                    '[data-testid="chat-list-item"]','#side [role="listitem"]',
                    '[aria-label*="Chat list"] [role="listitem"]'];
      let cells = [];
      for (const s of sels) { cells = Array.from(document.querySelectorAll(s)); if (cells.length) break; }
      const cell = cells[${i}];
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
               name: cell.textContent?.slice(0,40)||'', total: cells.length };
    })()`);

    if (!info) { console.warn('[ICQ] cell not found at', i); return; }
    console.log('[ICQ] clicking contact', i, JSON.stringify(info));

    // Window IS on-screen (under ICQ) — sendInputEvent works
    waWindow.webContents.sendInputEvent({ type: 'mouseMove',  x: info.x, y: info.y });
    waWindow.webContents.sendInputEvent({ type: 'mouseDown',  x: info.x, y: info.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    waWindow.webContents.sendInputEvent({ type: 'mouseUp',    x: info.x, y: info.y, button: 'left', clickCount: 1 });

    // Wait for chat to open, then start capture loop
    setTimeout(startCaptureLoop, 1200);
  } catch (err) { console.error('[ICQ] wa-click-contact:', err.message); }
});

// ── IPC: send message ─────────────────────────────────────────────────────────
ipcMain.on('wa-send-message', async (e, text) => {
  if (!waWindow?.webContents || !text) return;
  try {
    await waWindow.webContents.executeJavaScript(`(function(){
      const input = document.querySelector('[data-testid="compose-box-input"] [contenteditable]')
                 || document.querySelector('[role="textbox"][contenteditable]');
      if (!input) return;
      input.focus();
      document.execCommand('selectAll'); document.execCommand('delete');
      document.execCommand('insertText', false, ${JSON.stringify(String(text))});
      setTimeout(() => {
        (document.querySelector('[data-testid="send"]') || document.querySelector('[data-icon="send"]'))?.click();
      }, 100);
    })()`);
  } catch (e) { console.error('[ICQ] send:', e.message); }
});

// ── IPC: window chrome ────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => icqWindow?.minimize());
ipcMain.on('win-maximize', () => icqWindow?.isMaximized() ? icqWindow.unmaximize() : icqWindow?.maximize());
ipcMain.on('win-close',    () => app.quit());

// ── ICQ window ────────────────────────────────────────────────────────────────
function createIcqWindow() {
  const c = getCenter();
  icqWindow = new BrowserWindow({
    width: ICQ_W, height: ICQ_H,
    x: c.x, y: c.y,
    frame: false, alwaysOnTop: true,
    backgroundColor: '#C0C0C0',
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
      { label: 'Show WhatsApp (login)', click: () => ipcMain.emit('wa-show') },
      { label: 'Reload WhatsApp', click: () => {
        statusSent = false;
        if (contactTimer) { clearInterval(contactTimer); contactTimer = null; }
        waWindow?.webContents.reload();
      }},
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]},
    { label: 'Debug', submenu: [
      { label: 'ICQ DevTools',      click: () => icqWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'WhatsApp DevTools', click: () => waWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'Test screenshot now', click: async () => {
          const png = await takeScreenshot();
          console.log('[ICQ] test screenshot:', png ? png.length + ' bytes' : 'EMPTY');
          if (png) icqWindow?.webContents.send('wa-chat-img', 'data:image/png;base64,' + png.toString('base64'));
      }},
    ]},
  ]));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  patchSession(session.defaultSession);
  createIcqWindow();
  createWaWindow();
});
app.on('window-all-closed', () => app.quit());
