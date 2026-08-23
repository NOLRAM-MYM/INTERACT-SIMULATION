/**
 * frontend/src/pages/fluids.js
 * ==============================
 * Vite page bundle entry point for the Fluid Mechanics dashboard.
 *
 * Referenced as a Rollup input in vite.config.js and loaded by
 * templates/app_fluids/pipe_flow.html via {% vite_asset 'pages/fluids.js' %}.
 *
 * This is a port of the ~760-line inline controller that used to live in that
 * template. Behaviour is preserved exactly, including debounced live
 * recalculation, comparison mode, and the auto-vs-explicit distinction that
 * keeps continuous typing from flashing the loading overlay.
 *
 * No styles are imported here. base.html carries the complete stylesheet for
 * the app; the bundle ships behaviour only.
 */

import { fluidsAPI, describeApiError, latestOnly, isSuperseded } from '../modules/shared/api.js';
import { showToast, showLoading, hideLoading, retranslate } from '../modules/shared/utils.js';
import { PlotlyCharts } from '../modules/fluids/fluids-plotly.js';
import { ThreePipe } from '../modules/fluids/fluids-three.js';

// Only the newest in-flight solve is allowed to repaint the page.
const solvePipeFlow = latestOnly((params, config) => fluidsAPI.calculate(params, config));

// -----------------------------------------------------------------
// COMPARISON MODE — pinned reference result, read by the Plotly
// velocity-profile chart when rendering.
// -----------------------------------------------------------------
let referenceResult = null;
let lastResult = null;

// -----------------------------------------------------------------
// FORM MANAGER
// -----------------------------------------------------------------
const FormManager = {
  form: null,
  presetSelect: null,
  calculateBtn: null,

  async init() {
    this.form = document.getElementById('pipe-flow-form');
    this.presetSelect = document.getElementById('fluid-preset');
    this.calculateBtn = document.getElementById('calculate-btn');
    if (!this.form) return;

    // Load schema to populate presets. The schema is generated from
    // PipeFlowInputSerializer server-side (apps/core/schema.py), so the
    // presets and field bounds always match what the API will accept.
    try {
      const schema = await fluidsAPI.getSchema();
      this.populatePresets(schema.preset_fluids || []);
    } catch (e) {
      console.warn('Schema load failed:', e);
    }

    // Preset selector listener
    this.presetSelect?.addEventListener('change', (e) => {
      const presets = JSON.parse(this.presetSelect.dataset.presets || '[]');
      const preset  = presets.find(p => p.name === e.target.value);
      if (preset) {
        document.getElementById('density_kg_m3').value   = preset.density;
        document.getElementById('viscosity_mpa_s').value = preset.viscosity;
        showToast(`Loaded: ${preset.name}`, 'info', 2500);
        this.handleSubmit(true);
      }
    });

    // Form submit
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Live recalculation: debounced re-solve as the user edits any numeric
    // input, so the flow results update without an explicit "Calculate"
    // click. The button remains as an immediate fallback.
    let debounceTimer = null;
    this.form.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.handleSubmit(true), 350);
      });
    });
  },

  populatePresets(presets) {
    if (!this.presetSelect) return;
    this.presetSelect.dataset.presets = JSON.stringify(presets);
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      this.presetSelect.appendChild(opt);
    });
  },

  getFormData() {
    return {
      diameter_mm:          parseFloat(document.getElementById('diameter_mm').value),
      length_m:             parseFloat(document.getElementById('length_m').value),
      roughness_mm:         parseFloat(document.getElementById('roughness_mm').value),
      density_kg_m3:        parseFloat(document.getElementById('density_kg_m3').value),
      viscosity_mpa_s:      parseFloat(document.getElementById('viscosity_mpa_s').value),
      flow_rate_lpm:        parseFloat(document.getElementById('flow_rate_lpm').value),
      num_elbows_90:        parseInt(document.getElementById('num_elbows_90').value, 10) || 0,
      num_gate_valves_open: parseInt(document.getElementById('num_gate_valves_open').value, 10) || 0,
      num_check_valves:     parseInt(document.getElementById('num_check_valves').value, 10) || 0,
    };
  },

  setLoading(loading) {
    if (this.calculateBtn) this.calculateBtn.disabled = loading;
    const text = document.getElementById('btn-text');
    const icon = document.getElementById('btn-icon');
    if (text) text.textContent = loading ? 'Computing…' : 'Calculate';
    if (icon) icon.textContent = loading ? '⏳' : '▶';
  },

  async handleSubmit(auto = false) {
    const data = this.getFormData();

    // Basic client-side validation
    if (isNaN(data.diameter_mm) || data.diameter_mm <= 0) {
      if (!auto) showToast('Diameter must be a positive number.', 'error');
      return;
    }
    if (isNaN(data.flow_rate_lpm) || data.flow_rate_lpm < 0) {
      if (!auto) showToast('Flow rate must be non-negative.', 'error');
      return;
    }

    // Auto (debounced, live-input) recalculations skip the full-screen
    // overlay and success toast — those are for the explicit "Calculate"
    // click — so continuous typing doesn't flash the UI.
    this.setLoading(true);
    if (!auto) showLoading('Running Darcy-Weisbach analysis…');

    let result;
    try {
      // The axios interceptor in shared/api.js already unwraps the
      // {"status": "success", "data": ...} envelope.
      result = await solvePipeFlow(data);
      lastResult = result;
    } catch (err) {
      // A superseded request is not a failure — a newer solve is already running.
      if (isSuperseded(err)) return;
      console.error('Calculation error:', err);
      showToast(`Error: ${describeApiError(err, 'Server error')}`, 'error', 6000);
      this.setLoading(false);
      if (!auto) hideLoading();
      return;
    }

    // Rendering sits outside the request try/catch so a viewport failure is
    // not reported as a failed calculation.
    try {
      UIUpdater.updateAll(result);
      PlotlyCharts.renderPressureDrop(result, data.flow_rate_lpm);
      PlotlyCharts.renderVelocityProfile(result, referenceResult);
      ThreePipe.updateParticles(result, data.diameter_mm);
      window.FloatingPanel?.markUpdated('results');

      if (!auto) showToast('Calculation complete!', 'success');
    } catch (err) {
      console.error('Rendering failed after a successful calculation:', err);
      showToast('Results computed, but the viewport failed to render.', 'error');
    } finally {
      this.setLoading(false);
      if (!auto) hideLoading();
    }
  },
};

