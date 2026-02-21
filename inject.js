/* ============================================================
   ICQ Classic — inject.js
   Matches reference: CL right, chat left, Online/Offline dividers,
   "Name [HH:MM PM]:" message format, Win98 chrome everywhere
   ============================================================ */
(function () {
  'use strict';

  // ── ICQ flower SVGs ────────────────────────────────────────────
  const FLOWER_BIG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2" transform="rotate(0 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2" transform="rotate(45 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#E81919" stroke="#1A1A1A" stroke-width="2" transform="rotate(90 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2" transform="rotate(135 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2" transform="rotate(180 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2" transform="rotate(225 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#50D846" stroke="#1A1A1A" stroke-width="2" transform="rotate(270 50 50)"/>
    <ellipse cx="50" cy="23" rx="13" ry="19" fill="#3CC832" stroke="#1A1A1A" stroke-width="2" transform="rotate(315 50 50)"/>
    <circle cx="50" cy="50" r="12" fill="#FFD900" stroke="#1A1A1A" stroke-width="2"/>
  </svg>`;

  const FLOWER_SM = `<svg viewBox="0 0 20 20" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.8" transform="rotate(0 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.8" transform="rotate(45 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#E81919" stroke="#111" stroke-width="0.8" transform="rotate(90 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.8" transform="rotate(135 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.8" transform="rotate(180 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.8" transform="rotate(225 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#50D846" stroke="#111" stroke-width="0.8" transform="rotate(270 10 10)"/>
    <ellipse cx="10" cy="4.5" rx="3" ry="4.2" fill="#3CC832" stroke="#111" stroke-width="0.8" transform="rotate(315 10 10)"/>
    <circle cx="10" cy="10" r="2.8" fill="#FFD900" stroke="#111" stroke-width="0.8"/>
  </svg>`;

  // ── Helpers ────────────────────────────────────────────────────
  function mkTitleBar(text, opts = {}) {
    const el = document.createElement('div');
    el.className = 'icq-titlebar' + (opts.inactive ? ' inactive' : '');
    el.innerHTML = `
      <div class="icq-titlebar-icon">${FLOWER_SM}</div>
      <div class="icq-titlebar-text">${text}</div>
      <div class="icq-titlebar-btns">
        <div class="icq-win-btn" title="Minimize">_</div>
        <div class="icq-win-btn" title="Maximize">□</div>
        <div class="icq-win-btn${opts.closeClass ? ' ' + opts.closeClass : ''}" title="Close">✕</div>
      </div>`;
    return el;
  }

  function getSide() {
    return document.getElementById('side') ||
           document.getElementById('pane-side') ||
           document.querySelector('[data-testid="two-panel-layout-side"]');
  }

  function getMain() { return document.getElementById('main'); }

  function getChatName() {
    const hdr = document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
                document.querySelector('[data-testid="conversation-header"] span[title]');
    if (hdr) return hdr.textContent.trim() || hdr.getAttribute('title') || '';
    const sel = document.querySelector('[data-testid="cell-frame-container"][aria-selected="true"] span[dir="auto"]');
    return sel ? sel.textContent.trim() : '';
  }

  // ── Drag bar ────────────────────────────────────────────────────
  function injectDragBar() {
    if (document.querySelector('.icq-drag-bar')) return;
    const d = document.createElement('div');
    d.className = 'icq-drag-bar';
    document.body.prepend(d);
  }

  // ── Contact List chrome ─────────────────────────────────────────
  function injectContactList() {
    const side = getSide();
    if (!side) return;
    if (side.querySelector('.icq-titlebar')) return; // already done

    // 1. Title bar  ("ICQ flower  22536582  _ □ ×")
    const tb = mkTitleBar('22536582');
    // Swap icon for larger ICQ flower
    tb.querySelector('.icq-titlebar-icon').innerHTML = FLOWER_SM;
    side.prepend(tb);

    // 2. ICQ header buttons row
    const hdr = document.createElement('div');
    hdr.className = 'icq-cl-header';
    hdr.innerHTML = `
      <div class="icq-cl-header-btn" style="font-size:9px;font-weight:bold;font-style:italic;color:#000">ICQ</div>
      <div class="icq-cl-header-btn">${FLOWER_SM}</div>
      <div class="icq-cl-header-btn">👤</div>
      <div class="icq-cl-header-btn">ℹ️</div>
      <div class="icq-cl-header-btn">🔍</div>
      <div class="icq-cl-header-btn">📋</div>`;
    tb.after(hdr);

    // 3. Bottom buttons
    const btm = document.createElement('div');
    btm.className = 'icq-cl-bottom';
    btm.innerHTML = `
      <button class="icq-cl-btn"><span style="display:inline-flex;margin-right:3px">${FLOWER_SM}</span>System</button>
      <button class="icq-cl-btn">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="#333" stroke-width="1.3">
          <circle cx="5" cy="4" r="2.5"/>
          <path d="M0 12c0-2.5 2-4.5 5-4.5s5 2 5 4.5"/>
          <line x1="11" y1="2" x2="11" y2="8"/><line x1="8" y1="5" x2="14" y2="5"/>
        </svg>
        Search/Add Users
      </button>
      <div class="icq-cl-avail">
        <span style="display:inline-flex;margin-right:3px">${FLOWER_SM}</span>
        <span style="flex:1;font-size:11px">Available</span>
        <span style="font-size:8px">▼</span>
        <span style="display:inline-flex;margin-left:3px">${FLOWER_SM}</span>
      </div>`;
    side.append(btm);
  }

  // ── Add ICQ flower icons next to contact names ──────────────────
  function injectFlowersOnContacts() {
    document.querySelectorAll('[data-testid="cell-frame-container"]').forEach(c => {
      if (c.querySelector('.icq-fl')) return;
      const nameSpan = c.querySelector('span[dir="auto"]');
      if (!nameSpan) return;
      const icon = document.createElement('span');
      icon.className = 'icq-fl';
      icon.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:3px;flex-shrink:0;';
      icon.innerHTML = FLOWER_SM;
      nameSpan.parentNode.insertBefore(icon, nameSpan);
    });
  }

  // ── "Online" section divider ────────────────────────────────────
  function injectOnlineDivider() {
    const list = document.querySelector('[data-testid="chat-list"]');
    if (!list) return;
    // Target the inner scrollable container
    const inner = list.querySelector('[role="listbox"]') ||
                  list.querySelector('[role="grid"]') ||
                  list.firstElementChild;
    if (!inner || inner.querySelector('.icq-divider')) return;
    const div = document.createElement('div');
    div.className = 'icq-divider';
    div.innerHTML = '<span>Online</span>';
    inner.prepend(div);
  }

  // ── Chat window chrome ──────────────────────────────────────────
  function injectChatChrome() {
    const main = getMain();
    if (!main) return;

    const name = getChatName() || 'Message';

    // Title bar
    if (!main.querySelector('.icq-titlebar')) {
      const tb = mkTitleBar(`${name} Message Dialog`, { closeClass: 'icq-close-btn' });
      main.prepend(tb);
      tb.querySelector('.icq-close-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const back = main.querySelector('[data-testid="back"]') ||
                     main.querySelector('button[aria-label="Back"]') ||
                     main.querySelector('[data-icon="back"]');
        back?.click();
      });
    } else {
      const tt = main.querySelector('.icq-titlebar-text');
      const label = `${name} Message Dialog`;
      if (tt && tt.textContent !== label) tt.textContent = label;
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
          <span class="icq-ud-label" style="margin-left:12px">ICQ#:</span>
          <span class="icq-ud-value">692648192</span>
          <span class="icq-ud-label" style="margin-left:12px">Status:</span>
          <span style="display:inline-flex">${FLOWER_SM}</span>
        </div>`;
      main.querySelector('.icq-titlebar').after(fs);
    } else {
      const nick = main.querySelector('.icq-ud-nick');
      if (nick && nick.textContent !== name) nick.textContent = name;
    }

    // Send bar at bottom
    if (!main.querySelector('.icq-send-bar')) {
      const bar = document.createElement('div');
      bar.className = 'icq-send-bar';
      bar.innerHTML = `
        <div class="icq-send-icons">
          <div class="icq-send-icon-btn" title="Attach">📎</div>
          <div class="icq-send-icon-btn" title="Emoticons">😊</div>
          <div class="icq-send-icon-btn" title="Font">🔤</div>
        </div>
        <span class="icq-send-label">Message Length</span>
        <div class="icq-send-progress"><div class="icq-send-progress-fill"></div></div>
        <span class="icq-send-count">0/1024</span>
        <button class="icq-send-btn" id="icq-send-btn">Send</button>`;
      main.append(bar);
      document.getElementById('icq-send-btn')?.addEventListener('click', () => {
        (main.querySelector('[data-testid="send"]') ||
         main.querySelector('button[aria-label="Send"]'))?.click();
      });
    }

    updateMessageLength(main);
  }

  function updateMessageLength(main) {
    const input   = main?.querySelector('[role="textbox"][contenteditable="true"]');
    const countEl = main?.querySelector('.icq-send-count');
    const fillEl  = main?.querySelector('.icq-send-progress-fill');
    if (!input || !countEl) return;
    const len = (input.textContent || '').length;
    countEl.textContent = `${len}/1024`;
    if (fillEl) fillEl.style.width = Math.min(100, (len / 1024) * 100) + '%';
  }

  // ── Format messages: "Name [HH:MM PM]:" ────────────────────────
  function formatMessages() {
    document.querySelectorAll('.message-in, .message-out').forEach(msg => {
      if (msg.dataset.icqDone) return;
      msg.dataset.icqDone = '1';
      if (msg.querySelector('.icq-pf')) return;

      const textEl = msg.querySelector('[data-testid="balloon-text"] span.selectable-text') ||
                     msg.querySelector('.copyable-text span.selectable-text') ||
                     msg.querySelector('[data-testid="balloon-text"]');
      if (!textEl) return;

      const meta = msg.querySelector('[data-testid="msg-meta"]');
      const time = meta ? ((meta.textContent.match(/\d{1,2}:\d{2}\s*[APap][Mm]?/) || [''])[0]) : '';
      const isOut = msg.classList.contains('message-out') || !!msg.closest('[class*="message-out"]');
      const who   = isOut ? 'You' : (getChatName() || 'Contact');

      const pf = document.createElement('div');
      pf.className  = 'icq-pf ' + (isOut ? 'icq-pf-out' : 'icq-pf-in');
      pf.textContent = time ? `${who} [${time}]:` : `${who}:`;
      textEl.parentNode.insertBefore(pf, textEl);
    });
  }

  // ── Welcome screen (no chat open) ──────────────────────────────
  function injectWelcome() {
    const main = getMain();
    // If a real chat is open, remove welcome
    if (main) { document.querySelector('.icq-wc')?.remove(); return; }

    const side = getSide();
    if (!side) return;
    const right = side.nextElementSibling;
    if (!right || right.id === 'main' || right.querySelector('.icq-wc')) return;

    // Hide WA's own intro content
    Array.from(right.children).forEach(c => {
      if (!c.classList.contains('icq-titlebar') && !c.classList.contains('icq-wc'))
        c.style.display = 'none';
    });
    if (!right.querySelector('.icq-titlebar'))
      right.prepend(mkTitleBar('ICQ', { inactive: true }));

    const w = document.createElement('div');
    w.className = 'icq-wc';
    w.innerHTML = `
      <div class="icq-welcome">
        <div class="icq-welcome-flower">${FLOWER_BIG}</div>
        <h2>ICQ</h2>
        <p>I Seek You</p>
      </div>`;
    right.appendChild(w);
  }

  // ── Hide WhatsApp junk ──────────────────────────────────────────
  function hideJunk() {
    const JUNK_EXACT    = ['Download WhatsApp for Mac','Get from App Store','Ask Meta AI','Send document','Add contact'];
    const JUNK_CONTAINS = ['Make calls and get a faster','Use WhatsApp on your phone','download the Mac app'];

    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = (n.textContent || '').trim();
        if (!t) return NodeFilter.FILTER_SKIP;
        if (JUNK_EXACT.includes(t)) return NodeFilter.FILTER_ACCEPT;
        for (const p of JUNK_CONTAINS) { if (t.includes(p)) return NodeFilter.FILTER_ACCEPT; }
        return NodeFilter.FILTER_SKIP;
      }
    });
    const bad = []; let tn;
    while ((tn = tw.nextNode())) bad.push(tn);
    bad.forEach(n => {
      let p = n.parentElement;
      if (!p) return;
      for (let i = 0; i < 5; i++) {
        if (p.parentElement &&
            !['side','main','pane-side','BODY'].includes(p.parentElement.id || p.parentElement.tagName))
          p = p.parentElement;
        else break;
      }
      p.style.display = 'none';
    });

    // Store links, call/video buttons
    document.querySelectorAll(
      'a[href*="apple.com"],a[href*="play.google"],a[href*="microsoft.com/store"],' +
      '[data-testid="audio-call"],[data-testid="video-call"],' +
      'button[aria-label*="call" i],button[aria-label*="video" i],' +
      '[data-icon="audio-call"],[data-icon="video-call"]'
    ).forEach(el => { el.style.display = 'none'; });
  }

  // ── Replace "WhatsApp" text with "ICQ" ─────────────────────────
  function replaceText() {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.textContent.includes('WhatsApp') &&
        !n.parentElement?.closest('script,style,[contenteditable="true"]')
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const nodes = []; let n;
    while ((n = tw.nextNode())) nodes.push(n);
    nodes.forEach(n => { n.textContent = n.textContent.replace(/WhatsApp/g, 'ICQ'); });
    if (document.title.includes('WhatsApp'))
      document.title = document.title.replace(/WhatsApp/g, 'ICQ');
    else if (!document.title.includes('ICQ'))
      document.title = 'ICQ';
  }

  // ── ICQ "uh-oh" notification sound ─────────────────────────────
  let ac, lastUnread = 0;
  function setupSound() {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    window._icqUhoh = function () {
      if (!ac) return;
      try {
        const t = ac.currentTime;
        const play = (freq, start, dur, type = 'sine') => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = type; o.frequency.value = freq;
          g.gain.setValueAtTime(0, start);
          g.gain.linearRampToValueAtTime(0.22, start + 0.02);
          g.gain.linearRampToValueAtTime(0, start + dur);
          o.connect(g); g.connect(ac.destination);
          o.start(start); o.stop(start + dur + 0.05);
        };
        play(440, t,       0.18);
        play(350, t + 0.2, 0.22);
      } catch (_) {}
    };
  }
  function checkNewMessages() {
    const m = document.title.match(/\((\d+)\)/);
    const count = m ? parseInt(m[1], 10) : 0;
    if (count > lastUnread && window._icqUhoh) { try { window._icqUhoh(); } catch (_) {} }
    lastUnread = count;
  }

  // ── Main loop ───────────────────────────────────────────────────
  function loop() {
    injectDragBar();
    injectContactList();
    injectFlowersOnContacts();
    injectOnlineDivider();
    injectChatChrome();
    injectWelcome();
    formatMessages();
    replaceText();
    hideJunk();
    checkNewMessages();
  }

  // ── Boot ────────────────────────────────────────────────────────
  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    try { loop(); } catch (e) { console.error('[ICQ] boot error:', e); }
    setupSound();

    // Interval loop
    setInterval(() => { try { loop(); } catch (e) { console.error('[ICQ] loop error:', e); } }, 1200);

    // MutationObserver for DOM changes
    let debounce;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { try { loop(); } catch (_) {} }, 150);
    }).observe(document.body, { childList: true, subtree: true });

    // Title observer (for ICQ → WhatsApp substitution)
    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(() => {
        if (document.title.includes('WhatsApp'))
          document.title = document.title.replace(/WhatsApp/g, 'ICQ');
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  boot();
  console.log('%c🌻 ICQ Classic — Loaded', 'color:#3CC832;font-size:14px;font-weight:bold');
})();
