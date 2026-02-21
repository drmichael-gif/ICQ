/**
 * main.js — ICQ Messenger
 *
 * NEW APPROACH: waWindow is SHOWN but positioned off-screen (right of display).
 * A visible window has full rendering — virtual scroll, layout, capturePage all work.
 * No enableDeviceEmulation. No setOpacity. No hidden-window tricks.
 *
 * Contacts : DOM-scraped from waWindow every 2s
 * Messages : capturePage() screenshot of #main panel, shown in ICQ chat area
 */
const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');
const path = require('path');

let icqWindow    = null;
let waWindow     = null;
let contactTimer = null;
let msgTimer     = null;
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

    // Fallback: tabindex children of #side that contain a name span
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
      const allSpans = Array.from(cell.querySelectorAll('span[dir="auto"]'));
      contacts.push({
        index: i, name,
        unread: unreadEl?.textContent?.trim() || '',
        time:   timeEl?.textContent?.trim()   || '',
        preview: allSpans[1]?.textContent?.trim() || '',
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

    // Log what testids exist in #side for debugging
    const side = document.getElementById('side');
    if (side && contacts.length === 0) {
      const tids = [...new Set(Array.from(side.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid')).filter(Boolean))].slice(0, 20);
      console.log('[ICQ] no contacts found. #side testids:', tids.join(', '));
      console.log('[ICQ] #side childCount:', side.querySelectorAll('*').length, 'offsetH:', side.offsetHeight);
    }

    return { ok: true, contacts, chatName: chatEl?.textContent?.trim() || '', isLoggedIn };
  } catch(e) { return { ok: false, error: e.message }; }
})()
`;

// ── Contact scrape loop ───────────────────────────────────────────────────────
async function scrapeContacts() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    const data = await waWindow.webContents.executeJavaScript(CONTACT_SCRAPER);
    if (!data?.ok) { console.error('[ICQ] scraper error:', data?.error); return; }
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
  console.log('[ICQ] Starting contact loop');
  scrapeContacts();
  contactTimer = setInterval(scrapeContacts, 2000);
}

// ── Message scraper ───────────────────────────────────────────────────────────
const MESSAGE_SCRAPER = `
(function() {
  try {
    // WhatsApp 2024 may not use #main — try several selectors
    const main =
      document.getElementById('main') ||
      document.querySelector('[data-testid="conversation-panel"]') ||
      document.querySelector('[data-testid="conversation-compose-box"]')?.closest('div[role]') ||
      document.querySelector('[data-testid="msg-container"]')?.closest('[id],[role="region"],[role="main"]') ||
      document.querySelector('div[data-tab="8"]') ||
      document.querySelector('div[data-tab="7"]') ||
      null;

    if (!main) {
      console.log('[ICQ msg] no chat panel found (tried #main + 5 fallbacks)');
      // Log ALL data-testid values on the page to help debug
      const pageTestIds = [...new Set(Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid')).filter(Boolean))].slice(0, 40);
      console.log('[ICQ msg] page testids:', pageTestIds.join(', '));
      return { ok: false, error: 'no chat panel' };
    }
    console.log('[ICQ msg] chat panel found:', main.id || main.getAttribute('data-testid') || main.tagName);

    // ── Diagnostic: log what's in #main ──
    const allTestIds = [...new Set(Array.from(main.querySelectorAll('[data-testid]'))
      .map(el => el.getAttribute('data-testid')).filter(Boolean))].slice(0, 30);
    const allRoles = [...new Set(Array.from(main.querySelectorAll('[role]'))
      .map(el => el.getAttribute('role')).filter(Boolean))].slice(0, 20);
    console.log('[ICQ msg] #main testids:', allTestIds.join(', '));
    console.log('[ICQ msg] #main roles:', allRoles.join(', '));

    const messages = [];

    // ── Try many selectors for message rows ──
    const rowSelectors = [
      '[data-testid="msg-container"]',
      '[data-id]',
      '[role="row"]',
      '[role="listitem"]',
      '[data-testid="conversation-panel-messages"] > div > div',
      '[aria-label*="Message list"] [role="listitem"]',
      '.message-in, .message-out',
    ];
    let rows = [];
    for (const sel of rowSelectors) {
      try {
        const found = Array.from(main.querySelectorAll(sel));
        if (found.length > 0) {
          console.log('[ICQ msg] matched selector:', sel, 'count:', found.length);
          rows = found;
          break;
        }
      } catch(_) {}
    }

    if (!rows.length) {
      // Last resort: find anything in main with a selectable-text span
      rows = Array.from(main.querySelectorAll('*')).filter(el =>
        el.querySelector && el.querySelector('span.selectable-text')
      ).slice(0, 100);
      console.log('[ICQ msg] fallback: found', rows.length, 'elements with selectable-text');
    }

    rows.forEach((row, idx) => {
      // ── Text: try many approaches ──
      const textEl =
        row.querySelector('[data-testid="msg-text"]') ||
        row.querySelector('span.selectable-text.copyable-text') ||
        row.querySelector('span.selectable-text') ||
        row.querySelector('[class*="selectable"]') ||
        row.querySelector('[class*="message-text"]');
      const text = (textEl?.innerText || textEl?.textContent || '').trim();

      // ── Media labels ──
      const hasImg   = !!row.querySelector('img[src*="blob:"]');
      const hasAudio = !!row.querySelector('audio, [data-testid*="audio"]');
      const hasVideo = !!row.querySelector('video, [data-testid*="video"]');
      const hasStick = !!row.querySelector('[data-testid*="sticker"]');

      const displayText = text
        || (hasStick ? '🎭 Sticker' : hasImg ? '📷 Photo' : hasAudio ? '🎵 Audio' : hasVideo ? '🎬 Video' : '');
      if (!displayText) return;

      // ── Outgoing? ──
      const isOut = !!(
        row.querySelector('[data-testid="msg-dbl-check"]') ||
        row.querySelector('[data-testid="msg-check"]') ||
        row.querySelector('[data-icon="msg-dbl-check"]') ||
        row.querySelector('[data-icon="msg-check"]') ||
        (row.className && (row.className.includes('message-out') || row.className.includes('outgoing')))
      );

      // ── Time ──
      const timeEl = row.querySelector('[data-testid="msg-time"]') ||
                     row.querySelector('[class*="timestamp"]') ||
                     row.querySelector('span[dir="auto"] > span');
      const time = (timeEl?.textContent || '').trim().slice(0, 10);

      // ── Sender ──
      const senderEl = row.querySelector('[data-testid="author"]') ||
                       row.querySelector('[aria-label*="said"]');
      const sender = (senderEl?.textContent || '').trim();

      // ── Stable ID ──
      const id = row.getAttribute('data-id') ||
                 row.getAttribute('data-key-id') ||
                 (idx + ':' + displayText.slice(0,20) + time);

      messages.push({ id, text: displayText, isOut, time, sender });
    });

    console.log('[ICQ msg] rows:', rows.length, 'messages extracted:', messages.length);
    return { ok: true, messages };
  } catch(e) {
    console.log('[ICQ msg] error:', e.message);
    return { ok: false, error: e.message };
  }
})()
`;

async function scrapeMessages() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    const data = await waWindow.webContents.executeJavaScript(MESSAGE_SCRAPER);
    if (!data?.ok) { console.error('[ICQ] msg scraper error:', data?.error); return; }
    icqWindow.webContents.send('wa-messages', data.messages || []);
  } catch (e) { console.error('[ICQ] scrapeMessages error:', e.message); }
}

function startMsgLoop() {
  scrapeMessages();
  if (msgTimer) return;
  msgTimer = setInterval(scrapeMessages, 1500);
}

function stopMsgLoop() {
  if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
}

// ── WhatsApp window — shown but OFF-SCREEN ────────────────────────────────────
function getOffscreenPos() {
  // Position waWindow just to the right of the primary display
  try {
    const d = screen.getPrimaryDisplay();
    return { x: d.bounds.x + d.bounds.width + 50, y: d.bounds.y };
  } catch (_) {
    return { x: 1500, y: 0 };
  }
}

function createWaWindow() {
  try {
    const waSess = session.fromPartition('persist:whatsapp');
    patchSession(waSess);
  } catch (e) { console.error('[ICQ] wa session patch error:', e.message); }

  const pos = getOffscreenPos();
  console.log('[ICQ] waWindow off-screen position:', pos);

  waWindow = new BrowserWindow({
    width: 1280, height: 900,
    x: pos.x, y: pos.y,    // positioned off-screen (right of display)
    show: true,             // SHOWN → full rendering, virtual scroll works
    skipTaskbar: true,      // don't appear in macOS Dock / Windows taskbar
    frame: true,
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
    console.log('[ICQ] WA loaded — starting scrape in 5s');

    // Nudge virtual scroll at 4s (window is visible so this always works)
    setTimeout(async () => {
      try {
        await waWindow.webContents.executeJavaScript(`
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
          })()`);
      } catch(e) { console.error('[ICQ] nudge error:', e.message); }
    }, 4000);

    setTimeout(startContactLoop, 5000);
    setTimeout(() => {
      if (!statusSent) {
        console.log('[ICQ] No contacts after 30s — prompting sign-in');
        icqWindow?.webContents.send('wa-status', { status: 'needsLogin' });
      }
    }, 30000);
  };

  waWindow.webContents.on('did-finish-load',  onLoaded);
  waWindow.webContents.on('did-stop-loading', onLoaded);
  waWindow.on('closed', () => { waWindow = null; });
}

// ── IPC: bring WA on-screen for QR sign-in ───────────────────────────────────
ipcMain.on('wa-show', () => {
  if (!waWindow || waWindow.isDestroyed()) return;
  // Move to center of primary display
  try {
    const d = screen.getPrimaryDisplay();
    const x = d.bounds.x + Math.floor((d.bounds.width  - 1280) / 2);
    const y = d.bounds.y + Math.floor((d.bounds.height - 900)  / 2);
    waWindow.setPosition(x, y);
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
        // Move back off-screen after successful login
        const pos = getOffscreenPos();
        waWindow.setPosition(pos.x, pos.y);
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
  stopMsgLoop();
  try {
    // Dispatch the FULL pointer+mouse event sequence that React requires.
    // React's event system listens at document root (bubbling) — dispatching
    // with correct clientX/Y + bubbles:true guarantees it fires React's handler.
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

        const r  = cell.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top  + r.height / 2;

        const mo = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        const po = { ...mo, isPrimary: true, pointerId: 1, pointerType: 'mouse' };

        // Full sequence: pointer events + mouse events (React needs both)
        cell.dispatchEvent(new PointerEvent('pointerover',  po));
        cell.dispatchEvent(new MouseEvent('mouseover',      mo));
        cell.dispatchEvent(new PointerEvent('pointermove',  po));
        cell.dispatchEvent(new MouseEvent('mousemove',      mo));
        cell.dispatchEvent(new PointerEvent('pointerdown',  po));
        cell.dispatchEvent(new MouseEvent('mousedown',      mo));
        cell.dispatchEvent(new PointerEvent('pointerup',    po));
        cell.dispatchEvent(new MouseEvent('mouseup',        mo));
        cell.dispatchEvent(new MouseEvent('click',          mo));

        return { ok: true, total: cells.length, name: cell.textContent?.slice(0,40) };
      })()`);

    console.log('[ICQ] contact click result:', JSON.stringify(result));

    // Check if #main (or equivalent) appeared after the click
    setTimeout(async () => {
      try {
        const state = await waWindow.webContents.executeJavaScript(`
          (function(){
            const main = document.getElementById('main') ||
                         document.querySelector('[data-testid="conversation-panel"]') ||
                         document.querySelector('[data-testid="conversation-compose-box"]');
            return { hasMain: !!main, mainId: main?.id || main?.getAttribute('data-testid') || 'found-no-id' };
          })()`);
        console.log('[ICQ] chat panel check (3s after click):', JSON.stringify(state));
      } catch(_) {}
    }, 3000);

    setTimeout(startMsgLoop, 2000);
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
        waWindow?.blur();
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
