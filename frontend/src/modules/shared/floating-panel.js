/**
 * frontend/src/modules/shared/floating-panel.js
 * ===============================================
 * Floating panels (Configuration, Results, the 3D view controls and the
 * periodic-table picker) shared by every simulator page, published as
 * window.FloatingPanel for the page controllers.
 *
 * Non-modal: no backdrop, no focus trap, several panels open at once, so the
 * simulation stays visible and interactive while parameters change. A side
 * panel at its home position makes room for itself (the page content narrows
 * beside it); dragged anywhere else it floats over the simulation, and a
 * double-click on its title bar sends it home. Open state, position and size
 * are remembered per page. Below 768 px every panel is a bottom sheet, one at
 * a time, resized by dragging its title bar.
 *
 * Markup contract: a panel is `<aside class="floating-panel floating-panel--
 * left|right|wide|view" id="<name>-panel">` with a `.floating-panel__header`
 * (holding `.floating-panel__actions` and a `.floating-panel__close`) and a
 * `.floating-panel__body`; its toggle is any `.fab[data-panel="<name>"]`.
 */

const page = location.pathname;
const openKey = (id) => `panel-open-${id}:${page}`;
const posKey  = (id) => `panel-pos-${id}:${page}`;
const sizeKey = (id) => `panel-size-${id}:${page}`;
const MIN_SIM_WIDTH = 600;  // narrowest the simulation may get to make room for panels
const PAGE_PAD = 32;        // .page-content side padding with no panel beside it
const GAP = 16;             // --fp-gap
const SHEET_SNAPS = [0.3, 0.62, 0.9];  // bottom-sheet heights, as fractions of the viewport
const isNarrow = () => window.matchMedia('(max-width: 768px)').matches;

const t = (key, fallback) => {
  const lang = localStorage.getItem('app-language') || 'pt';
  return window.TRANSLATIONS?.[lang]?.[key] || fallback;
};

const getEls = (id) => ({
  panel: document.getElementById(`${id}-panel`),
  fab: document.querySelector(`.fab[data-panel="${id}"]`),
});
const idOf = (panel) => panel.id.replace(/-panel$/, '');
const allPanels = () => document.querySelectorAll('.floating-panel');
const isView = (panel) => panel.classList.contains('floating-panel--view');
// The wide panel (periodic table) is a transient picker: it is never
// re-opened on load and chemistry.js opens/closes it itself.
const remembers = (panel) => !panel.classList.contains('floating-panel--wide');
const hasRoom = (panel) => ['left', 'right'].some(side =>
  panel.classList.contains(`floating-panel--${side}`) && document.body.classList.contains(`fp-room-${side}`));

const readJSON = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    localStorage.removeItem(key);
    return null;
  }
};

function scheduleResize() {
  // The page width changed: let the padding transition finish, then force
  // Three.js/Plotly to recompute size.
  setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
}

// Gives each open, undragged side panel its own column of the page — config
// first, then results — as long as the simulation keeps MIN_SIM_WIDTH. A
// panel that doesn't fit keeps floating over it.
let room = `${PAGE_PAD}/${PAGE_PAD}`;
function updateRoom() {
  // From --content-left rather than .main-content's box: on sidebar toggles
  // its margin is still mid-transition.
  const contentLeft = parseFloat(getComputedStyle(document.body).getPropertyValue('--content-left')) || 0;
  const width = document.documentElement.clientWidth - contentLeft;
  const pad = { left: PAGE_PAD, right: PAGE_PAD };
  ['left', 'right'].forEach(side => {
    const panel = document.querySelector(`.floating-panel--${side}.is-open`);
    const need = panel ? panel.offsetWidth + 2 * GAP : 0;
    const other = pad[side === 'left' ? 'right' : 'left'];
    const fits = !!panel && !panel.style.left && !isNarrow() && width - need - other >= MIN_SIM_WIDTH;
    document.body.classList.toggle(`fp-room-${side}`, fits);
    if (fits) {
      pad[side] = need;
      document.body.style.setProperty(`--fp-room-${side}`, `${panel.offsetWidth}px`);
    }
  });
  const next = `${pad.left}/${pad.right}`;
  if (next !== room) { room = next; scheduleResize(); }
}

function updateScrollShadow(body) {
  const fade = body.querySelector('.panel-scroll-fade');
  if (!fade) return;
  const atBottom = (body.scrollHeight - body.clientHeight <= 10) || (body.scrollTop + body.clientHeight >= body.scrollHeight - 16);
  fade.classList.toggle('hidden', atBottom);
}

function raise(panel) {
  allPanels().forEach(p => p.classList.toggle('is-front', p === panel));
}

