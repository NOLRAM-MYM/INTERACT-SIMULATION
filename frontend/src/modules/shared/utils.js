/**
 * frontend/src/modules/shared/utils.js
 * =======================================
 * Global UI utilities: toast notifications, loading overlay.
 */

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration — ms to display
 */
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;

  // Built with textContent rather than innerHTML: `message` is frequently a
  // server-supplied string (validation errors are echoed back through
  // describeApiError), and interpolating that into markup would let any HTML
  // the server returns execute in the page.
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = { success: '✓', error: '✕', info: 'ℹ' }[type] ?? 'ℹ';

  const text = document.createElement('span');
  text.textContent = message;

  toast.append(icon, text);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toast-in 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Show the full-page loading overlay.
 *
 * With no text, falls back to the active locale's "loading-computing" string
 * rather than hard-coded English. base.html's translation engine publishes
 * window.TRANSLATIONS and stores the chosen locale under 'app-language'; this
 * mirrors the behaviour the inline copy in base.html used to provide, so the
 * overlay stays localised now that this is the only implementation.
 *
 * @param {string} [text] — explicit label; omit to use the localised default
 */
export function showLoading(text) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;

  const lang = localStorage.getItem('app-language') || 'pt';
  const fallback = window.TRANSLATIONS?.[lang]?.['loading-computing'] || 'Computing…';

  const label = document.getElementById('loading-text');
  if (label) label.textContent = text || fallback;

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
}

/**
 * Hide the loading overlay.
 */
export function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

/**
 * Format a number with thousands separators and appropriate decimal places.
 * @param {number} n
 * @param {number} maxDecimals
 * @returns {string}
 */
export function formatNumber(n, maxDecimals = 4) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6)  return n.toExponential(3);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toFixed(maxDecimals);
}

/**
 * Re-apply the active translation to the whole page.
 *
 * Why a page module needs this: the template's inline i18n block merges the
 * page's dictionary and calls translatePage from a DOMContentLoaded listener
 * that is registered during parsing — i.e. before this module's listener. So
 * translatePage runs *before* the controllers have built their DOM, and any
 * markup they generate (KPI labels, headers, legends, table rows) would keep
 * its hard-coded default language.
 *
 * In the original single-script templates this could not happen: init() and
 * translatePage lived in the same handler, with translatePage last. Calling
 * this at the end of a module's boot restores that order.
 */
export function retranslate() {
  const lang = localStorage.getItem('app-language') || 'pt';
  window.translatePage?.(lang);
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
