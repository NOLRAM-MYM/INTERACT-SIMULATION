/**
 * frontend/src/pages/materials.js
 * ==============================
 * Vite page bundle entry point for the Materials & FEA dashboard.
 *
 * Ported from the inline <script> that used to live in templates/app_materials/index.html.
 * Only the shared UI helpers are imported; Three.js and Plotly stay on the
 * globals (see below).
 *
 * The page's i18n dictionary stays inline in the template on purpose: it must
 * register its DOMContentLoaded listener before base.html's translatePage
 * listener, which a deferred module cannot do.
 */

// THREE, OrbitControls and Plotly are read from the globals installed by the
// vendored <script> tags in the template, not imported from npm. The vendored
// three build is r128 (2021) while package.json resolves to 0.166 — a jump of
// ~38 revisions that includes r155's redefinition of light intensity units, so
// the two are not interchangeable and this code targets the vendored one.
// (The vendored plotly is plotly.js-dist@2.33.0, the same major version npm
// resolves to; only three actually differs.)

import { showToast, showLoading, hideLoading, retranslate } from '../modules/shared/utils.js';
// The shared axios client (CSRF header, 30 s timeout, envelope unwrapping and
// error normalisation) replaces the hand-rolled fetch wrapper this page used to
// carry — one of four near-identical copies across the page bundles.
import { materialsAPI, describeApiError, latestOnly, isSuperseded } from '../modules/shared/api.js';
import {
  createAnimationLoop,
  disposeAndRemove,
  resizeRendererToCanvas,
} from '../modules/shared/three-utils.js';

// Only the newest in-flight solve is allowed to repaint the page.
const solveBeam = latestOnly((params, config) => materialsAPI.beamDeflection(params, config));

// -----------------------------------------------------------------
// 0. COMPARISON MODE — pinned reference result, shared by the Plotly
//    deflection-curve chart (read when rendering).
// -----------------------------------------------------------------
let referenceResult = null;
let lastResult = null;
let lastLength = null;

// Young's modulus [GPa] and the strength used for the safety factor [MPa].
// Plain concrete in bending fails in tension (≈ 3 MPa), not at its 30 MPa
// compressive strength, so that is the number the check needs.
const MATERIAL_PRESETS = {
  steel:    { E: 200.0, sy: 250 },
  aluminum: { E: 70.0,  sy: 276 },
  concrete: { E: 30.0,  sy: 3.0 },
  wood:     { E: 11.0,  sy: 40 },
};

/** Translated text for `key`, with `{v}` replaced by `value` when given. */
function tr(key, fallback, value) {
  const lang = localStorage.getItem('app-language') || 'pt';
  const text = window.TRANSLATIONS?.[lang]?.[key] || fallback;
  return value === undefined ? text : text.replace('{v}', value);
}

const fmt = (v, digits = 2) => (v == null ? '—' : Number(v).toFixed(digits));

