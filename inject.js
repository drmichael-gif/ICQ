/* ============================================================
   ICQ Classic — inject.js (conservative build)
   Just adds Win98 chrome elements on top of WhatsApp.
   Does NOT hide parent containers. Does NOT restructure layout.
   ============================================================ */
(function () {
  'use strict';

  // ── ICQ flower SVG (small) ──────────────────────────────────────
  const FLOWER = `<svg viewBox="0 0 20 20" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
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

  // ── Helpers ─────────────────────────────────────────────────────
  function getSide() {
    return document.getElementById('side') ||
           document.getElementById('pane-side') ||
           document.querySelector('[data-testid="two-panel-layout-side"]');
  }
  function getMain() { return document.getElementById('main'); }

  function getChatName() {
    const el = document.querySelector('[data-testid="conversation-header"] span[dir="auto"]') ||
               document.querySelector('[data-testid="conversation-header"] span[title]');
    return el ? (el.textContent.trim() || el.getAttribute('title') || 'Chat') : 'Chat';
  }

  function mkTitleBar(title) {
    const el = document.createElement('div');
    el.className = 'icq-titlebar';
    el.innerHTML = `
      <span style="display:inline-flex;margin:0 3px 0 1px;flex-shrink:0">${FLOWER}</span>
      <div class="icq-titlebar-text">${title}</div>
      <div class="icq-titlebar-btns">
        <div class="icq-win-btn">_</div>
        <div class="icq-win-btn">□</div>
        <div class="icq-win-btn">✕</div>
      </div>`;
    return el;
  }

  // ── Contact list chrome ─────────────────────────────────────────
  function injectContactList() {
    const side = getSide();
    if (!side || side.querySelector('.icq-titlebar')) return;

    // Title bar
    side.prepend(mkTitleBar('22536582'));

    // Header buttons
    const hdr = document.createElement('div');
    hdr.className = 'icq-cl-header';
    hdr.innerHTML = `
      <div class="icq-cl-header-btn" style="font-size:9px;font-weight:bold;font-style:italic">ICQ</div>
      <div class="icq-cl-header-btn">${FLOWER}</div>
      <div class="icq-cl-header-btn">👤</div>
      <div class="icq-cl-header-btn">🔍</div>`;
    side.children[1].after(hdr); // after title bar

    // Bottom buttons
    const btm = document.createElement('div');
    btm.className = 'icq-cl-bottom';
    btm.innerHTML = `
      <button class="icq-cl-btn">${FLOWER} System</button>
      <button class="icq-cl-btn">Search/Add Users</button>
      <button class="icq-cl-btn" style="display:flex;justify-content:space-between">${FLOWER} Available <span>▼</span></button>`;
    side.appendChild(btm);
  }

  // ── Online divider ──────────────────────────────────────────────
  function injectOnlineDivider() {
    const list = document.querySelector('[data-testid="chat-list"]');
    if (!list || list.querySelector('.icq-divider')) return;
    const inner = list.querySelector('[role="listbox"]') ||
                  list.querySelector('[role="grid"]') ||
                  list.firstElementChild;
    if (!inner) return;
    const div = document.createElement('div');
    div.className = 'icq-divider';
    div.textContent = '── Online ──';
    inner.prepend(div);
  }

  // ── Flower icons on contacts ────────────────────────────────────
  function injectFlowers() {
    document.querySelectorAll('[data-testid^="cell-frame"]').forEach(cell => {
      if (cell.querySelector('.icq-fl')) return;
      const nameSpan = cell.querySelector('span[dir="auto"]');
      if (!nameSpan) return;
      const ico = document.createElement('span');
      ico.className = 'icq-fl';
      ico.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:3px;flex-shrink:0';
      ico.innerHTML = FLOWER;
      nameSpan.parentNode.insertBefore(ico, nameSpan);
    });
  }

  // ── Chat window chrome ──────────────────────────────────────────
  function injectChatChrome() {
    const main = getMain();
    if (!main) return;
    const name = getChatName();

    // Title bar
    if (!main.querySelector('.icq-titlebar')) {
      main.prepend(mkTitleBar(`${name} Message Dialog`));
    } else {
      const tt = main.querySelector('.icq-titlebar-text');
      const want = `${name} Message Dialog`;
      if (tt && tt.textContent !== want) tt.textContent = want;
    }

    // User Details fieldset
    if (!main.querySelector('.icq-user-details')) {
      const fs = document.createElement('fieldset');
      fs.className = 'icq-user-details';
      fs.innerHTML = `
        <legend class="icq-ud-legend">User Details</legend>
        <div class="icq-ud-row">
          <b>Nick:</b>&nbsp;<span class="icq-ud-nick">${name}</span>
          &nbsp;&nbsp;<b>ICQ#:</b>&nbsp;<span>692648192</span>
          &nbsp;&nbsp;<b>Status:</b>&nbsp;<span style="display:inline-flex">${FLOWER}</span>
        </div>`;
      main.querySelector('.icq-titlebar').after(fs);
    } else {
      const n = main.querySelector('.icq-ud-nick');
      if (n && n.textContent !== name) n.textContent = name;
    }

    // Send bar
    if (!main.querySelector('.icq-send-bar')) {
      const bar = document.createElement('div');
      bar.className = 'icq-send-bar';
      bar.innerHTML = `
        <span style="font-size:11px;color:#808080">Message Length</span>
        <span class="icq-send-count" style="font-size:11px;margin-left:4px">0/1024</span>
        <button class="icq-send-btn" id="icq-send">Send</button>`;
      main.appendChild(bar);
      document.getElementById('icq-send')?.addEventListener('click', () => {
        (main.querySelector('[data-testid="send"]') ||
         main.querySelector('button[aria-label="Send"]'))?.click();
      });
    }

    // Update message length counter
    const input   = main.querySelector('[role="textbox"][contenteditable="true"]');
    const countEl = main.querySelector('.icq-send-count');
    if (input && countEl) {
      countEl.textContent = `${(input.textContent || '').length}/1024`;
    }
  }

  // ── "Name [Time]:" message prefixes ────────────────────────────
  function formatMessages() {
    document.querySelectorAll('.message-in, .message-out, [class*="message-in"], [class*="message-out"]').forEach(msg => {
      if (msg.dataset.icqDone) return;
      msg.dataset.icqDone = '1';

      const textEl = msg.querySelector('[data-testid="balloon-text"] span.selectable-text') ||
                     msg.querySelector('.copyable-text span.selectable-text') ||
                     msg.querySelector('[data-testid="balloon-text"]');
      if (!textEl) return;

      const metaEl = msg.querySelector('[data-testid="msg-meta"]');
      const time   = metaEl ? ((metaEl.textContent.match(/\d{1,2}:\d{2}\s*[APap][Mm]?/) || [''])[0]) : '';
      const isOut  = msg.classList.contains('message-out') ||
                     msg.className.includes('message-out');
      const who    = isOut ? 'You' : getChatName();

      const pf = document.createElement('div');
      pf.className = 'icq-pf ' + (isOut ? 'icq-pf-out' : 'icq-pf-in');
      pf.textContent = time ? `${who} [${time}]:` : `${who}:`;
      textEl.closest('[data-testid="balloon-text"]')?.parentNode.insertBefore(pf,
        textEl.closest('[data-testid="balloon-text"]'));
    });
  }

  // ── Replace "WhatsApp" with "ICQ" in visible text ───────────────
  function replaceWAText() {
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
  }

  // ── ICQ uh-oh notification sound ───────────────────────────────
  let ac, lastUnread = 0;
  function initAudio() {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  function uhoh() {
    if (!ac) return;
    try {
      const t = ac.currentTime;
      [[440, t, 0.18], [350, t + 0.22, 0.22]].forEach(([freq, start, dur]) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(0.2, start + 0.02);
        g.gain.linearRampToValueAtTime(0, start + dur);
        o.connect(g); g.connect(ac.destination);
        o.start(start); o.stop(start + dur + 0.05);
      });
    } catch (_) {}
  }
  function checkSound() {
    const m = document.title.match(/\((\d+)\)/);
    const count = m ? parseInt(m[1], 10) : 0;
    if (count > lastUnread) uhoh();
    lastUnread = count;
  }

  // ── Main loop ───────────────────────────────────────────────────
  function loop() {
    try {
      injectContactList();
      injectOnlineDivider();
      injectFlowers();
      injectChatChrome();
      formatMessages();
      replaceWAText();
      checkSound();
    } catch (e) {
      console.error('[ICQ inject] error:', e);
    }
  }

  // ── Boot ────────────────────────────────────────────────────────
  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    initAudio();
    loop();
    setInterval(loop, 1500);

    let debounce;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(loop, 200);
    }).observe(document.body, { childList: true, subtree: true });

    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(() => {
        if (document.title.includes('WhatsApp'))
          document.title = document.title.replace(/WhatsApp/g, 'ICQ');
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  boot();
  console.log('%c🌻 ICQ Classic loaded', 'color:#3CC832;font-weight:bold;font-size:14px');
})();
