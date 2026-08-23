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
      const isRect = e.target.value === 'rectangular';
      document.getElementById('rectangular-inputs').style.display = isRect ? 'block' : 'none';
      document.getElementById('manual-inputs').style.display = isRect ? 'none' : 'block';
      this.handleSubmit(true);
    });

    // Material preset selector
    this.presetSelect.addEventListener('change', (e) => {
      const presets = {
        steel: 200.0,
        aluminum: 70.0,
        concrete: 30.0,
        wood: 11.0
      };
      const modulus = presets[e.target.value];
      if (modulus) {
        document.getElementById('youngs_modulus_gpa').value = modulus;
        showToast(`Preset: E = ${modulus} GPa loaded`, 'info', 2000);
        this.handleSubmit(true);
      }
    });

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
    const length = parseFloat(document.getElementById('length_m').value);
    const E = parseFloat(document.getElementById('youngs_modulus_gpa').value);
    const load = parseFloat(document.getElementById('load_kn').value);
    const load_type = document.getElementById('load_type').value;

    let I = 8.33e-6; // default
    let area = 0.045; // 150mm x 300mm = 0.045m2
    let width_m = null;
    let height_m = null;

    if (this.shapeSelect.value === 'rectangular') {
      width_m = parseFloat(document.getElementById('width_mm').value) / 1000.0;
      height_m = parseFloat(document.getElementById('height_mm').value) / 1000.0;
      I = (width_m * Math.pow(height_m, 3)) / 12.0;
      area = width_m * height_m;
    } else {
      I = parseFloat(document.getElementById('second_moment_m4').value);
      area = 0.0; // custom/unknown — no real cross-section to visualize
    }

    return {
      length_m: length,
      youngs_modulus_gpa: E,
      second_moment_m4: I,
      load_kn: load,
      load_type: load_type,
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
      ThreeBeam.updateDeflection(result.deflection_m, result.x_positions_m, inputs.length_m, inputs.width_m, inputs.height_m, inputs.load_type);
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
    
    // Update Workbench Title tag dynamically
    const statusTag = document.getElementById('workbench-status');
    if (statusTag) {
      const isDeflected = result.max_deflection_mm > 0.01;
      statusTag.textContent = isDeflected ? `Bending: -${result.max_deflection_mm.toFixed(2)} mm` : 'Stable';
      statusTag.className = 'regime-tag ' + (isDeflected ? 'regime-tag--turbulent' : 'regime-tag--laminar');
    }

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

    const lines = [
      ['E·I (flexural rigidity)', `${E.toExponential(3)} Pa × ${I.toExponential(3)} m⁴ = ${EI.toExponential(3)} N·m²`],
      ...steps,
      ['δ_max', `${deltaM.toExponential(4)} m = ${result.max_deflection_mm.toFixed(4)} mm`],
    ];

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

  render(result, L) {
    const x = result.x_positions_m;
    // The service returns deflection as a positive magnitude for all four load
    // types. Negate it so the curve sags below the axis: the load acts
    // downward, the 3D beam beside this chart bends downward
    // (ThreeBeam.updateDeflection subtracts it), and the axis is labelled
    // "Deflection y (mm)". Plotted raw, the same number drew the beam arching
    // upward while the viewport next to it bent it down. The old comment here
    // claimed the values were already negative; they never were.
    const y = result.deflection_m.map(dy => -dy * 1000.0); // m -> mm, downward

    const trace = {
      x: x,
      y: y,
      mode: 'lines',
      name: 'Beam Deflection',
      line: { color: '#3b82f6', width: 3 },
      fill: 'tozeroy',
      fillcolor: 'rgba(59,130,246,0.05)'
    };

    const traces = [trace];

    // Comparison mode: overlay the pinned reference deflection curve,
    // faded and dashed, alongside the current one.
    if (referenceResult) {
      traces.push({
        x: referenceResult.x_positions_m,
        y: referenceResult.deflection_m.map(dy => -dy * 1000.0),
        mode: 'lines',
        name: 'Reference Deflection',
        line: { color: '#94a3b8', width: 2, dash: 'dot' },
        opacity: 0.6,
      });
    }

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  '#0d1526',
      font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 11 },
      margin: { t: 10, r: 16, b: 48, l: 64 },
      xaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Beam Position x (m)', font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 },
        range: [0, L]
      },
      yaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Deflection y (mm)', font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 }
      }
    };

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

  createBeam(L, widthM, heightM, loadType) {
    // Dispose geometry and material, not just detach. This runs on every
    // parameter change (the form re-solves on a 350 ms debounce), allocating a
    // fresh 60-segment BoxGeometry plus a MeshPhongMaterial and the support
    // meshes each time — all of which used to stay resident on the GPU.
    this.beam = disposeAndRemove(this.scene, this.beam);
    this.supports.forEach(s => disposeAndRemove(this.scene, s));
    this.supports = [];

    this.beamLength = L;
    this.beamWidthM = widthM;
    this.beamHeightM = heightM;
    this.beamLoadType = loadType;

    // Cross-section dimensions in scene units. Real width/height (0.01–2m)
    // can't be drawn to true scale against the length (0.5–20m) without
    // becoming invisible or overwhelming the view, so we exaggerate both
    // dimensions by the same factor — preserving the real width:height
    // aspect ratio, which is what matters pedagogically (a tall/thin beam
    // resists bending differently from a wide/flat one of the same area).
    let sceneHeight = 0.15, sceneWidth = 0.15;
    if (widthM && heightM && widthM > 0 && heightM > 0) {
      const sectionScale = Math.min(L * 0.12, 0.4) / Math.max(widthM, heightM);
      sceneHeight = heightM * sectionScale;
      sceneWidth = widthM * sectionScale;
    }

    // Segmented Box Geometry to support local deformations along X axis
    // BoxGeometry(width, height, depth, widthSegments, heightSegments, depthSegments)
    // Here: X is beam length, Y is cross-section height, Z is cross-section width.
    const beamGeo = new THREE.BoxGeometry(L, sceneHeight, sceneWidth, 60, 1, 1);

    // Shader/Material: Color based on strain (we will use vertex colors or just map them)
    const beamMat = new THREE.MeshPhongMaterial({
      color: 0x3b82f6,
      specular: 0x555555,
      shininess: 30,
      vertexColors: false,
      wireframe: false
    });

    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.scene.add(this.beam);

    // Cache initial Y coordinates of all vertices so we can deflect from initial baseline
    const posAttribute = this.beam.geometry.attributes.position;
    this.initialYPositions = new Float32Array(posAttribute.count);
    for (let i = 0; i < posAttribute.count; i++) {
      this.initialYPositions[i] = posAttribute.getY(i);
    }

    const supportMat = new THREE.MeshPhongMaterial({ color: 0x1e2d45 });
    const isCantilever = loadType === 'cantilever_point' || loadType === 'cantilever_uniform';

    if (isCantilever) {
      // Fixed (built-in) support: a rigid wall block at the beam's origin
      // end (local x = -L/2), matching the "fixed at x=0" boundary
      // condition used by the cantilever formulas — the other end is free.
      const wallGeo = new THREE.BoxGeometry(0.12, Math.max(sceneHeight * 2.5, 0.5), Math.max(sceneWidth * 2.5, 0.5));
      const wall = new THREE.Mesh(wallGeo, supportMat);
      wall.position.set(-L / 2 - 0.06, 0, 0);
      this.scene.add(wall);
      this.supports.push(wall);
    } else {
      // Simply-supported end pillars (pins) — free to rotate at both ends
      const supportGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 4, 1);
      [-L / 2, L / 2].forEach(x => {
        const support = new THREE.Mesh(supportGeo, supportMat);
        support.position.set(x, -0.2, 0);
        this.scene.add(support);
        this.supports.push(support);
      });
    }
  },

  updateDeflection(deflectionCurve, xPositions, L, widthM, heightM, loadType) {
    if (L !== this.beamLength || widthM !== this.beamWidthM || heightM !== this.beamHeightM || loadType !== this.beamLoadType) {
      this.createBeam(L, widthM, heightM, loadType);
    }
    if (!this.beam) return;

    const posAttr = this.beam.geometry.attributes.position;
    const halfL = L / 2;

    // Normalise the sag to a fixed fraction of the span rather than applying a
    // fixed 40x multiplier to raw metres. Real deflections range from microns
    // (a stiff short beam) to a good fraction of a metre, so the constant made
    // most cases look perfectly rigid while a compliant one displaced the mesh
    // several scene units and pushed the beam out of the frustum entirely.
    // Scaling by the peak keeps the deformed shape — which is the point of the
    // view — readable at every stiffness.
    const peak = Math.max(...deflectionCurve.map(Math.abs));
    const scale = peak > 0 ? (L * 0.12) / peak : 0;

    for (let i = 0; i < posAttr.count; i++) {
      const xLocal = posAttr.getX(i); // range: [-halfL, halfL]
      const xGlobal = xLocal + halfL; // range: [0, L]

      // Interpolate the deflection value for this vertex's X coordinate
      const dy = this.getDeflectionAtX(xGlobal, xPositions, deflectionCurve);

      // Update Y vertex coordinate. The service returns a positive magnitude,
      // so subtracting bends the beam downward.
      posAttr.setY(i, this.initialYPositions[i] - dy * scale);
    }

    posAttr.needsUpdate = true;
    // Vertex positions changed, so the cached bounds no longer match — without
    // this the beam can be frustum-culled and vanish at some camera angles.
    this.beam.geometry.computeBoundingSphere();
  },

  getDeflectionAtX(xTarget, xPositions, deflectionCurve) {
    // Basic linear interpolation
    if (xTarget <= xPositions[0]) return deflectionCurve[0];
    if (xTarget >= xPositions[xPositions.length - 1]) return deflectionCurve[deflectionCurve.length - 1];

    for (let i = 0; i < xPositions.length - 1; i++) {
      if (xTarget >= xPositions[i] && xTarget <= xPositions[i+1]) {
        const t = (xTarget - xPositions[i]) / (xPositions[i+1] - xPositions[i]);
        return deflectionCurve[i] + t * (deflectionCurve[i+1] - deflectionCurve[i]);
      }
    }
    return 0.0;
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
