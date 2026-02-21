/**
 * main.js — ICQ Messenger
 *
 * THREE-WINDOW PIPELINE:
 *   1. icqWindow  — ICQ UI (visible, user sees this)
 *   2. waWindow   — WhatsApp Web off-screen (1280×900, contacts + screenshots)
 *   3. ocrWindow  — Hidden OCR/analysis window (reads screenshot → extracts text)
 *
 * Flow:
 *   User clicks contact → waWindow.click() → chat opens
 *   → capturePage(#main) screenshot → send to ocrWindow
 *   → ocrWindow extracts text via DOM innerText + aria-labels
 *   → sends structured messages back to main → sends to icqWindow
 *   → icqWindow renders as native ICQ chat bubbles
 *   If OCR fails → fall back to showing raw screenshot in ICQ
 */
const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');
const path = require('path');

let icqWindow    = null;
let waWindow     = null;
let ocrWindow    = null;
let contactTimer = null;
let captureTimer = null;
let statusSent   = false;

const WA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Helpers ───────────────────────────────────────────────────────────────────
function patchSession(sess) {
  try {
    sess.webRequest.onHeadersReceived((details, cb) => {
      const h = { ...details.responseHeaders };
      ['content-security-policy','Content-Security-Policy',
       'content-security-policy-report-only','Content-Security-Policy-Report-Only']
        .forEach(k => delete h[k]);
      cb({ responseHeaders: h });
    });
    sess.setPermissionRequestHandler((wc, p, cb) =>
      cb(['notifications','media','mediaKeySystem','clipboard-read','clipboard-sanitized-write'].includes(p)));
  } catch (e) { console.error('[ICQ] patchSession:', e.message); }
}

function getOffscreenPos() {
  try {
    const d = screen.getPrimaryDisplay();
    return { x: d.bounds.x + d.bounds.width + 50, y: d.bounds.y };
  } catch(_) { return { x: 1500, y: 0 }; }
}

// ── Window 1: ICQ ─────────────────────────────────────────────────────────────
function createIcqWindow() {
  icqWindow = new BrowserWindow({
    width: 1100, height: 780,
    minWidth: 800, minHeight: 580,
    frame: false, show: true,
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
      { label: 'Show WhatsApp (login)', click: () => {
        const d = screen.getPrimaryDisplay();
        waWindow?.setPosition(
          d.bounds.x + Math.floor((d.bounds.width - 1280) / 2),
          d.bounds.y + Math.floor((d.bounds.height - 900) / 2)
        );
        waWindow?.focus();
      }},
      { label: 'Send WA off-screen', click: () => {
        const p = getOffscreenPos(); waWindow?.setPosition(p.x, p.y);
      }},
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
      { label: 'OCR DevTools',      click: () => ocrWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'Test: capture now', click: () => captureAndAnalyze() },
    ]},
  ]));
}

// ── Window 2: WhatsApp (off-screen) ───────────────────────────────────────────
function createWaWindow() {
  try { patchSession(session.fromPartition('persist:whatsapp')); } catch(_) {}

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
  waWindow.webContents.setBackgroundThrottling(false);

  // show:true + 1280×900 = full viewport already. No enableDeviceEmulation needed
  // (that caused V8 crashes on macOS ARM; visible window already has correct dimensions)
  waWindow.loadURL('https://web.whatsapp.com/', { userAgent: WA_UA });

  let loaded = false;
  const onLoad = () => {
    if (loaded) return; loaded = true;
    console.log('[ICQ] WA loaded');

    // Nudge virtual scroll so contacts render
    setTimeout(async () => {
      try {
        await waWindow.webContents.executeJavaScript(`
          window.dispatchEvent(new Event('resize'));
          ['#side','[aria-label*="Chat list"]'].map(s=>document.querySelector(s))
            .filter(Boolean).forEach(el=>{el.scrollTop=1;el.scrollTop=0;});`);
      } catch(_) {}
    }, 4000);

    setTimeout(startContactLoop, 5000);
    setTimeout(() => {
      if (!statusSent) icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
    }, 30000);
  };

  waWindow.webContents.on('did-finish-load',  onLoad);
  waWindow.webContents.on('did-stop-loading', onLoad);
  waWindow.on('closed', () => { waWindow = null; });
}

// ── Window 3: OCR/Analysis (hidden) ──────────────────────────────────────────
function createOcrWindow() {
  ocrWindow = new BrowserWindow({
    width: 1280, height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,   // needs require('electron') for IPC
    },
  });
  ocrWindow.loadFile('ocr.html');
  ocrWindow.on('closed', () => { ocrWindow = null; });
}

// OCR window sends back extracted messages
ipcMain.on('ocr-messages', (e, messages) => {
  console.log('[ICQ] OCR returned', messages?.length, 'messages');
  if (messages?.length > 0) {
    icqWindow?.webContents.send('wa-messages', messages);
  }
});

// OCR window reports failure → use screenshot fallback
ipcMain.on('ocr-screenshot-fallback', (e, b64) => {
  console.log('[ICQ] OCR fallback: sending screenshot to ICQ');
  icqWindow?.webContents.send('wa-chat-img', b64);
});

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