// -----------------------------------------------------------------
// 2. FORM & INPUT MANAGER
// -----------------------------------------------------------------
const FormManager = {
  form: document.getElementById('beam-form'),
  shapeSelect: document.getElementById('beam_shape'),
  presetSelect: document.getElementById('material-preset'),
  calculateBtn: document.getElementById('calculate-btn'),

  init() {
    // Cross section type switcher
    this.shapeSelect.addEventListener('change', (e) => {
      ['rectangular', 'circular', 'manual'].forEach(shape => {
        const group = document.getElementById(`${shape}-inputs`);
        if (group) group.style.display = e.target.value === shape ? 'block' : 'none';
      });
      this.handleSubmit(true);
    });

    // Material preset selector: stiffness and strength together. Editing
    // either by hand flips the selector to "custom" so it never names a
    // material the numbers no longer describe.
    const eInput = document.getElementById('youngs_modulus_gpa');
    const syInput = document.getElementById('yield_strength_mpa');
    this.presetSelect.addEventListener('change', (e) => {
      const preset = MATERIAL_PRESETS[e.target.value];
      if (!preset) return;
      eInput.value = preset.E;
      if (syInput) syInput.value = preset.sy;
      showToast(`E = ${preset.E} GPa · σy = ${preset.sy} MPa`, 'info', 2000);
      this.handleSubmit(true);
    });
    [eInput, syInput].forEach(input => input?.addEventListener('input', () => {
      this.presetSelect.value = 'custom';
    }));

    // Load distribution selector
    document.getElementById('load_type').addEventListener('change', () => {
      this.handleSubmit(true);
    });

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Live recalculation: debounced re-solve as the user edits/drags any
    // numeric input, so the deflection curve updates without an explicit
    // click on "Solve Deflection". The button remains as an immediate
    // fallback.
    let debounceTimer = null;
    this.form.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.handleSubmit(true), 350);
      });
    });

    // Run initial solve
    this.handleSubmit();
  },

  getInputs() {
    const num = (id) => {
      const v = parseFloat(document.getElementById(id)?.value);
      return Number.isFinite(v) ? v : null;
    };
    const length = num('length_m');
    const E = num('youngs_modulus_gpa');
    const load = num('load_kn');
    const load_type = document.getElementById('load_type').value;

    // Section properties: I, extreme-fibre distance c (for σ = M·c/I), area,
    // and the width/height the 3D view draws (a circle is drawn as its
    // bounding square, which keeps the depth — what bending cares about).
    let I, c = null, area = 0, width_m = null, height_m = null;
    const shape = this.shapeSelect.value;
    if (shape === 'rectangular') {
      width_m = num('width_mm') / 1000.0;
      height_m = num('height_mm') / 1000.0;
      I = (width_m * Math.pow(height_m, 3)) / 12.0;
      c = height_m / 2;
      area = width_m * height_m;
    } else if (shape === 'circular') {
      const d = num('diameter_mm') / 1000.0;
      I = Math.PI * Math.pow(d, 4) / 64.0;
      c = d / 2;
      area = Math.PI * d * d / 4.0;
      width_m = height_m = d;
    } else {
      I = num('second_moment_m4');
      const fibre = num('fibre_mm');
      c = fibre && fibre > 0 ? fibre / 1000.0 : null;
    }

    const sy = num('yield_strength_mpa');
    return {
      length_m: length,
      youngs_modulus_gpa: E,
      second_moment_m4: I,
      load_kn: load,
      load_type: load_type,
      extreme_fibre_m: c,
      yield_strength_mpa: sy && sy > 0 ? sy : null,
      area_m2: area,
      width_m: width_m,
      height_m: height_m,
    };
  },

  async handleSubmit(auto = false) {
    const inputs = this.getInputs();

    this.calculateBtn.disabled = true;
    // Auto (debounced, live-input) recalculations skip the full-screen
    // overlay and success toast — those are for the explicit "Solve"
    // click — so continuous typing doesn't flash the UI.
    if (!auto) {
      document.getElementById('btn-text').textContent = 'Solving…';
      showLoading('Solving Euler-Bernoulli beam equations…');
    }

    let result;
    try {
      // Already unwrapped from the {status, data} envelope by the client.
      result = await solveBeam(inputs);
      lastResult = result;
      lastLength = inputs.length_m;
    } catch (e) {
      // A superseded request is not a failure — a newer solve is already running.
      if (isSuperseded(e)) return;
      console.error(e);
      showToast(
        describeApiError(e, 'Error calculating deflection. Check input values.'),
        'error',
      );
      this.calculateBtn.disabled = false;
      if (!auto) {
        document.getElementById('btn-text').textContent = 'Solve Deflection';
        hideLoading();
      }
      return;
    }

    // Rendering is deliberately outside the request try/catch. A dead 3D
    // viewport (init() bailed, so this.scene is null) used to throw here, get
    // caught by the block above, and report "Error calculating deflection" for
    // a calculation that had in fact succeeded.
    try {
      UIUpdater.updateAll(inputs, result);
      FormulaExplainer.render(inputs, result);
      PlotlyChart.render(result, inputs.length_m);
      ThreeBeam.update(result, inputs);
      window.FloatingPanel?.markUpdated('results');

      if (!auto) showToast('Beam equations solved successfully!', 'success');
    } catch (e) {
      console.error('Rendering failed after a successful calculation:', e);
      showToast('Results computed, but the viewport failed to render.', 'error');
    } finally {
      this.calculateBtn.disabled = false;
      if (!auto) {
        document.getElementById('btn-text').textContent = 'Solve Deflection';
        hideLoading();
      }
    }
  }
};