// -----------------------------------------------------------------
// UI UPDATER
// -----------------------------------------------------------------
const UIUpdater = {
  updateAll(result) {
    // Update Workbench Title tag regime dynamically
    const statusTag = document.getElementById('workbench-status');
    if (statusTag) {
      statusTag.textContent = result.flow_regime;
      statusTag.className = 'regime-tag ' + (
        result.flow_regime === 'Laminar' ? 'regime-tag--laminar' :
        result.flow_regime === 'Turbulent' ? 'regime-tag--turbulent' : 'regime-tag--transition'
      );
    }

    // KPI Cards
    this.set('kpi-velocity-val', result.velocity_m_s.toFixed(3));
    this.set('kpi-re-val',       this.formatNumber(result.reynolds_number));
    this.set('kpi-friction-val', result.friction_factor.toFixed(6));
    this.set('kpi-dp-major-val', this.formatNumber(result.pressure_drop_major_pa));
    this.set('kpi-dp-minor-val', this.formatNumber(result.pressure_drop_minor_pa));
    this.set('kpi-dp-total-val', result.pressure_drop_total_bar.toFixed(5));

    // Top badges
    this.set('regime-value', result.flow_regime);
    this.set('re-value', this.formatNumber(result.reynolds_number));
    this.set('dp-value', result.pressure_drop_total_bar.toFixed(4) + ' bar');

    // Results Table
    this.set('tbl-velocity',     result.velocity_m_s.toFixed(4) + ' m/s');
    this.set('tbl-re',           this.formatNumber(result.reynolds_number));
    this.set('tbl-regime',       result.flow_regime);
    this.set('tbl-ff',           result.friction_factor.toFixed(8));
    this.set('tbl-ffmethod',     result.friction_method);
    this.set('tbl-dp-major',     this.formatNumber(result.pressure_drop_major_pa));
    this.set('tbl-dp-minor',     this.formatNumber(result.pressure_drop_minor_pa));
    this.set('tbl-dp-total-pa',  this.formatNumber(result.pressure_drop_total_pa));
    this.set('tbl-dp-total-bar', result.pressure_drop_total_bar.toFixed(6));

    // Hagen-Poiseuille (laminar only)
    const hpCard = document.getElementById('hp-card');
    if (hpCard) {
      if (result.hagen_poiseuille_exact && result.flow_regime === 'Laminar') {
        hpCard.style.display = 'block';
        const hpEl = document.getElementById('hp-formula');
        if (hpEl) {
          hpEl.innerHTML = `\\[ \\Delta P = ${result.hagen_poiseuille_exact} \\text{ Pa} \\]`;
          window.MathJax?.typesetPromise?.([hpEl]);
        }
      } else {
        hpCard.style.display = 'none';
      }
    }

    // Warnings
    const wContainer = document.getElementById('warnings-container');
    if (wContainer) {
      if (result.warnings && result.warnings.length > 0) {
        wContainer.style.display = 'block';
        wContainer.innerHTML = result.warnings
          .map(w => `<div class="warning-item"><span>⚠</span><span>${w}</span></div>`)
          .join('');
      } else {
        wContainer.style.display = 'none';
      }
    }
  },

  set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  },

  formatNumber(n) {
    if (n === undefined || n === null) return '—';
    if (Math.abs(n) >= 1e6)  return n.toExponential(3);
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return n.toFixed(2);
  },
};

// -----------------------------------------------------------------
// COMPARISON MODE TOGGLE
// -----------------------------------------------------------------
function initComparisonMode() {
  const refBtn = document.getElementById('btn-toggle-reference');
  if (!refBtn) return;

  const refBtnLabel = () => {
    const lang = localStorage.getItem('app-language') || 'pt';
    const T = window.TRANSLATIONS?.[lang] || {};
    return referenceResult
      ? (T['fluids-cmp-btn-clear'] || '🗑 Clear Reference')
      : (T['fluids-cmp-btn-fix'] || '📌 Fix as Reference');
  };

  refBtn.addEventListener('click', () => {
    if (referenceResult) {
      referenceResult = null;
    } else if (lastResult) {
      referenceResult = lastResult;
    } else {
      return;
    }
    // Once toggled the label is state-dependent — stop translatePage from
    // resetting it back to the "fix" label on the next language switch.
    refBtn.removeAttribute('data-i18n');
    refBtn.textContent = refBtnLabel();
    PlotlyCharts.renderVelocityProfile(lastResult, referenceResult);
  });
}

// -----------------------------------------------------------------
// BOOT
// -----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  await FormManager.init();
  ThreePipe.init();
  initComparisonMode();

  // Re-apply translations once the controllers above have built their DOM. The
  // template's inline i18n block already merged this page's dictionary and ran
  // translatePage, but it did so before this module executed, so anything
  // rendered by init() still carries its default-language text.
  //
  // This has to be the last statement *inside* this handler, not a second
  // DOMContentLoaded listener: the handler is async, so it yields at the
  // `await` above and any separately-registered listener would run there —
  // before ThreePipe.init() and before the schema-driven presets exist.
  retranslate();
});