// ── Capture screenshot + send to OCR window ───────────────────────────────────
async function captureAndAnalyze() {
  if (!waWindow?.webContents) return;
  try {
    // Get #main rect AND its innerText in one JS call
    const info = await waWindow.webContents.executeJavaScript(`(function(){
      const m = document.getElementById('main')
             || document.querySelector('[data-testid="conversation-panel"]');
      if (!m) return { rect: null, text: '' };
      const r = m.getBoundingClientRect();
      return {
        rect: r.width > 10 ? {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} : null,
        text: m.innerText || '',
      };
    })()`);

    console.log('[ICQ] #main found:', !!info.rect, 'innerText chars:', info.text.length);
    if (info.text.length > 20) {
      console.log('[ICQ] innerText preview:', info.text.slice(0, 200).replace(/\n/g, ' | '));
    }

    // Take the screenshot
    let img;
    if (info.rect) {
      img = await waWindow.webContents.capturePage(info.rect);
    } else {
      img = await waWindow.webContents.capturePage();
    }

    const empty = !img || img.isEmpty();
    console.log('[ICQ] screenshot:', empty ? 'EMPTY' : (img.getSize().width + 'x' + img.getSize().height));

    const b64 = empty ? null
      : 'data:image/png;base64,' + img.resize({ width: Math.min(img.getSize().width, 900), quality: 'good' }).toPNG().toString('base64');

    // Send screenshot + DOM text to OCR window for analysis
    if (ocrWindow?.webContents && !ocrWindow.isDestroyed()) {
      ocrWindow.webContents.send('analyze', { screenshot: b64, waText: info.text });
    } else if (b64) {
      // OCR window not ready — show raw screenshot
      icqWindow?.webContents.send('wa-chat-img', b64);
    }
  } catch (e) { console.error('[ICQ] captureAndAnalyze:', e.message); }
}

function startCaptureLoop() {
  captureAndAnalyze();
  if (captureTimer) return;
  captureTimer = setInterval(captureAndAnalyze, 2500);
}

function stopCaptureLoop() {
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
}

// ── IPC: contact click ────────────────────────────────────────────────────────
ipcMain.on('wa-click-contact', async (e, index) => {
  if (!waWindow?.webContents) return;
  stopCaptureLoop();
  const i = index | 0;
  try {
    const result = await waWindow.webContents.executeJavaScript(`(function(){
      const sels = ['[data-testid="cell-frame-container"]','[data-testid^="cell-frame"]',
                    '[data-testid="chat-list-item"]','#side [role="listitem"]',
                    '[aria-label*="Chat list"] [role="listitem"]'];
      let cells = [];
      for (const s of sels) { cells = Array.from(document.querySelectorAll(s)); if (cells.length) break; }
      const cell = cells[${i}];
      if (!cell) return { ok: false };
      cell.click();
      return { ok: true, name: cell.textContent?.slice(0,40)||'' };
    })()`);
    console.log('[ICQ] click contact', i, JSON.stringify(result));
    // Clear OCR window state, start capture
    ocrWindow?.webContents.send('clear');
    setTimeout(startCaptureLoop, 1500);
  } catch (err) { console.error('[ICQ] click error:', err.message); }
});

// ── IPC: WA login ─────────────────────────────────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow) return;
  const d = screen.getPrimaryDisplay();
  waWindow.setPosition(
    d.bounds.x + Math.floor((d.bounds.width - 1280) / 2),
    d.bounds.y + Math.floor((d.bounds.height - 900) / 2)
  );
  waWindow.focus();
  const poll = setInterval(async () => {
    if (!waWindow?.webContents) { clearInterval(poll); return; }
    try {
      const ok = await waWindow.webContents.executeJavaScript(
        `!!(document.getElementById('side')||document.querySelector('[aria-label*="Chat list"]'))`
      );
      if (ok) {
        clearInterval(poll);
        const p = getOffscreenPos(); waWindow.setPosition(p.x, p.y);
        statusSent = false; startContactLoop();
      }
    } catch(_) {}
  }, 3000);
});

// ── IPC: send message ─────────────────────────────────────────────────────────
ipcMain.on('wa-send-message', async (e, text) => {
  if (!waWindow?.webContents || !text) return;
  try {
    await waWindow.webContents.executeJavaScript(`(function(){
      const inp = document.querySelector('[data-testid="compose-box-input"] [contenteditable]')
               || document.querySelector('[role="textbox"][contenteditable]');
      if (!inp) return;
      inp.focus();
      document.execCommand('selectAll'); document.execCommand('delete');
      document.execCommand('insertText', false, ${JSON.stringify(String(text))});
      setTimeout(()=>(document.querySelector('[data-testid="send"]')||document.querySelector('[data-icon="send"]'))?.click(), 100);
    })()`);
  } catch(e) { console.error('[ICQ] send:', e.message); }
});

// ── IPC: window chrome ────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => icqWindow?.minimize());
ipcMain.on('win-maximize', () => icqWindow?.isMaximized() ? icqWindow.unmaximize() : icqWindow?.maximize());
ipcMain.on('win-close',    () => app.quit());

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  patchSession(session.defaultSession);
  createIcqWindow();
  createWaWindow();
  createOcrWindow();     // Window 3: OCR/analysis
});
app.on('window-all-closed', () => app.quit());