// -----------------------------------------------------------------
// 3. UI UPDATER
// -----------------------------------------------------------------
const UIUpdater = {
  updateAll(inputs, result) {
    const EI = inputs.youngs_modulus_gpa * 1e9 * inputs.second_moment_m4;
    
    // Workbench status: strength first (does it yield?), then serviceability
    // (does it sag too much?). It used to turn red for any deflection above
    // 0.01 mm, i.e. for every beam.
    const statusTag = document.getElementById('workbench-status');
    if (statusTag) {
      const sf = result.safety_factor;
      let text, level;
      if (sf != null && sf < 1) {
        text = `${tr('materials-status-yield', 'Escoamento!')} SF ${sf.toFixed(2)}`;
        level = 'turbulent';
      } else if (!result.deflection_ok) {
        text = tr('materials-status-sag', 'Flecha excessiva');
        level = 'transition';
      } else if (sf != null) {
        text = `SF ${sf.toFixed(2)}`;
        level = sf < 1.5 ? 'transition' : 'laminar';
      } else {
        text = `δ ${result.max_deflection_mm.toFixed(2)} mm`;
        level = 'laminar';
      }
      statusTag.textContent = text;
      statusTag.className = `regime-tag regime-tag--${level}`;
    }

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const stress = result.max_stress_mpa;
    setText('kpi-moment-val', fmt(result.max_moment_nm / 1000));
    setText('kpi-stress-val', stress == null ? '—' : fmt(stress, 1));
    setText('kpi-sf-val', result.safety_factor == null ? '—' : fmt(result.safety_factor));

    const ratio = result.span_deflection_ratio;
    setText('tbl-service', ratio == null ? '—'
      : `L/${Math.round(ratio)} — ${result.deflection_ok ? tr('materials-service-ok', 'atende') : tr('materials-service-fail', 'excede o limite')} (L/${result.deflection_limit_ratio})`);
    const r = result.reactions || {};
    setText('tbl-reactions', r.fixed_moment_nm
      ? `R = ${fmt(r.left_n / 1000)} kN · M_eng = ${fmt(r.fixed_moment_nm / 1000)} kN·m`
      : `R₁ = ${fmt(r.left_n / 1000)} kN · R₂ = ${fmt(r.right_n / 1000)} kN`);
    setText('tbl-max-shear', `${fmt(result.max_shear_n / 1000)} kN`);
    setText('tbl-max-moment', `${fmt(result.max_moment_nm / 1000)} kN·m`);
    setText('tbl-stress', stress == null ? tr('materials-na', '— (informe c)') : `${fmt(stress, 1)} MPa`);
    setText('tbl-sf', result.safety_factor == null ? '—' : fmt(result.safety_factor));

    document.getElementById('rigidity-value').textContent = EI.toExponential(3) + ' N·m²';
    document.getElementById('deflection-value').textContent = result.max_deflection_mm.toFixed(3) + ' mm';

    document.getElementById('kpi-rigidity-val').textContent = EI.toExponential(2);
    document.getElementById('kpi-area-val').textContent = inputs.area_m2 > 0 ? inputs.area_m2.toFixed(4) : 'Unknown';
    document.getElementById('kpi-deflection-val').textContent = result.max_deflection_mm.toFixed(3);

    // Table
    document.getElementById('tbl-length').textContent = inputs.length_m.toFixed(1) + ' m';
    document.getElementById('tbl-modulus').textContent = inputs.youngs_modulus_gpa.toFixed(1) + ' GPa';
    document.getElementById('tbl-moment').textContent = inputs.second_moment_m4.toExponential(4) + ' m⁴';
    document.getElementById('tbl-rigidity').textContent = EI.toExponential(4) + ' N·m²';
    document.getElementById('tbl-load').textContent = inputs.load_kn.toFixed(1) + ' kN';
    const loadTypeLabels = {
      point_centre: 'Centered Point (simply supported)',
      uniform: 'Uniform (UDL, simply supported)',
      cantilever_point: 'Cantilever — Point at Free End',
      cantilever_uniform: 'Cantilever — Uniform (UDL)',
    };
    document.getElementById('tbl-load-type').textContent = loadTypeLabels[inputs.load_type] || inputs.load_type;
    document.getElementById('tbl-max-deflection').textContent = result.max_deflection_mm.toFixed(4) + ' mm';
  }
};

