/**
 * frontend/src/modules/shared/shell.js
 * ======================================
 * Behaviour of the page shell that base.html renders around every module:
 * sidebar toggle, focus mode, the results HUD over the simulation, the
 * layout reset, the shared Three.js hover tooltip and the results export.
 *
 * window.ThreeTooltip and window.exportUtils stay globals because the page
 * controllers (separate Vite entries) call them at runtime.
 */

const t = (key, fallback) => {
  const lang = localStorage.getItem('app-language') || 'pt';
  return window.TRANSLATIONS?.[lang]?.[key] || fallback;
};

const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

// Let a layout transition finish, then make Three.js/Plotly re-measure.
const resizeSoon = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 260);

// ---- Three.js hover tooltip (pages with hoverable 3D objects) ----
export const ThreeTooltip = (() => {
  const el = document.getElementById('three-tooltip');
  function show(html, clientX, clientY) {
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    // Offset from the cursor, clamped so it never runs off-screen.
    const x = Math.min(clientX + 16, window.innerWidth - el.offsetWidth - 12);
    const y = Math.min(clientY + 16, window.innerHeight - el.offsetHeight - 12);
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }
  function hide() {
    if (el) el.hidden = true;
  }
  return { show, hide };
})();

// ---- Export utilities (results panel "Export" button) ----
export const exportUtils = (() => {
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    triggerDownload(blob, filename.endsWith('.json') ? filename : `${filename}.json`);
  }

  // rows: array of plain objects (all rows should share the same keys).
  function downloadCSV(rows, filename) {
    if (!rows || !rows.length) return;
    const headers = Object.keys(rows[0]);
    const escapeCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      headers.join(','),
      ...rows.map(row => headers.map(h => escapeCell(row[h])).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
  }

  return { downloadJSON, downloadCSV };
})();

window.ThreeTooltip = ThreeTooltip;
window.exportUtils = exportUtils;

// ---- Sidebar toggle (desktop collapses, ≤1024 px slides over) ----
function setupSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  toggle.addEventListener('click', () => {
    if (window.innerWidth <= 1024) {
      sidebar.classList.toggle('is-open');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem('sidebar-collapsed', document.body.classList.contains('sidebar-collapsed'));
    }
    resizeSoon();
  });
}

// ---- Focus mode: sidebar and page header out of the way, simulation tall ----
// The class is restored before first paint by the inline script at the top of
// base.html's <body>; this wires the toggle and the F shortcut.
function setupFocusMode() {
  const btn = document.getElementById('focus-toggle');
  if (!document.querySelector('.sim-fullscreen')) {
    btn?.remove();        // nothing to focus on (home page)
    return;
  }
  const set = (on) => {
    document.body.classList.toggle('focus-mode', on);
    localStorage.setItem('focus-mode', String(on));
    btn?.setAttribute('aria-pressed', String(on));
    resizeSoon();
  };
  btn?.setAttribute('aria-pressed', String(document.body.classList.contains('focus-mode')));
  btn?.addEventListener('click', () => set(!document.body.classList.contains('focus-mode')));
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'f' || isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    set(!document.body.classList.contains('focus-mode'));
  });
}

// ---- Results HUD over the simulation ----
// Mirrors the page header's live stat badges into the corner of the canvas,
// shown only while the header itself is off screen — scrolled away, or hidden
// by focus mode — so the key numbers stay in view without opening a panel.
function setupHud() {
  const badges = document.querySelector('.page-header__badges');
  const wrap = document.querySelector('.sim-fullscreen .sim-canvas-wrap');
  if (!badges || !wrap) return;

  const hud = document.createElement('div');
  hud.className = 'sim-hud';
  hud.setAttribute('aria-hidden', 'true');   // a visual duplicate of the header badges
  wrap.appendChild(hud);

  const render = () => {
    hud.replaceChildren(...[...badges.children].map(badge => {
      const copy = badge.cloneNode(true);
      [copy, ...copy.querySelectorAll('[id]')].forEach(n => n.removeAttribute('id'));
      return copy;
    }));
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }).observe(badges, { subtree: true, childList: true, characterData: true, attributes: true });
  render();

  new IntersectionObserver(([entry]) => {
    hud.classList.toggle('is-visible', !entry.isIntersecting);
  }).observe(badges);
}

// ---- Layout reset (every panel home, default sizes, default open state) ----
function setupLayoutReset() {
  const btn = document.getElementById('layout-reset');
  if (!document.querySelector('.floating-panel')) {
    btn?.remove();
    return;
  }
  btn?.addEventListener('click', () => {
    window.FloatingPanel?.resetLayout();
    window.showToast?.(t('toast-layout-reset', 'Layout restaurado.'), 'info', 2000);
  });
}

// ---- Results export ----
// Every simulator page renders its results as a .results-table of label/value
// rows, so this works with zero per-page JS — it reads what is on screen.
//
// Pick the *visible* table rather than #results-table. The physics page
// carries two (#results-table for projectile, #results-table-mag for
// magnetism) and hides the inactive one; keying on the id alone always
// exported the projectile rows, even while the magnetism tab was up.
function setupExport() {
  document.getElementById('export-results')?.addEventListener('click', () => {
    const isVisible = el => !!(el.offsetParent || el.getClientRects().length);
    const tables = Array.from(document.querySelectorAll('.results-table, #results-table'));
    const table = tables.find(isVisible) || tables[0] || null;
    const rows = table ? Array.from(table.querySelectorAll('tbody tr')).map(tr => {
      const cells = tr.querySelectorAll('td');
      return { label: cells[0]?.textContent.trim() || '', value: cells[1]?.textContent.trim() || '' };
    }) : [];
    if (!rows.length) {
      window.showToast?.(t('toast-export-empty', 'Nothing to export yet — run a simulation first.'), 'error');
      return;
    }

    const slug = (document.title || 'results').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'results';
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${slug}-${timestamp}`;

    const jsonObj = {};
    rows.forEach(r => { jsonObj[r.label] = r.value; });
    exportUtils.downloadJSON(jsonObj, filename);
    exportUtils.downloadCSV(rows, filename);
    window.showToast?.(t('toast-export-done', 'Results exported (JSON + CSV).'), 'success', 2500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupSidebar();
  setupFocusMode();
  setupHud();
  setupLayoutReset();
  setupExport();
});
