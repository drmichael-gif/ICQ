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
let ocrWindow    = null;   // Window 3: hidden OCR/text-extraction
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

// ── Screenshot capture (messages) ─────────────────────────────────────────────
async function captureChat() {
  if (!waWindow || waWindow.isDestroyed()) return;
  if (!icqWindow || icqWindow.isDestroyed()) return;
  try {
    // ── Find the chat panel + extract its text ────────────────────────────
    const info = await waWindow.webContents.executeJavaScript(`
      (function(){
        // Try multiple selectors for the chat panel (WA changes testids often)
        const panelSels = [
          '#main',
          '[data-testid="conversation-panel-wrapper"]',
          '[data-testid="conversation-panel"]',
          '[data-testid="conversation-header"]',   // if header exists, panel is open
          '.two [id="main"]',
        ];
        let panel = null;
        for (const s of panelSels) {
          const el = document.querySelector(s);
          if (el && el.offsetWidth > 100) { panel = el; break; }
        }

        const ws = { w: window.innerWidth, h: window.innerHeight };

        // Also get innerText from the message list specifically
        const msgSels = [
          '#main .message-list',
          '#main [data-testid="msg-container"]',
          '#main [role="application"]',
          '#main',
          '[data-testid="conversation-panel-wrapper"]',
          '[data-testid="conversation-panel"]',
        ];
        let text = '';
        for (const s of msgSels) {
          const el = document.querySelector(s);
          if (el && el.innerText && el.innerText.trim().length > 10) {
            text = el.innerText;
            break;
          }
        }

        // Debug: what testids exist?
        const allTids = [...new Set(
          Array.from(document.querySelectorAll('[data-testid]'))
            .map(el => el.getAttribute('data-testid'))
        )].filter(Boolean).sort();

        if (!panel) {
          return { found: false, ws, text, allTids: allTids.slice(0,30) };
        }
        const r = panel.getBoundingClientRect();
        return {
          found: true, ws, text,
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.round(r.width), height: Math.round(r.height),
        };
      })()`);

    // Log useful debug info (only when text length changes to avoid spamming)
    if (!captureChat._lastLen || Math.abs(info.text.length - captureChat._lastLen) > 5) {
      console.log('[ICQ] capture: found=%s textLen=%d ws=%dx%d',
        info?.found, info?.text?.length || 0, info?.ws?.w, info?.ws?.h);
      if (!info?.found) {
        console.log('[ICQ] panel not found. testids:', (info?.allTids || []).join(', '));
      }
      captureChat._lastLen = info?.text?.length || 0;
    }

    // ── Screenshot ────────────────────────────────────────────────────────
    let img;
    if (info?.found && info.width > 10 && info.height > 10) {
      img = await waWindow.webContents.capturePage({
        x: info.x, y: info.y, width: info.width, height: info.height
      });
    } else {
      img = await waWindow.webContents.capturePage();
    }

    if (!img || img.isEmpty()) {
      console.log('[ICQ] capturePage returned empty image');
      return;
    }

    const sz      = img.getSize();
    const resized = img.resize({ width: Math.min(sz.width, 900), quality: 'good' });
    const b64     = 'data:image/png;base64,' + resized.toPNG().toString('base64');
    const waText  = info?.text || '';

    // ── Send to OCR window ────────────────────────────────────────────────
    if (ocrWindow && !ocrWindow.isDestroyed()) {
      ocrWindow.webContents.send('analyze', { screenshot: b64, waText });
    } else {
      icqWindow.webContents.send('wa-chat-img', b64);
    }
  } catch (e) { console.error('[ICQ] captureChat error:', e.message, e.stack); }
}