// Moves a panel to viewport coordinates, clamped so its title bar can never
// leave the screen.
function place(panel, left, top) {
  const x = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - panel.offsetWidth));
  const y = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 56));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';   // the view panel is anchored by its bottom edge
  panel.style.maxHeight = `${window.innerHeight - y - 16}px`;
}

function resetPosition(panel) {
  ['left', 'top', 'right', 'bottom', 'max-height', 'width', 'height', '--sheet-h', '--sheet-max']
    .forEach(p => panel.style.removeProperty(p));
  localStorage.removeItem(posKey(idOf(panel)));
  localStorage.removeItem(sizeKey(idOf(panel)));
  updateRoom();
}

function open(id, { focus = true, remember = true } = {}) {
  const { panel, fab } = getEls(id);
  if (!panel) return;

  // On phones every panel is a full-width bottom sheet; two would stack.
  if (isNarrow()) {
    allPanels().forEach(p => { if (p !== panel && p.classList.contains('is-open')) close(idOf(p)); });
  }

  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  fab?.setAttribute('aria-expanded', 'true');
  fab?.classList.remove('fab--has-update');
  raise(panel);
  updateRoom();
  if (remember && remembers(panel)) localStorage.setItem(openKey(id), 'true');
  requestAnimationFrame(() => panel.querySelectorAll('.floating-panel__body').forEach(updateScrollShadow));

  if (focus) panel.querySelector('button, input, select, textarea, [tabindex]')?.focus({ preventScroll: true });
}

function close(id, { remember = true } = {}) {
  const { panel, fab } = getEls(id);
  if (!panel?.classList.contains('is-open')) return;

  const hadFocus = panel.contains(document.activeElement);
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  fab?.setAttribute('aria-expanded', 'false');
  updateRoom();
  if (remember && remembers(panel)) localStorage.setItem(openKey(id), 'false');
  if (hadFocus) fab?.focus();
}

function toggle(id) {
  const { panel } = getEls(id);
  if (panel?.classList.contains('is-open')) close(id); else open(id);
}

function toggleCollapse(panel) {
  const collapsed = panel.classList.toggle('is-collapsed');
  panel.querySelector('.floating-panel__min')?.setAttribute('aria-expanded', String(!collapsed));
}

// Flags the panel's FAB with a pulsing dot — used to signal a fresh result is
// available when the user hasn't opened the panel to see it.
function markUpdated(id) {
  const { panel, fab } = getEls(id);
  if (!fab || panel?.classList.contains('is-open')) return;
  fab.classList.add('fab--has-update');
}

/**
 * Open the panel as saved, or — with nothing saved — the way a first visit
 * should see it: side panels only when they get their own column beside the
 * simulation, the small 3D-view panel always (it replaced an overlay that was
 * always on screen), the periodic-table picker never.
 */
function restoreOpenState(panel, { useSaved = true } = {}) {
  if (!remembers(panel) || isNarrow()) return;
  const id = idOf(panel);
  const saved = useSaved ? localStorage.getItem(openKey(id)) : null;
  if (saved === 'true') {
    open(id, { focus: false });
  } else if (saved === null) {
    open(id, { focus: false, remember: false });
    if (!isView(panel) && !hasRoom(panel)) close(id, { remember: false });
  }
}

/** Every panel back to its home position, default size and default state. */
function resetLayout() {
  allPanels().forEach(panel => {
    resetPosition(panel);
    localStorage.removeItem(openKey(idOf(panel)));
    if (panel.classList.contains('is-collapsed')) toggleCollapse(panel);
    close(idOf(panel), { remember: false });
  });
  allPanels().forEach(panel => restoreOpenState(panel, { useSaved: false }));
}