// -----------------------------------------------------------------
// 3b. FORMULA STEP-BY-STEP EXPLAINER
// -----------------------------------------------------------------
// Mirrors the exact dispatch in BeamDeflectionService.compute()
// (apps/app_materials/services.py) — one template per load_type, so the
// panel always shows the same formula the backend actually evaluated.
const FormulaExplainer = {
  render(inputs, result) {
    const container = document.getElementById('formula-steps');
    if (!container) return;

    const P = inputs.load_kn * 1000;       // kN -> N
    const L = inputs.length_m;
    const E = inputs.youngs_modulus_gpa * 1e9; // GPa -> Pa
    const I = inputs.second_moment_m4;
    const EI = E * I;
    const deltaM = result.max_deflection_mm / 1000;
    const q = P / L;

    let steps;
    switch (inputs.load_type) {
      case 'uniform':
        steps = [
          ['q = P / L', `${P.toExponential(3)} N / ${L.toFixed(3)} m = ${q.toExponential(3)} N/m`],
          ['δ_max = 5qL⁴ / (384·EI)', `5 × ${q.toExponential(3)} × ${L.toFixed(3)}⁴ / (384 × ${EI.toExponential(3)})`],
        ];
        break;
      case 'cantilever_point':
        steps = [
          ['δ_max = PL³ / (3·EI)', `${P.toExponential(3)} × ${L.toFixed(3)}³ / (3 × ${EI.toExponential(3)})`],
        ];
        break;
      case 'cantilever_uniform':
        steps = [
          ['q = P / L', `${P.toExponential(3)} N / ${L.toFixed(3)} m = ${q.toExponential(3)} N/m`],
          ['δ_max = qL⁴ / (8·EI)', `${q.toExponential(3)} × ${L.toFixed(3)}⁴ / (8 × ${EI.toExponential(3)})`],
        ];
        break;
      default: // point_centre
        steps = [
          ['δ_max = PL³ / (48·EI)', `${P.toExponential(3)} × ${L.toFixed(3)}³ / (48 × ${EI.toExponential(3)})`],
        ];
    }

    const momentFormula = {
      point_centre: 'M_max = PL / 4',
      uniform: 'M_max = qL² / 8',
      cantilever_point: 'M_max = PL (no engaste)',
      cantilever_uniform: 'M_max = qL² / 2 (no engaste)',
    }[inputs.load_type] || 'M_max';

    const lines = [
      ['E·I (flexural rigidity)', `${E.toExponential(3)} Pa × ${I.toExponential(3)} m⁴ = ${EI.toExponential(3)} N·m²`],
      ...steps,
      [momentFormula, `${(result.max_moment_nm / 1000).toFixed(3)} kN·m`],
    ];
    if (result.max_stress_mpa != null) {
      const c = inputs.extreme_fibre_m;
      lines.push(['σ_max = M·c / I', `${result.max_moment_nm.toExponential(3)} × ${c.toExponential(3)} / ${I.toExponential(3)} = ${result.max_stress_mpa.toFixed(2)} MPa`]);
      if (result.safety_factor != null) {
        lines.push(['SF = σy / σ_max', `${inputs.yield_strength_mpa} / ${result.max_stress_mpa.toFixed(2)} = ${result.safety_factor.toFixed(2)}`]);
      }
    }
    lines.push(['δ_max', `${deltaM.toExponential(4)} m = ${result.max_deflection_mm.toFixed(4)} mm`]);

    container.innerHTML = lines.map(([label, value]) => `
      <div class="formula-steps__line">
        <span class="formula-steps__label">${label}</span>
        <span>${value}</span>
      </div>
    `).join('');
  }
};