function startCapture() {
  captureChat();
  if (screenTimer) return;
  screenTimer = setInterval(captureChat, 1500);
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

    // Inject CSS to permanently hide the "Download WhatsApp for Mac" nudge
    setTimeout(async () => {
      try {
        await waWindow.webContents.executeJavaScript(`
          (function(){
            if (document.getElementById('icq-hide-nudge')) return;
            const s = document.createElement('style');
            s.id = 'icq-hide-nudge';
            // Hide all known "download app" overlay selectors
            s.textContent = \`
              [data-testid*="download"],
              [data-testid*="get-app"],
              [data-testid*="nudge"],
              [data-testid*="startup"],
              [data-testid="intro-md-beta-logo-dark"],
              [data-testid="intro-md-beta-logo-light"]
              { display: none !important; }
            \`;
            document.head?.appendChild(s);
            console.log('[ICQ] download nudge CSS injected');
          })()`);
      } catch(e) { console.error('[ICQ] CSS inject error:', e.message); }
    }, 3000);

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

// ── Helper: dismiss "Download WhatsApp for Mac" overlay ──────────────────────
async function dismissDownloadNudge() {
  if (!waWindow || waWindow.isDestroyed()) return;
  try {
    await waWindow.webContents.executeJavaScript(`
      (function() {
        // 1. Try known close-button testids
        const closeSelectors = [
          '[data-testid="get-app-nudge-close-button"]',
          '[data-testid*="download"][data-testid*="close"]',
          '[data-testid*="nudge"][data-testid*="close"]',
          '[data-testid*="get-app"] [role="button"]',
          '[data-testid*="startup"] [role="button"]',
        ];
        for (const s of closeSelectors) {
          const el = document.querySelector(s);
          if (el) { el.click(); console.log('[ICQ] dismissed nudge via:', s); return; }
        }
        // 2. Find any button inside a "download" wrapper
        const wrapper = document.querySelector('[data-testid*="download"], [data-testid*="nudge"], [data-testid*="get-app"]');
        if (wrapper) {
          const btn = wrapper.querySelector('button, [role="button"]');
          if (btn) { btn.click(); return; }
          // Try clicking outside to dismiss
          document.querySelector('#main')?.click();
          return;
        }
        // 3. Inject CSS to permanently hide it (nuclear option)
        if (!document.getElementById('icq-hide-nudge')) {
          const s = document.createElement('style');
          s.id = 'icq-hide-nudge';
          s.textContent = [
            '[data-testid*="download"]',
            '[data-testid*="get-app"]',
            '[data-testid*="nudge"]',
            '[data-testid*="startup"]',
            // fallback: any full-screen overlay on #main
          ].join(',\\n') + ' { display: none !important; }';
          document.head?.appendChild(s);
          console.log('[ICQ] injected CSS to hide download nudge');
        }
      })()`);
  } catch (e) { console.error('[ICQ] dismissDownloadNudge error:', e.message); }
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

// ── sleep helper ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Shared cell-selector JS (injected as string) ──────────────────────────────
const GET_CELLS_FN = `
function getWaCells() {
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
    const found = Array.from(document.querySelectorAll(s));
    if (found.length > 0) return found;
  }
  const side = document.getElementById('side') ||
               document.querySelector('[aria-label*="Chat list"]');
  if (side) {
    return Array.from(side.querySelectorAll('[tabindex="-1"],[tabindex="0"]'))
      .filter(el => el.querySelector('span[dir="auto"],[title]') && el.offsetHeight > 20);
  }
  return [];
}
`;

// ── IPC: click a contact ──────────────────────────────────────────────────────
// payload: number (index) OR { index, name } — both supported
ipcMain.on('wa-click-contact', async (e, payload) => {
  if (!waWindow || waWindow.isDestroyed()) return;
  const i    = typeof payload === 'number' ? (payload | 0) : ((payload?.index ?? 0) | 0);
  const name = typeof payload === 'object'  ? (payload?.name  ?? '') : '';

  if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }

  try {
    // ── Step 1: Move waWindow on-screen ──────────────────────────────────
    const d   = screen.getPrimaryDisplay();
    const waX = Math.round(d.bounds.x + (d.bounds.width  - 1280) / 2);
    const waY = Math.round(d.bounds.y + (d.bounds.height - 900)  / 2);
    waWindow.setPosition(waX, waY);
    // icqWindow stays alwaysOnTop so it visually covers the WA window
    icqWindow?.setAlwaysOnTop(true);
    icqWindow?.focus();
    await sleep(300);  // let window settle

    // ── Step 2: Dismiss modal first — press Escape key ───────────────────
    // sendInputEvent keyboard works even when waWindow isn't the OS focus
    waWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await sleep(30);
    waWindow.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'Escape' });
    await sleep(200);
    await dismissDownloadNudge();  // DOM-level dismiss as well
    await sleep(200);

    // ── Step 3: FOCUS waWindow webContents ───────────────────────────────
    // Critical: sendInputEvent requires the target webContents to be focused.
    // webContents.focus() focuses the renderer without changing window Z-order.
    waWindow.webContents.focus();
    await sleep(150);

    // ── Step 4: Get cell centre coords + scroll into view ─────────────────
    const cellInfo = await waWindow.webContents.executeJavaScript(`
      (function(){
        ${GET_CELLS_FN}
        const cells = getWaCells();
        const cell  = cells[${i}];
        if (!cell) return { ok: false, total: cells.length };
        cell.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        const r  = cell.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return { ok: false, reason: 'zero-size', total: cells.length };
        const cx = Math.round(r.left + r.width  / 2);
        const cy = Math.round(r.top  + r.height / 2);
        const inView = cx > 0 && cy > 0 && cx < window.innerWidth && cy < window.innerHeight;
        return { ok: true, cx, cy, inView, total: cells.length, name: cell.textContent?.slice(0,40) };
      })()`);

    console.log('[ICQ] click-contact i=%d name="%s" cellInfo=%s', i, name, JSON.stringify(cellInfo));

    if (cellInfo?.ok) {
      const { cx, cy } = cellInfo;

      // ── Step 5a: sendInputEvent — real OS-level mouse events ─────────
      waWindow.webContents.sendInputEvent({ type: 'mouseMove',  x: cx, y: cy });
      await sleep(40);
      waWindow.webContents.sendInputEvent({ type: 'mouseDown',  x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(40);
      waWindow.webContents.sendInputEvent({ type: 'mouseUp',    x: cx, y: cy, button: 'left', clickCount: 1 });
      console.log('[ICQ] sendInputEvent click at (%d,%d)', cx, cy);
      await sleep(150);

      // ── Step 5b: Synthetic PointerEvent + MouseEvent (belt+suspenders) ──
      // Dispatched directly in the renderer — works even if sendInputEvent missed
      await waWindow.webContents.executeJavaScript(`
        (function(){
          ${GET_CELLS_FN}
          const cells = getWaCells();
          const cell  = cells[${i}];
          if (!cell) { console.warn('[WA] cell ${i} not found for synthetic click'); return; }
          cell.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          const r  = cell.getBoundingClientRect();
          const cx = r.left + r.width  / 2;
          const cy = r.top  + r.height / 2;

          // Dispatch on both the cell AND its first child (React handlers may be on either)
          const targets = [cell, cell.firstElementChild, cell.querySelector('div')].filter(Boolean);
          targets.forEach(t => {
            const pOpts = { bubbles:true, cancelable:true, clientX:cx, clientY:cy,
                            button:0, buttons:1, pointerId:1, pointerType:'mouse', isPrimary:true };
            const mOpts = { bubbles:true, cancelable:true, clientX:cx, clientY:cy, button:0, buttons:1 };
            t.dispatchEvent(new PointerEvent('pointerover',  pOpts));
            t.dispatchEvent(new MouseEvent ('mouseover',     mOpts));
            t.dispatchEvent(new PointerEvent('pointermove',  pOpts));
            t.dispatchEvent(new MouseEvent ('mousemove',     mOpts));
            t.dispatchEvent(new PointerEvent('pointerdown',  pOpts));
            t.dispatchEvent(new MouseEvent ('mousedown',     mOpts));
            t.dispatchEvent(new PointerEvent('pointerup',    { ...pOpts, buttons:0 }));
            t.dispatchEvent(new MouseEvent ('mouseup',       { ...mOpts, buttons:0 }));
            t.dispatchEvent(new MouseEvent ('click',         { ...mOpts, buttons:0 }));
          });
          console.log('[WA] synthetic click dispatched on', targets.length, 'targets at', Math.round(cx), Math.round(cy));
        })()`);

    } else {
      console.warn('[ICQ] cell not found — index=%d total=%d', i, cellInfo?.total);
    }

    // ── Step 6: Dismiss modal again post-click ────────────────────────────
    await sleep(300);
    await dismissDownloadNudge();
    setTimeout(dismissDownloadNudge, 800);

    // ── Step 7: Move WA back off-screen ──────────────────────────────────
    setTimeout(() => {
      if (waWindow && !waWindow.isDestroyed()) waWindow.setPosition(getOffscreenPos().x, getOffscreenPos().y);
    }, 700);

    // ── Step 8: Verify chat opened, then start capture ────────────────────
    setTimeout(async () => {
      if (!waWindow || waWindow.isDestroyed()) return;
      try {
        const mainLen = await waWindow.webContents.executeJavaScript(
          `(document.getElementById('main') || document.querySelector('[data-testid="conversation-panel"]') || {innerText:''}).innerText.length`
        );
        console.log('[ICQ] post-click #main.innerText.length =', mainLen,
                    mainLen > 50 ? '✅ chat opened' : '⚠️ still empty');
      } catch(err) { console.error('[ICQ] verify error:', err.message); }
    }, 1800);

    setTimeout(captureChat,  2000);  // first capture
    setTimeout(startCapture, 2500);  // then every 1.5s

  } catch (err) { console.error('[ICQ] click error:', err.message, err.stack); }
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

// ── Window 3: OCR / text-extraction (hidden) ──────────────────────────────────
function createOcrWindow() {
  ocrWindow = new BrowserWindow({
    width: 800, height: 600,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });
  ocrWindow.loadFile('ocr.html');
  ocrWindow.on('closed', () => { ocrWindow = null; });
}

// OCR extracted structured messages → show as native ICQ bubbles
ipcMain.on('ocr-messages', (e, messages) => {
  console.log('[ICQ] OCR extracted', messages?.length, 'messages');
  if (messages?.length > 0) {
    icqWindow?.webContents.send('wa-messages', messages);
  }
});

// OCR couldn't parse → fall back to raw screenshot
ipcMain.on('ocr-screenshot-fallback', (e, b64) => {
  icqWindow?.webContents.send('wa-chat-img', b64);
});

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
    { label: 'Debug', submenu: [
      { label: 'Test screenshot + OCR now', click: async () => {
        console.log('[ICQ] Manual test: capturing screenshot + text...');
        if (!waWindow || waWindow.isDestroyed()) {
          console.log('[ICQ] waWindow not ready');
          return;
        }
        try {
          const img = await waWindow.webContents.capturePage();
          const sz = img.isEmpty() ? null : img.getSize();
          console.log('[ICQ] capturePage:', sz ? `${sz.width}x${sz.height}` : 'EMPTY');
          if (!img.isEmpty()) {
            const b64 = 'data:image/png;base64,' + img.toPNG().toString('base64');
            console.log('[ICQ] PNG bytes:', img.toPNG().length);
            icqWindow?.webContents.send('wa-chat-img', b64);
          }
          const waText = await waWindow.webContents.executeJavaScript(
            `(document.getElementById('main')||{innerText:''}).innerText`
          ).catch(() => '');
          console.log('[ICQ] innerText chars:', waText.length);
          if (waText.length > 0) {
            console.log('[ICQ] innerText preview:', waText.slice(0,200));
          }
          if (ocrWindow && !ocrWindow.isDestroyed()) {
            const b64 = img.isEmpty() ? '' : 'data:image/png;base64,' + img.toPNG().toString('base64');
            ocrWindow.webContents.send('analyze', { screenshot: b64, waText });
          }
        } catch (err) {
          console.error('[ICQ] test capture error:', err.message);
        }
      }},
      { label: 'Show OCR window', click: () => {
        if (ocrWindow && !ocrWindow.isDestroyed()) {
          ocrWindow.show();
          ocrWindow.focus();
        }
      }},
      { label: 'Log WA DOM info', click: async () => {
        if (!waWindow || waWindow.isDestroyed()) return;
        try {
          const info = await waWindow.webContents.executeJavaScript(`
            (function(){
              const side = document.getElementById('side');
              const main = document.getElementById('main');
              const tids = side ? [...new Set(Array.from(side.querySelectorAll('[data-testid]'))
                .map(el=>el.getAttribute('data-testid')).filter(Boolean))].slice(0,20) : [];
              return {
                title: document.title,
                hasSide: !!side, hasMain: !!main,
                sideChildren: side?.querySelectorAll('*').length || 0,
                mainTextLen: main?.innerText?.length || 0,
                testids: tids,
              };
            })()`);
          console.log('[ICQ] WA DOM info:', JSON.stringify(info, null, 2));
        } catch(err) { console.error('[ICQ] DOM info error:', err.message); }
      }},
    ]},
    { label: 'View', submenu: [
      { label: 'ICQ DevTools',      click: () => icqWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'WhatsApp DevTools', click: () => waWindow?.webContents.openDevTools({ mode: 'detach' }) },
      { label: 'OCR DevTools',      click: () => {
        if (ocrWindow && !ocrWindow.isDestroyed()) {
          ocrWindow.show();
          ocrWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }},
    ]},
  ]));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  patchSession(session.defaultSession);
  app.on('session-created', patchSession);
  createIcqWindow();
  createWaWindow();
  createOcrWindow();   // Window 3: OCR text extraction
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!icqWindow) createIcqWindow(); });
