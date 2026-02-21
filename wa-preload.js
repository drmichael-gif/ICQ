/**
 * wa-preload.js — runs inside the WhatsApp <webview>
 * Minimal early setup; main CSS/JS injection done from app.html
 */

// Replace WhatsApp title with ICQ as early as possible
window.addEventListener('DOMContentLoaded', () => {
  // Fix title
  const fixTitle = () => {
    if (document.title.includes('WhatsApp'))
      document.title = document.title.replace(/WhatsApp/g, 'ICQ');
  };
  fixTitle();
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(fixTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
});