// -----------------------------------------------------------------
// 4. PLOTLY CHART
// -----------------------------------------------------------------
const PlotlyChart = {
  rendered: false,
  // Which diagram is showing: deflection, moment, shear or stress.
  diagram: 'deflection',

  /**
   * y-values of the selected diagram for one result, in display units.
   * The service returns deflection as a positive downward magnitude; it is
   * negated so the curve sags below the axis like the 3D beam beside it.
   */
  series(result) {
    switch (this.diagram) {
      case 'moment': return result.moment_nm?.map(m => m / 1000);
      case 'shear':  return result.shear_n?.map(v => v / 1000);
      case 'stress': return result.stress_mpa;
      default:       return result.deflection_m.map(dy => -dy * 1000.0);
    }
  },

  render(result, L) {
    if (!result) return;
    // No stress without the extreme-fibre distance — fall back to deflection.
    if (this.diagram === 'stress' && !result.stress_mpa) this.diagram = 'deflection';
    document.querySelectorAll('.diagram-switch__btn').forEach(btn => {
      btn.classList.toggle('diagram-switch__btn--active', btn.dataset.diagram === this.diagram);
      if (btn.dataset.diagram === 'stress') btn.disabled = !result.stress_mpa;
    });

    const colours = { deflection: '#3b82f6', moment: '#f59e0b', shear: '#10b981', stress: '#ef4444' };
    const colour = colours[this.diagram];
    const traces = [{
      x: result.x_positions_m,
      y: this.series(result),
      mode: 'lines',
      name: tr('materials-trace-current', 'Atual'),
      line: { color: colour, width: 3, shape: this.diagram === 'shear' ? 'hv' : 'linear' },
      fill: 'tozeroy',
      fillcolor: `${colour}14`,
    }];

    // Comparison mode: overlay the pinned reference, faded and dashed.
    const refY = referenceResult && this.series(referenceResult);
    if (refY) {
      traces.push({
        x: referenceResult.x_positions_m,
        y: refY,
        mode: 'lines',
        name: tr('materials-trace-reference', 'Referência'),
        line: { color: '#94a3b8', width: 2, dash: 'dot' },
        opacity: 0.6,
      });
    }

    const yTitle = {
      deflection: tr('materials-axis-deflection', 'Deflexão (mm)'),
      moment: tr('materials-axis-moment', 'Momento fletor (kN·m)'),
      shear: tr('materials-axis-shear', 'Esforço cortante (kN)'),
      stress: tr('materials-axis-stress', 'Tensão na fibra extrema (MPa)'),
    }[this.diagram];

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  '#0d1526',
      font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 11 },
      margin: { t: 10, r: 16, b: 48, l: 64 },
      showlegend: !!refY,
      legend: { orientation: 'h', y: 1.12, x: 0 },
      xaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: tr('materials-axis-x', 'Posição na viga x (m)'), font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 },
        range: [0, L]
      },
      yaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.25)',
        title: { text: yTitle, font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 }
      }
    };

    // The yield line on the stress diagram, both signs (tension/compression).
    const sy = FormManager.getInputs().yield_strength_mpa;
    if (this.diagram === 'stress' && sy) {
      layout.shapes = [sy, -sy].map(y => ({
        type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y,
        line: { color: '#ef4444', width: 1, dash: 'dash' },
      }));
    }

    document.getElementById('chart-placeholder')?.remove();

    if (!this.rendered) {
      Plotly.newPlot('plotly-chart', traces, layout, { responsive: true, displaylogo: false });
      this.rendered = true;
    } else {
      Plotly.react('plotly-chart', traces, layout, { responsive: true, displaylogo: false });
    }
  }
};

