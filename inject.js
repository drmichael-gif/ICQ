// ============================================================
// ICQ EXACT MATCH — Win98 grey chrome, pure text nostalgia
// Chat LEFT, Contact list RIGHT
// No call/video buttons, just texting
// ============================================================
(function () {
  'use strict';

  // ---- ICQ Flower (bright green from logo, thick black outline) ----
  const FLOWER = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2.5"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(45 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#E81919" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(90 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(135 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(180 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(225 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(270 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2.5" transform="rotate(315 50 50)"/>
    <circle cx="50" cy="50" r="12" fill="#FFD900" stroke="#1A1A1A" stroke-width="2.5"/>
  </svg>`;

  const FL16 = `<svg viewBox="0 0 20 20" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.7"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.7" transform="rotate(45 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#E81919" stroke="#111" stroke-width="0.7" transform="rotate(90 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.7" transform="rotate(135 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.7" transform="rotate(180 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.7" transform="rotate(225 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.7" transform="rotate(270 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.7" transform="rotate(315 10 10)"/>
    <circle cx="10" cy="10" r="2.8" fill="#FFD900" stroke="#111" stroke-width="0.7"/>
  </svg>`;

  // Win98 title bar
  function mkTitle(text, opts = {}) {
    const el = document.createElement('div');
    el.className = 'icq-titlebar' + (opts.inactive ? ' inactive' : '');
    el.innerHTML = `
      <div class="icq-titlebar-icon">${FL16}</div>
      <div class="icq-titlebar-text">${text}</div>
      <div class="icq-titlebar-btns">
        <div class="icq-win-btn" title="Minimize">_</div>
        <div class="icq-win-btn" title="Maximize">□</div>
        <div class="icq-win-btn ${opts.closeCls || ''}" title="Close">×</div>
      </div>
    `;
    return el;
  }

  // ---- DRAG BAR ----
  function injectDrag() {
    if (document.querySelector('.icq-drag-bar')) return;
    const d = document.createElement('div');
    d.className = 'icq-drag-bar';
    document.body.prepend(d);
  }

  // ---- CONTACT LIST CHROME (RIGHT SIDE) ----
  function injectCL() {
    const side = document.getElementById('side');
    if (!side || side.querySelector('.icq-titlebar')) return;

    // Win98 titlebar with UIN
    const tb = mkTitle('22536582');
    side.prepend(tb);

    // ICQ header buttons row
    const hdr = document.createElement('div');
    hdr.className = 'icq-cl-header';
    hdr.innerHTML = `
      <div class="icq-cl-header-btn" style="font-weight:bold;font-size:9px;font-style:italic;">ICQ</div>
      <div class="icq-cl-header-btn">${FL16}</div>
      <div class="icq-cl-header-btn" style="font-size:10px;">👤</div>
      <div class="icq-cl-header-btn" style="font-size:10px;">ℹ️</div>
      <div class="icq-cl-header-btn" style="font-size:10px;">🔍</div>
      <div class="icq-cl-header-btn" style="font-size:10px;">📋</div>
    `;
    tb.after(hdr);

    // Bottom buttons
    const btm = document.createElement('div');
    btm.className = 'icq-cl-bottom';
    btm.innerHTML = `
      <button class="icq-cl-btn"><span style="display:inline-flex">${FL16}</span> System</button>
      <button class="icq-cl-btn">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="#333" stroke-width="1.3">
          <circle cx="5" cy="4" r="2.5"/><path d="M0 12c0-2.5 2-4.5 5-4.5s5 2 5 4.5"/>
          <line x1="11" y1="2" x2="11" y2="8"/><line x1="8" y1="5" x2="14" y2="5"/>
        </svg>
        Search/Add Users
      </button>
      <div class="icq-cl-avail">
        <span style="display:inline-flex">${FL16}</span>
        <span style="font-size:11px;flex:1;">Available</span>
        <span style="font-size:8px;">▼</span>
        <span style="display:inline-flex;margin-left:2px;">${FL16}</span>
      </div>
    `;
    side.append(btm);
  }

  // ---- INJECT FLOWER + "ONLINE" DIVIDER ----
  function injectFlowers() {
    const contacts = document.querySelectorAll('[data-testid="cell-frame-container"]');
    contacts.forEach((c) => {
      if (c.querySelector('.icq-fl')) return;
      const name = c.querySelector('span[dir="auto"]');
      if (!name) return;
      const icon = document.createElement('span');
      icon.className = 'icq-fl';
      icon.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:3px;flex-shrink:0;';
      icon.innerHTML = FL16;
      name.parentElement.insertBefore(icon, name);
    });
  }

  function injectDivider() {
    const list = document.querySelector('[data-testid="chat-list"]');
    if (!list) return;
    const inner = list.querySelector('[role="listbox"], [role="grid"], [data-testid="chat-list"] > div > div');
    if (!inner || inner.querySelector('.icq-divider')) return;
    const div = document.createElement('div');
    div.className = 'icq-divider';
    div.innerHTML = '<span>Online</span>';
    inner.prepend(div);
  }

  // ---- CHAT WINDOW CHROME (LEFT SIDE) ----
  function injectChat() {
    const main = document.getElementById('main');
    if (!main) return;

    const name = getChatName() || 'Message';

    // Title bar
    if (!main.querySelector('.icq-titlebar')) {
      const tb = mkTitle(`${name} Message Dialog`, { closeCls: 'icq-close-chat' });
      main.prepend(tb);
      const closeBtn = tb.querySelector('.icq-close-chat');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const back = main.querySelector('[data-testid="back"]') ||
                       main.querySelector('button[aria-label="Back"]') ||
                       main.querySelector('[data-icon="back"]');
          if (back) back.click();
        });
      }
    } else {
      const tt = main.querySelector('.icq-titlebar-text');
      if (tt) { const t = `${name} Message Dialog`; if (tt.textContent !== t) tt.textContent = t; }
    }

    // User Details fieldset
    if (!main.querySelector('.icq-user-details')) {
      const fs = document.createElement('fieldset');
      fs.className = 'icq-user-details';
      fs.innerHTML = `
        <legend class="icq-ud-legend">User Details</legend>
        <div class="icq-ud-row">
          <span class="icq-ud-label">Nick:</span>
          <span class="icq-ud-value icq-ud-nick">${name}</span>
          <span style="margin-left:12px" class="icq-ud-label">ICQ#:</span>
          <span class="icq-ud-value">692648192</span>
          <span style="margin-left:12px" class="icq-ud-label">Status:</span>
          <span style="display:inline-flex">${FL16}</span>
        </div>
      `;
      const tb = main.querySelector('.icq-titlebar');
      if (tb) tb.after(fs);
    } else {
      const nick = main.querySelector('.icq-ud-nick');
      if (nick && nick.textContent !== name) nick.textContent = name;
    }

    // Send bar
    if (!main.querySelector('.icq-send-bar')) {
      const bar = document.createElement('div');
      bar.className = 'icq-send-bar';
      bar.innerHTML = `
        <div class="icq-send-icons">
          <div class="icq-send-icon-btn">📎</div>
          <div class="icq-send-icon-btn">😊</div>
          <div class="icq-send-icon-btn">🔤</div>
        </div>
        <span class="icq-send-label">Message Length</span>
        <div class="icq-send-progress"><div class="icq-send-progress-fill"></div></div>
        <span class="icq-send-count">0/1024</span>
        <button class="icq-send-btn" id="icq-send">Send</button>
      `;
      main.append(bar);
      bar.querySelector('#icq-send').addEventListener('click', () => {
        const wa = main.querySelector('[data-testid="send"]') || main.querySelector('button[aria-label="Send"]');
        if (wa) wa.click();
      });
    }

    updateMsgLen(main);
  }

  function getChatName() {
    const h = document.querySelector('[data-testid="conversation-header"]');
    if (h) { const s = h.querySelector('span[dir="auto"]') || h.querySelector('span[title]'); if (s) return s.textContent || s.getAttribute('title'); }
    const a = document.querySelector('[data-testid="cell-frame-container"][aria-selected="true"]');
    if (a) { const s = a.querySelector('span[dir="auto"]'); if (s) return s.textContent; }
    return null;
  }

  function updateMsgLen(main) {
    const input = main.querySelector('[role="textbox"][contenteditable="true"]');
    const countEl = main.querySelector('.icq-send-count');
    const fillEl = main.querySelector('.icq-send-progress-fill');
    if (!input || !countEl) return;
    const len = (input.textContent || '').length;
    countEl.textContent = `${len}/1024`;
    if (fillEl) fillEl.style.width = Math.min(100, (len / 1024) * 100) + '%';
  }

  // ---- FORMAT MESSAGES: "Name [Time]:" then text ----
  function fmtMsgs() {
    document.querySelectorAll('.message-in, .message-out').forEach((msg) => {
      if (msg.dataset.icqF) return;
      msg.dataset.icqF = '1';
      if (msg.querySelector('.icq-pf')) return;

      const textEl = msg.querySelector('[data-testid="balloon-text"] span.selectable-text, .copyable-text span.selectable-text, [data-testid="balloon-text"]');
      if (!textEl) return;

      const meta = msg.querySelector('[data-testid="msg-meta"]');
      const tm = meta ? (meta.textContent.match(/[\d:]+\s*[APap][Mm]?|[\d:]+/) || [''])[0] : '';
      const isOut = !!msg.closest('[class*="message-out"]') || msg.classList.contains('message-out');
      const who = isOut ? 'You' : (getChatName() || 'Contact');
      const color = isOut ? '#0000CC' : '#CC0000';

      const pf = document.createElement('div');
      pf.className = 'icq-pf';
      pf.style.cssText = `color:${color};font-weight:bold;font-size:12px;`;
      pf.textContent = `${who} [${tm}]:`;
      textEl.parentNode.insertBefore(pf, textEl);
    });
  }

  // ---- WELCOME SCREEN ----
  function injectWelcome() {
    const main = document.getElementById('main');
    if (main) { const w = document.querySelector('.icq-wc'); if (w) w.remove(); return; }
    const side = document.getElementById('side');
    if (!side) return;
    const right = side.nextElementSibling;
    if (!right || right.id === 'main' || right.querySelector('.icq-wc')) return;
    for (const c of right.children) {
      if (!c.classList.contains('icq-titlebar') && !c.classList.contains('icq-wc')) c.style.display = 'none';
    }
    if (!right.querySelector('.icq-titlebar')) right.prepend(mkTitle('ICQ', { inactive: true }));
    const w = document.createElement('div');
    w.className = 'icq-wc';
    w.innerHTML = `<div class="icq-welcome"><div class="icq-welcome-flower">${FLOWER}</div><h2>ICQ</h2><p>I Seek You</p></div>`;
    right.appendChild(w);
  }

  // ---- HIDE JUNK: WA branding, Meta AI, download prompts, call/video buttons ----
  function hideJunk() {
    // Use TreeWalker for text-based junk (much faster than querySelectorAll('*'))
    const junkTexts = ['Download ICQ for Mac','Download WhatsApp for Mac','Get from App Store',
                       'Ask Meta AI','Meta AI','Send document','Add contact'];
    const junkPartials = ['Make calls and get','Use ICQ on your phone','Use WhatsApp on your phone',
                          'faster experience','download the Mac app'];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const t = (n.textContent || '').trim();
        if (!t) return NodeFilter.FILTER_SKIP;
        if (junkTexts.includes(t)) return NodeFilter.FILTER_ACCEPT;
        for (const p of junkPartials) { if (t.includes(p)) return NodeFilter.FILTER_ACCEPT; }
        return NodeFilter.FILTER_SKIP;
      }
    });
    const junkNodes = []; let tn;
    while ((tn = tw.nextNode())) junkNodes.push(tn);
    junkNodes.forEach((n) => {
      let p = n.parentElement;
      if (!p) return;
      for (let i = 0; i < 6; i++) {
        if (p.parentElement && !['app','side','main','BODY'].includes(p.parentElement.id || p.parentElement.tagName))
          p = p.parentElement; else break;
      }
      p.style.display = 'none';
    });

    // App Store links
    document.querySelectorAll('a[href*="apple.com"],a[href*="play.google"],a[href*="microsoft.com/store"]').forEach((a) => {
      const c = a.closest('div'); if (c) c.style.display = 'none';
    });

    // HIDE call and video buttons everywhere
    document.querySelectorAll('[data-testid="audio-call"], [data-testid="video-call"], [data-testid="search"], button[aria-label*="call" i], button[aria-label*="video" i], [data-icon="audio-call"], [data-icon="video-call"]').forEach((el) => {
      el.style.display = 'none';
    });

    // Hide attach/camera from footer — keep only emoji and text input
    document.querySelectorAll('[data-testid="attach-menu-plus"], [data-testid="ptt-btn"], button[aria-label="Attach"], button[aria-label="Record"]').forEach((el) => {
      el.style.display = 'none';
    });
  }

  // ---- REPLACE TEXT ----
  function replaceText() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => n.textContent.includes('WhatsApp') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const nodes = []; let n;
    while ((n = w.nextNode())) { if (n.parentElement && !n.parentElement.closest('script,style,[contenteditable="true"]')) nodes.push(n); }
    nodes.forEach((n) => { n.textContent = n.textContent.replace(/WhatsApp/g, 'ICQ'); });
    if (document.title.includes('WhatsApp')) document.title = document.title.replace(/WhatsApp/g, 'ICQ');
    else if (!document.title.includes('ICQ')) document.title = 'ICQ';
  }

  // ---- SOUND ----
  let ac;
  function setupSnd() {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    window._uhoh = function () {
      if (!ac) return;
      try {
        const t = ac.currentTime;
        const o1 = ac.createOscillator(), g1 = ac.createGain();
        o1.type = 'sine'; o1.frequency.setValueAtTime(440, t); o1.frequency.linearRampToValueAtTime(350, t + 0.15);
        g1.gain.setValueAtTime(0.2, t); g1.gain.linearRampToValueAtTime(0, t + 0.2);
        o1.connect(g1); g1.connect(ac.destination); o1.start(t); o1.stop(t + 0.2);
        const o2 = ac.createOscillator(), g2 = ac.createGain();
        o2.type = 'sine'; o2.frequency.setValueAtTime(330, t + 0.25); o2.frequency.linearRampToValueAtTime(260, t + 0.45);
        g2.gain.setValueAtTime(0, t + 0.25); g2.gain.linearRampToValueAtTime(0.2, t + 0.28); g2.gain.linearRampToValueAtTime(0, t + 0.5);
        o2.connect(g2); g2.connect(ac.destination); o2.start(t + 0.25); o2.stop(t + 0.5);
      } catch (e) {}
    };
  }
  let lu = 0;
  function chk() {
    const m = document.title.match(/\((\d+)\)/);
    const c = m ? parseInt(m[1], 10) : 0;
    if (c > lu && window._uhoh) try { window._uhoh(); } catch (e) {}
    lu = c;
  }

  // ---- MAIN LOOP ----
  function loop() {
    injectDrag();
    injectCL();
    injectFlowers();
    injectDivider();
    injectChat();
    injectWelcome();
    fmtMsgs();
    replaceText();
    hideJunk();
    chk();
  }

  // Wait for body to exist, then start
  function start() {
    if (!document.body) { setTimeout(start, 200); return; }
    try { loop(); } catch(e) { console.error('[ICQ] loop error:', e); }
    setupSnd();
    setInterval(() => { try { loop(); } catch(e) { console.error('[ICQ] loop error:', e); } }, 1500);
    let db;
    new MutationObserver(() => { clearTimeout(db); db = setTimeout(() => { try { loop(); } catch(e) {} }, 200); }).observe(document.body, { childList: true, subtree: true });
    const te = document.querySelector('title');
    if (te) new MutationObserver(() => { if (document.title.includes('WhatsApp')) document.title = document.title.replace(/WhatsApp/g, 'ICQ'); }).observe(te, { childList: true, characterData: true, subtree: true });
  }
  start();

  console.log('%c🌻 ICQ Exact Match — Loaded', 'color:#3CC832;font-size:14px;font-weight:bold');
})();