function enableDrag(panel) {
  const header = panel.querySelector('.floating-panel__header');
  if (!header) return;

  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
    const rect = panel.getBoundingClientRect();
    const narrow = isNarrow();
    let moved = false;

    const onMove = (ev) => {
      // A plain click on the header must not freeze the CSS home position into
      // pixels — only start dragging after a few px.
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      panel.classList.add('is-dragging');
      if (narrow) {
        // Bottom sheet: the title bar is a handle that sets the sheet height.
        const h = Math.min(window.innerHeight * 0.92, Math.max(64, rect.height + (e.clientY - ev.clientY)));
        panel.style.setProperty('--sheet-h', `${h}px`);
        panel.style.setProperty('--sheet-max', `${h}px`);
      } else {
        place(panel, ev.clientX - (e.clientX - rect.left), ev.clientY - (e.clientY - rect.top));
      }
    };

    header.setPointerCapture(e.pointerId);
    header.addEventListener('pointermove', onMove);
    header.addEventListener('lostpointercapture', () => {
      header.removeEventListener('pointermove', onMove);
      panel.classList.remove('is-dragging');
      if (!moved) return;

      if (narrow) {
        // Snap to the nearest preset height; dragged nearly shut, close it.
        const vh = window.innerHeight;
        const h = panel.getBoundingClientRect().height;
        if (h < vh * 0.18) {
          panel.style.removeProperty('--sheet-h');
          panel.style.removeProperty('--sheet-max');
          close(idOf(panel));
          return;
        }
        const snap = SHEET_SNAPS.reduce((best, f) => (Math.abs(f * vh - h) < Math.abs(best * vh - h) ? f : best));
        panel.style.setProperty('--sheet-h', `${snap * vh}px`);
        panel.style.setProperty('--sheet-max', `${snap * vh}px`);
        return;
      }

      const r = panel.getBoundingClientRect();
      localStorage.setItem(posKey(idOf(panel)), JSON.stringify({ left: r.left, top: r.top }));
      updateRoom();  // it left home: give its column back to the simulation
    }, { once: true });
  });

  header.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button') && !isNarrow()) resetPosition(panel);
  });
}

function setupPanel(panel) {
  const id = idOf(panel);
  const actions = panel.querySelector('.floating-panel__actions');
  const closeBtn = panel.querySelector('.floating-panel__close');

  closeBtn?.addEventListener('click', () => close(id));

  // Minimize button, added here so no template has to carry it.
  if (actions) {
    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'floating-panel__min';
    minBtn.textContent = '–';
    minBtn.setAttribute('data-i18n-title', 'panel-minimize');
    minBtn.title = t('panel-minimize', 'Minimizar / restaurar');
    minBtn.setAttribute('aria-label', minBtn.title);
    minBtn.setAttribute('aria-expanded', 'true');
    minBtn.addEventListener('click', () => toggleCollapse(panel));
    actions.insertBefore(minBtn, closeBtn);
  }

  panel.addEventListener('pointerdown', () => raise(panel));
  enableDrag(panel);

  const pos = readJSON(posKey(id));
  if (pos) place(panel, pos.left, pos.top);
  const size = readJSON(sizeKey(id));
  if (size) Object.assign(panel.style, { width: size.w || '', height: size.h || '' });

  // Scroll shadow: sticky bottom-fade signalling more content below.
  panel.querySelectorAll('.floating-panel__body').forEach(body => {
    if (!body.querySelector('.panel-scroll-fade')) {
      const fade = document.createElement('div');
      fade.className = 'panel-scroll-fade';
      body.appendChild(fade);
    }
    updateScrollShadow(body);
    body.addEventListener('scroll', () => updateScrollShadow(body), { passive: true });
  });

  // A hand-resized panel: remember its size, refit the Plotly charts inside it
  // (they only listen to window resizes), resize its column, refresh the shadow.
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!isNarrow() && (panel.style.width || panel.style.height)) {
        localStorage.setItem(sizeKey(id), JSON.stringify({ w: panel.style.width, h: panel.style.height }));
      }
      panel.querySelectorAll('.js-plotly-plot').forEach(el => window.Plotly?.Plots.resize(el));
      panel.querySelectorAll('.floating-panel__body').forEach(updateScrollShadow);
      if (panel.classList.contains('is-open')) updateRoom();
    }, 120);
  }).observe(panel);

  restoreOpenState(panel);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.fab[data-panel]').forEach(fab => {
    fab.addEventListener('click', () => toggle(fab.dataset.panel));
  });
  allPanels().forEach(setupPanel);

  // Keep dragged panels on screen when the window shrinks, and re-share the
  // page width (this also covers the sidebar toggle and focus mode, which
  // fire a resize once their transition ends).
  window.addEventListener('resize', () => {
    allPanels().forEach(p => { if (p.style.left) place(p, parseFloat(p.style.left), parseFloat(p.style.top)); });
    updateRoom();
  });

  document.addEventListener('keydown', (e) => {
    // Esc closes the floating panel holding focus, else the front one.
    if (e.key === 'Escape') {
      const target = document.activeElement?.closest('.floating-panel.is-open')
        || document.querySelector('.floating-panel.is-open.is-front');
      if (target) close(idOf(target));
      return;
    }
    // C / R / V toggle the config, results and 3D-view panels — ignored while
    // typing in a field.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const id = { c: 'config', r: 'results', v: 'view' }[e.key.toLowerCase()];
    const { panel } = id ? getEls(id) : {};
    if (panel && panel.style.display !== 'none') toggle(id);
  });
});

export const FloatingPanel = { open, close, toggle, markUpdated, resetLayout };
window.FloatingPanel = FloatingPanel;