// -----------------------------------------------------------------
// 5. THREE.JS 3D BEAM SIMULATION
// -----------------------------------------------------------------
const ThreeBeam = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  beam: null,
  supports: [],
  loadArrows: [],
  sceneHeight: 0.15,
  beamLength: 5.0,
  initialYPositions: [],
  targetCameraPos: null,
  // Filled in by init(). Constructing a THREE.Vector3 at module-evaluation time
  // would throw before the `typeof THREE === 'undefined'` guard below could
  // run, so a failed vendored-script load took the form and charts down too.
  targetLookAt: null,
  transitioning: false,
  autoOrbit: false,
  loop: null,

  init() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas || typeof THREE === 'undefined') return;

    this.targetLookAt = new THREE.Vector3(0, 0, 0);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    this.camera.position.set(0, 1.5, 4);
    this.camera.lookAt(0, 0, 0);

    // Renderer. updateStyle=false keeps the stylesheet in charge of the canvas
    // box; the default (true) pins width/height in px and freezes the viewport
    // at its first-load size, because onResize measures the canvas itself.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Controls
    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 2;
      this.controls.maxDistance = 15;
    }

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const pointLight = new THREE.PointLight(0xffffff, 0.8);
    pointLight.position.set(5, 5, 5);
    this.scene.add(pointLight);

    const dirLight = new THREE.DirectionalLight(0x3b82f6, 0.8);
    dirLight.position.set(-5, 3, -5);
    this.scene.add(dirLight);

    // Build the beam mesh
    this.createBeam(this.beamLength);

    // Add Orbit Controls DOM elements
    const orbitCheckbox = document.getElementById('auto-orbit');
    const sliderX = document.getElementById('cam-slider-x');
    const sliderY = document.getElementById('cam-slider-y');
    const sliderZ = document.getElementById('cam-slider-z');
    const valX = document.getElementById('cam-val-x');
    const valY = document.getElementById('cam-val-y');
    const valZ = document.getElementById('cam-val-z');

    if (orbitCheckbox) {
      orbitCheckbox.addEventListener('change', (e) => {
        this.autoOrbit = e.target.checked;
        if (this.autoOrbit) {
          this.transitioning = false;
          this.targetCameraPos = null;
        }
      });
    }

    const triggerPreset = (x, y, z) => {
      this.targetCameraPos = new THREE.Vector3(x, y, z);
      this.transitioning = true;
      this.autoOrbit = false;
      if (orbitCheckbox) orbitCheckbox.checked = false;
    };

    document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(2.5, 1.8, 2.8));
    document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 4));
    document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 4.2, 0.01));
    document.getElementById('btn-view-inlet')?.addEventListener('click', () => triggerPreset(-3.5, 0, 0));

    const handleSliderChange = () => {
      if (this.autoOrbit) {
        this.autoOrbit = false;
        if (orbitCheckbox) orbitCheckbox.checked = false;
      }
      this.transitioning = false;
      this.targetCameraPos = null;
      this.camera.position.set(
        parseFloat(sliderX.value),
        parseFloat(sliderY.value),
        parseFloat(sliderZ.value)
      );
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
      
      valX.textContent = parseFloat(sliderX.value).toFixed(2);
      valY.textContent = parseFloat(sliderY.value).toFixed(2);
      valZ.textContent = parseFloat(sliderZ.value).toFixed(2);
    };

    [sliderX, sliderY, sliderZ].forEach(slider => {
      slider?.addEventListener('input', handleSliderChange);
    });

    // Start animation loop. Owns its rAF handle so it can be stopped, and
    // parks itself while the tab is hidden.
    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();

    window.addEventListener('resize', () => this.onResize());
  },

  // The beam is always drawn SCENE_L units long, whatever its real span, so a
  // 20 m beam no longer runs out of the camera's view (it used to be drawn
  // L units long next to a camera fixed at 4 units).
  // 4.2 units fits the default camera (4 units away, 45° FOV) with room for
  // the supports at both ends.
  SCENE_L: 4.2,

  // Deformation exaggeration (a 1-2-5 number, or < 1 when the real sag is too
  // big to draw). Sticky between solves so a heavier load visibly bends the
  // beam further; re-picked only when the drawn sag leaves 3–20 % of the span.
  // It used to normalise every result to the same 12 % sag, so changing the
  // load, E or the section changed nothing on screen.
  exaggeration: null,

  createBeam(L, widthM, heightM, loadType) {
    // Dispose geometry and material, not just detach. This runs whenever the
    // span, section or support type changes, allocating a fresh segmented
    // BoxGeometry plus support meshes — all of which used to stay on the GPU.
    this.beam = disposeAndRemove(this.scene, this.beam);
    this.supports.forEach(s => disposeAndRemove(this.scene, s));
    this.supports = [];
    this.loadArrows.forEach(a => disposeAndRemove(this.scene, a));
    this.loadArrows = [];

    this.beamLength = L;
    this.beamWidthM = widthM;
    this.beamHeightM = heightM;
    this.beamLoadType = loadType;
    const SL = this.SCENE_L;

    // Cross-section in scene units: the real slenderness (depth / span)
    // exaggerated ×3 and clamped so the section stays visible, keeping the
    // real width:height ratio — a deep beam looks deep, a flat one flat.
    let sceneHeight = 0.15, sceneWidth = 0.15;
    if (widthM && heightM && widthM > 0 && heightM > 0) {
      const maxDim = Math.min(0.45, Math.max(0.12, (Math.max(widthM, heightM) / L) * SL * 3));
      const s = maxDim / Math.max(widthM, heightM);
      sceneHeight = heightM * s;
      sceneWidth = widthM * s;
    }
    this.sceneHeight = sceneHeight;

    // X is the span, Y the section depth, Z the section width. 100 segments
    // along X so both the deflected shape and the stress colours are smooth.
    const beamGeo = new THREE.BoxGeometry(SL, sceneHeight, sceneWidth, 100, 1, 1);
    beamGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(beamGeo.attributes.position.count * 3), 3));
    const beamMat = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x333333, shininess: 30 });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.scene.add(this.beam);

    const posAttribute = this.beam.geometry.attributes.position;
    this.initialYPositions = new Float32Array(posAttribute.count);
    for (let i = 0; i < posAttribute.count; i++) {
      this.initialYPositions[i] = posAttribute.getY(i);
    }

    const supportMat = new THREE.MeshPhongMaterial({ color: 0x1e2d45 });
    if (loadType === 'cantilever_point' || loadType === 'cantilever_uniform') {
      // Fixed support: a wall at x = 0 (scene −SL/2); the other end is free.
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, Math.max(sceneHeight * 2.5, 0.5), Math.max(sceneWidth * 2.5, 0.5)),
        supportMat,
      );
      wall.position.set(-SL / 2 - 0.06, 0, 0);
      this.scene.add(wall);
      this.supports.push(wall);
    } else {
      // Simply-supported: pins at both ends, free to rotate.
      const supportGeo = new THREE.ConeGeometry(0.12, 0.22, 4);
      [-SL / 2, SL / 2].forEach(x => {
        const pin = new THREE.Mesh(supportGeo, supportMat);
        pin.position.set(x, -sceneHeight / 2 - 0.11, 0);
        this.scene.add(pin);
        this.supports.push(pin);
      });
    }

    // Load arrows: one at the point of application, or eleven along a UDL.
    const pointAt = { point_centre: 0, cantilever_point: SL / 2 }[loadType];
    const xs = pointAt !== undefined ? [pointAt] : Array.from({ length: 11 }, (_, i) => -SL / 2 + (i * SL) / 10);
    const len = pointAt !== undefined ? 0.6 : 0.35;
    xs.forEach(x => {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(x, 0, 0), len, 0xf59e0b, 0.12, 0.08);
      arrow.userData.length = len;
      this.scene.add(arrow);
      this.loadArrows.push(arrow);
    });
  },

  /** Deform, colour and annotate the beam for a fresh solve. */
  update(result, inputs) {
    const L = inputs.length_m;
    if (L !== this.beamLength || inputs.width_m !== this.beamWidthM
        || inputs.height_m !== this.beamHeightM || inputs.load_type !== this.beamLoadType) {
      this.createBeam(L, inputs.width_m, inputs.height_m, inputs.load_type);
    }
    if (!this.beam) return;

    const xs = result.x_positions_m;
    const w = result.deflection_m;
    const peak = Math.max(...w.map(Math.abs));
    const sagRatio = peak / L;              // real sag as a fraction of span
    const SL = this.SCENE_L;

    // 1-2-5 exaggeration so the drawn sag is ~8 % of the span, kept while it
    // stays readable (3–20 %).
    const drawn = sagRatio * (this.exaggeration || 0);
    if (!this.exaggeration || drawn < 0.03 || drawn > 0.2) {
      if (sagRatio <= 0) {
        this.exaggeration = 1;
      } else {
        const target = 0.08 / sagRatio;
        const decade = Math.pow(10, Math.floor(Math.log10(target)));
        this.exaggeration = target >= 1
          ? [5, 2, 1].map(m => m * decade).find(n => n <= target)
          : Math.max(target, 1e-3);
      }
    }
    const sceneScale = (SL / L) * this.exaggeration;

    // Colour by |σ|/σy when both are known (red = yielding), else by |M|/M_max.
    const sy = inputs.yield_strength_mpa;
    const effect = result.stress_mpa && sy
      ? result.stress_mpa.map(s => Math.abs(s) / sy)
      : result.moment_nm.map(m => Math.abs(m) / (result.max_moment_nm || 1));

    const posAttr = this.beam.geometry.attributes.position;
    const colAttr = this.beam.geometry.attributes.color;
    const colour = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const xGlobal = ((posAttr.getX(i) + SL / 2) / SL) * L;   // scene → metres
      posAttr.setY(i, this.initialYPositions[i] - this.interpolate(xGlobal, xs, w) * sceneScale);
      this.effectColour(this.interpolate(xGlobal, xs, effect), colour);
      colAttr.setXYZ(i, colour.r, colour.g, colour.b);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    // Vertex positions changed, so the cached bounds no longer match — without
    // this the beam can be frustum-culled and vanish at some camera angles.
    this.beam.geometry.computeBoundingSphere();

    // Arrows ride on the deflected top face.
    this.loadArrows.forEach(arrow => {
      const xGlobal = ((arrow.position.x + SL / 2) / SL) * L;
      const top = this.sceneHeight / 2 - this.interpolate(xGlobal, xs, w) * sceneScale;
      arrow.position.y = top + arrow.userData.length + 0.02;
    });

    const note = document.getElementById('sim-scale-note');
    if (note) {
      const e = this.exaggeration;
      note.textContent = Math.abs(e - 1) < 1e-9
        ? tr('materials-scale-real', 'Deformação em escala real · cores = esforço')
        : e > 1
          ? tr('materials-scale-exag', 'Deformação ampliada ×{v} · cores = esforço', e.toLocaleString())
          : tr('materials-scale-reduced', 'Deformação reduzida ×{v} (flecha excessiva) · cores = esforço', e.toFixed(2));
    }
  },

  /** Blue → violet → red, matching the legend gradient; ≥ 1 is full red. */
  effectColour(t, out) {
    const stops = [[0x3b, 0x82, 0xf6], [0x8b, 0x5c, 0xf6], [0xef, 0x44, 0x44]];
    const u = Math.min(1, Math.max(0, t)) * 2;
    const i = Math.min(1, Math.floor(u));
    const f = u - i;
    const [a, b] = [stops[i], stops[i + 1]];
    return out.setRGB(
      (a[0] + (b[0] - a[0]) * f) / 255,
      (a[1] + (b[1] - a[1]) * f) / 255,
      (a[2] + (b[2] - a[2]) * f) / 255,
    );
  },

  /** Linear interpolation of ys at x on the ascending grid xs. */
  interpolate(x, xs, ys) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    const i = Math.min(n - 2, Math.floor(((x - xs[0]) / (xs[n - 1] - xs[0])) * (n - 1)));
    const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
    return ys[i] + t * (ys[i + 1] - ys[i]);
  },

  renderFrame() {
    if (!this.renderer) return;

    // 1. Auto-orbit
    if (this.autoOrbit) {
      const time = Date.now() * 0.0005;
      const radius = 4.0;
      this.camera.position.x = radius * Math.cos(time);
      this.camera.position.z = radius * Math.sin(time);
      this.camera.position.y = 1.5 + 0.5 * Math.sin(time * 0.5);
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
    }

    // 2. Camera preset lerping
    if (this.transitioning && this.targetCameraPos) {
      this.camera.position.lerp(this.targetCameraPos, 0.1);
      this.camera.lookAt(this.targetLookAt);
      if (this.controls) this.controls.target.copy(this.targetLookAt);
      
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.01) {
        this.camera.position.copy(this.targetCameraPos);
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    }

    if (this.controls) this.controls.update();

    // 3. Coordinate Sliders Sync
    const sliderX = document.getElementById('cam-slider-x');
    const sliderY = document.getElementById('cam-slider-y');
    const sliderZ = document.getElementById('cam-slider-z');
    const valX = document.getElementById('cam-val-x');
    const valY = document.getElementById('cam-val-y');
    const valZ = document.getElementById('cam-val-z');

    if (sliderX && sliderY && sliderZ) {
      if (document.activeElement !== sliderX) {
        sliderX.value = this.camera.position.x;
        if (valX) valX.textContent = this.camera.position.x.toFixed(2);
      }
      if (document.activeElement !== sliderY) {
        sliderY.value = this.camera.position.y;
        if (valY) valY.textContent = this.camera.position.y.toFixed(2);
      }
      if (document.activeElement !== sliderZ) {
        sliderZ.value = this.camera.position.z;
        if (valZ) valZ.textContent = this.camera.position.z.toFixed(2);
      }
    }

    this.renderer.render(this.scene, this.camera);
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer,
      this.camera,
      document.getElementById('three-canvas'),
    );
  }
};

document.addEventListener('DOMContentLoaded', () => {
  FormManager.init();
  ThreeBeam.init();

  // Diagram switcher above the chart
  document.querySelectorAll('.diagram-switch__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      PlotlyChart.diagram = btn.dataset.diagram;
      PlotlyChart.render(lastResult, lastLength);
    });
  });
  window.addEventListener('language-changed', () => {
    if (lastResult) {
      PlotlyChart.render(lastResult, lastLength);
      ThreeBeam.update(lastResult, FormManager.getInputs());
    }
  });

  // Comparison mode toggle
  const refBtn = document.getElementById('btn-toggle-reference');
  const refBtnLabel = () => {
    const lang = localStorage.getItem('app-language') || 'pt';
    const T = window.TRANSLATIONS?.[lang] || {};
    return referenceResult
      ? (T['materials-cmp-btn-clear'] || '🗑 Clear Reference')
      : (T['materials-cmp-btn-fix'] || '📌 Fix as Reference');
  };
  refBtn?.addEventListener('click', () => {
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
    PlotlyChart.render(lastResult, lastLength);
  });
});

// Re-apply translations once the controller above has built its DOM. The
// template's inline i18n block already merged this page's dictionary and ran
// translatePage, but it did so before this module executed, so anything
// rendered by init() still carries its default-language text.
document.addEventListener('DOMContentLoaded', () => {
  retranslate();
});
