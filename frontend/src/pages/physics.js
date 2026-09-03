/**
 * frontend/src/pages/physics.js
 * ==============================
 * Vite page bundle entry point for the Physics dashboard.
 *
 * Ported from the inline <script> that used to live in templates/app_physics/index.html.
 * The shared UI helpers and the API client are imported; Three.js and Plotly
 * stay on the globals installed by the template's vendored <script> tags.
 *
 * The page's i18n dictionary stays inline in the template on purpose: it must
 * register its DOMContentLoaded listener before base.html's translatePage
 * listener, which a deferred module cannot do.
 */

// THREE, OrbitControls and Plotly are read from the globals installed by the
// vendored <script> tags in the template. The vendored three build is r128
// (2021); npm's `three` would resolve to 0.166, ~38 revisions ahead and
// including r155's redefinition of light intensity units, so the two are not
// interchangeable and this code targets the vendored one. (The vendored plotly
// is plotly.js-dist@2.33.0 — the same major version npm resolves to; only three
// actually differs. Neither package is a dependency any more.)

import { showToast, showLoading, hideLoading, retranslate } from '../modules/shared/utils.js';
// Shared axios client: CSRF header, 30 s timeout, envelope unwrapping and
// normalised errors — replacing this page's own copy of the same fetch wrapper.
import { physicsAPI, describeApiError, latestOnly, isSuperseded } from '../modules/shared/api.js';
import {
  createAnimationLoop,
  disposeAndRemove,
  resizeRendererToCanvas,
} from '../modules/shared/three-utils.js';

// Only the newest in-flight solve per endpoint may repaint the page.
const solveProjectile = latestOnly((params, config) => physicsAPI.projectile(params, config));
const solveMagnetism = latestOnly((params, config) => physicsAPI.magnetism(params, config));

// =================================================================
// 0. COMPARISON MODE & GLOBAL STATE — shared by child views
// =================================================================
let referenceResult = null;
let lastResult = null;

// Lorentz trajectory playback rate, in path samples per second. The service
// returns a fixed-count sample array, so this is what sets how fast the
// particle appears to travel — independent of the display's refresh rate.
const LORENTZ_STEPS_PER_SECOND = 60;

// Plotly chart lifecycle for the single #plotly-chart container, which both
// tabs share.
//
// The two tabs plot incompatible things (a trajectory in metres vs. a force
// decay or a motor transient), so switching tabs cannot simply Plotly.react()
// over the old figure — the axes, ranges and trace count all differ. It has to
// be torn down, and torn down properly: Plotly attaches its own state and, for
// WebGL trace types, a GL context to the container, none of which
// `innerHTML = ''` releases. Purge first, then restore the placeholder.
const PlotlyChartHelper = {
  /** Tracks which tab currently owns the container, or null when empty. */
  ownerTab: null,

  /** Tear the figure down and put the per-tab placeholder back. */
  resetPlaceholder(tab) {
    const chartEl = document.getElementById('plotly-chart');
    if (!chartEl) return;

    // Purge before clearing the DOM, or Plotly's internal state and any GL
    // context leak for the lifetime of the page.
    if (this.ownerTab !== null && window.Plotly) {
      try {
        window.Plotly.purge(chartEl);
      } catch { /* nothing was plotted yet */ }
    }
    this.ownerTab = null;
    chartEl.innerHTML = '';

    const placeholder = document.createElement('div');
    placeholder.className = 'chart-placeholder';
    placeholder.id = 'chart-placeholder';

    const span = document.createElement('span');
    span.textContent = '📉';
    placeholder.appendChild(span);

    const p = document.createElement('p');
    if (tab === 'projectile') {
      p.setAttribute('data-i18n', 'physics-proj-chart-placeholder');
      p.textContent = 'Solve equations to render chart';
    } else {
      p.setAttribute('data-i18n', 'physics-mag-chart-placeholder');
      p.textContent = 'Os gráficos serão desenhados ao iniciar a simulação';
    }
    placeholder.appendChild(p);
    chartEl.appendChild(placeholder);

    // Re-apply language translations. Optional-called: base.html defines
    // translatePage in an inline script, and this module must not hard-depend
    // on that having run.
    const lang = localStorage.getItem('app-language') || 'pt';
    window.translatePage?.(lang);
  },

  /**
   * Draw traces for `tab`, reusing the existing figure when the same tab drew
   * it last and rebuilding it when ownership changes.
   *
   * Both physics charts used to call Plotly.newPlot() unconditionally, which
   * with the 350 ms live re-solve meant a full teardown and rebuild of the
   * figure on every keystroke. Every other module in the project already uses
   * this newPlot-once-then-react pattern.
   */
  draw(tab, traces, layout, config) {
    const chartEl = document.getElementById('plotly-chart');
    if (!chartEl || !window.Plotly) return;

    if (this.ownerTab !== tab) {
      if (this.ownerTab !== null) {
        try {
          window.Plotly.purge(chartEl);
        } catch { /* nothing to purge */ }
      }
      document.getElementById('chart-placeholder')?.remove();
      window.Plotly.newPlot(chartEl, traces, layout, config);
      this.ownerTab = tab;
    } else {
      window.Plotly.react(chartEl, traces, layout, config);
    }
  },
};

/**
 * Retitle the shared chart card, keeping data-i18n in sync with the text.
 *
 * These two elements carry data-i18n and base.html's translatePage rewrites any
 * such element's innerHTML from the dictionary on every language switch. The
 * magnetism renderers used to assign textContent directly and leave the
 * projectile keys on the attributes, so (a) switching to the projectile tab
 * kept whatever magnetism title was set last, since ProjectileChart never reset
 * them, and (b) changing language on the magnetism tab replaced the title with
 * the projectile one. Setting the key as well as the text fixes both.
 */
function setChartHeading(titleKey, titleText, subKey, subText) {
  const title = document.getElementById('chart-title');
  const subtitle = document.getElementById('chart-subtitle');
  const lang = localStorage.getItem('app-language') || 'pt';
  const dict = window.TRANSLATIONS?.[lang] || {};

  if (title) {
    title.setAttribute('data-i18n', titleKey);
    title.textContent = dict[titleKey] || titleText;
  }
  if (subtitle) {
    subtitle.setAttribute('data-i18n', subKey);
    subtitle.textContent = dict[subKey] || subText;
  }
}

// =================================================================
// 2. PROJECTILE MOTION CONTROLLER
// =================================================================
const ProjectileForm = {
  form: document.getElementById('projectile-form'),
  presetSelect: document.getElementById('projectile-preset'),
  calculateBtn: document.getElementById('projectile-calculate-btn'),

  init() {
    // Preset Selector Change listener (recalculates immediately)
    this.presetSelect.addEventListener('change', (e) => {
      const presets = {
        baseball:   { mass: 0.145, diameter: 0.074, cd: 0.30, v0: 45 },
        golfball:   { mass: 0.045, diameter: 0.043, cd: 0.25, v0: 60 },
        bullet:     { mass: 0.008, diameter: 0.009, cd: 0.29, v0: 340 },
        cannonball: { mass: 10.0,  diameter: 0.150, cd: 0.47, v0: 150 }
      };
      const p = presets[e.target.value];
      if (p) {
        document.getElementById('mass_kg').value = p.mass;
        document.getElementById('diameter_m').value = p.diameter;
        document.getElementById('drag_coefficient').value = p.cd;
        document.getElementById('velocity_m_s').value = p.v0;
        showToast(`Loaded ${e.target.value.toUpperCase()} properties`, 'info', 2000);
        this.handleSubmit(true); // Instant calculation
      }
    });

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Debounced live recalculations
    let debounceTimer = null;
    this.form.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.handleSubmit(true), 350);
      });
    });
  },

  getInputs() {
    return {
      velocity_m_s:     parseFloat(document.getElementById('velocity_m_s').value),
      angle_deg:        parseFloat(document.getElementById('angle_deg').value),
      mass_kg:          parseFloat(document.getElementById('mass_kg').value),
      diameter_m:       parseFloat(document.getElementById('diameter_m').value),
      drag_coefficient: parseFloat(document.getElementById('drag_coefficient').value),
    };
  },

  async handleSubmit(auto = false) {
    if (GlobalPhysicsManager.activeTab !== 'projectile') return;
    const data = this.getInputs();

    this.calculateBtn.disabled = true;
    if (!auto) {
      // #projectile-btn-text existed in the template but nothing ever wrote to
      // it — this was the only solve button in the app with no busy state.
      const label = document.getElementById('projectile-btn-text');
      if (label) label.textContent = 'Solving…';
      showLoading('Integrating launch trajectory equations…');
    }

    let result;
    try {
      // Already unwrapped from the {status, data} envelope by the client.
      result = await solveProjectile(data);
      lastResult = result;
    } catch (e) {
      // A superseded request is not a failure — a newer solve is already running.
      if (isSuperseded(e)) return;
      console.error(e);
      showToast(describeApiError(e, 'Solving failed. Check parameter constraints.'), 'error');
      this.calculateBtn.disabled = false;
      if (!auto) { ProjectileForm.restoreButtonLabel(); hideLoading(); }
      return;
    }

    // Rendering is outside the request try/catch so a viewport failure is not
    // reported as a failed calculation.
    try {
      ProjectileUI.updateAll(result, data);
      ProjectileChart.render(result);
      ProjectileThree.buildTrajectory(result);
      window.FloatingPanel?.markUpdated('results');

      // The service truncates integration at 100 s; when it does, range and
      // flight time are lower bounds rather than impact values.
      (result.warnings || []).forEach(w => showToast(w, 'info', 7000));

      if (!auto) showToast('Trajectory equations solved!', 'success');
    } catch (e) {
      console.error('Rendering failed after a successful calculation:', e);
      showToast('Results computed, but the viewport failed to render.', 'error');
    } finally {
      this.calculateBtn.disabled = false;
      if (!auto) { this.restoreButtonLabel(); hideLoading(); }
    }
  },

  restoreButtonLabel() {
    const label = document.getElementById('projectile-btn-text');
    if (!label) return;
    const lang = localStorage.getItem('app-language') || 'pt';
    label.textContent = window.TRANSLATIONS?.[lang]?.['physics-proj-btn-calc']
      || 'Solve Trajectory';
  }
};

const ProjectileUI = {
  updateAll(result, data) {
    const s = result.stats;
    document.getElementById('range-value').textContent = s.range_drag_m.toFixed(1) + ' m';
    document.getElementById('height-value').textContent = s.height_drag_m.toFixed(1) + ' m';

    // KPIs
    document.getElementById('kpi-range-val').textContent = s.range_drag_m.toFixed(1);
    document.getElementById('kpi-height-val').textContent = s.height_drag_m.toFixed(1);
    document.getElementById('kpi-time-val').textContent = s.time_drag_s.toFixed(2);

    // Workbench status badge
    const statusTag = document.getElementById('workbench-status');
    if (statusTag && data) {
      statusTag.textContent = `Angle: ${data.angle_deg}° | Speed: ${data.velocity_m_s}m/s`;
    }

    // Detailed Table
    document.getElementById('tbl-range-vac').textContent = s.range_vacuum_m.toFixed(2) + ' m';
    document.getElementById('tbl-range-drag').textContent = s.range_drag_m.toFixed(2) + ' m';
    document.getElementById('tbl-height-vac').textContent = s.height_vacuum_m.toFixed(2) + ' m';
    document.getElementById('tbl-height-drag').textContent = s.height_drag_m.toFixed(2) + ' m';
    document.getElementById('tbl-time-vac').textContent = s.time_vacuum_s.toFixed(2) + ' s';
    document.getElementById('tbl-time-drag').textContent = s.time_drag_s.toFixed(2) + ' s';
    document.getElementById('tbl-speed-final').textContent = s.final_velocity_drag_m_s.toFixed(2) + ' m/s';
  }
};

const ProjectileChart = {
  render(result) {
    // Reclaim the shared chart heading. The magnetism renderers retitle these
    // same two elements, and nothing here used to set them back — so arriving
    // from the magnetism tab left the trajectory plot captioned
    // "Resposta Transiente de Inicialização".
    setChartHeading(
      'physics-proj-chart-title', '📉 Comparação de Perfis de Trajetória',
      'physics-proj-chart-sub', 'Trajetória no vácuo vs. voo real com arrasto do ar',
    );

    const traceIdeal = {
      x: result.x_vacuum,
      y: result.y_vacuum,
      mode: 'lines',
      name: 'Vacuum (Ideal)',
      line: { color: '#8b5cf6', width: 2, dash: 'dash' }
    };

    const traceReal = {
      x: result.x_drag,
      y: result.y_drag,
      mode: 'lines',
      name: 'Air Drag (Real)',
      line: { color: '#ef4444', width: 3 },
      fill: 'tozeroy',
      fillcolor: 'rgba(239,68,68,0.04)'
    };

    const traces = [traceIdeal, traceReal];

    if (referenceResult) {
      traces.push({
        x: referenceResult.x_drag,
        y: referenceResult.y_drag,
        mode: 'lines',
        name: 'Reference (Air Drag)',
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
        title: { text: 'Distance x (m)', font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 }
      },
      yaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Height y (m)', font: { size: 11, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 10 }
      }
    };

    PlotlyChartHelper.draw('projectile', traces, layout, {
      responsive: true, displaylogo: false,
    });
  }
};

const ProjectileThree = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  idealPathLine: null,
  realPathLine: null,
  projectile: null,
  referencePathLine: null,
  grid: null,

  animating: true,
  dragCoords: [],
  dragDuration: 0,
  animElapsed: 0,
  _lastFrameTime: null,
  scaleFactor: 1.0,

  targetCameraPos: null,
  targetLookAt: new THREE.Vector3(0, 0, 0),
  transitioning: false,
  autoOrbit: false,
  loop: null,

  init() {
    const canvas = document.getElementById('three-canvas-projectile');
    if (!canvas || typeof THREE === 'undefined') return;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);

    this.camera = new THREE.PerspectiveCamera(45, canvas.offsetWidth / canvas.offsetHeight, 0.1, 100);
    this.camera.position.set(0, 1.5, 4);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 1;
      this.controls.maxDistance = 15;
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const pointLight = new THREE.PointLight(0xffffff, 0.8);
    pointLight.position.set(5, 5, 5);
    this.scene.add(pointLight);

    this.grid = new THREE.GridHelper(8, 20, 0x1e3a5f, 0x111e35);
    this.grid.position.y = -0.5;
    this.scene.add(this.grid);

    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();
  },

  buildTrajectory(result) {
    // Dispose, don't just detach. buildTrajectory runs on every debounced
    // re-solve and allocates fresh BufferGeometry + LineBasicMaterial for each
    // path; removing them from the scene left every buffer on the GPU.
    this.idealPathLine = disposeAndRemove(this.scene, this.idealPathLine);
    this.realPathLine = disposeAndRemove(this.scene, this.realPathLine);
    this.projectile = disposeAndRemove(this.scene, this.projectile);
    this.referencePathLine = disposeAndRemove(this.scene, this.referencePathLine);

    const xReal = result.x_drag;
    const yReal = result.y_drag;
    const xIdeal = result.x_vacuum;
    const yIdeal = result.y_vacuum;

    const maxVal = Math.max(xIdeal[xIdeal.length - 1] || 1, Math.max(...yIdeal) || 1);
    this.scaleFactor = 4.0 / maxVal;

    // Ideal Path
    const idealPoints = [];
    for (let i = 0; i < xIdeal.length; i++) {
      idealPoints.push(new THREE.Vector3(xIdeal[i] * this.scaleFactor - 2, yIdeal[i] * this.scaleFactor - 0.5, 0));
    }
    const idealGeo = new THREE.BufferGeometry().setFromPoints(idealPoints);
    const idealMat = new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.4 });
    this.idealPathLine = new THREE.Line(idealGeo, idealMat);
    this.scene.add(this.idealPathLine);

    // Real Path
    const realPoints = [];
    this.dragCoords = [];
    for (let i = 0; i < xReal.length; i++) {
      const vec = new THREE.Vector3(xReal[i] * this.scaleFactor - 2, yReal[i] * this.scaleFactor - 0.5, 0);
      realPoints.push(vec);
      this.dragCoords.push(vec);
    }
    const realGeo = new THREE.BufferGeometry().setFromPoints(realPoints);
    const realMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2 });
    this.realPathLine = new THREE.Line(realGeo, realMat);
    this.scene.add(this.realPathLine);

    // Reference curve
    if (referenceResult) {
      const refPoints = [];
      const xRef = referenceResult.x_drag, yRef = referenceResult.y_drag;
      for (let i = 0; i < xRef.length; i++) {
        refPoints.push(new THREE.Vector3(xRef[i] * this.scaleFactor - 2, yRef[i] * this.scaleFactor - 0.5, 0));
      }
      const refGeo = new THREE.BufferGeometry().setFromPoints(refPoints);
      const refMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.35 });
      this.referencePathLine = new THREE.Line(refGeo, refMat);
      this.scene.add(this.referencePathLine);
    }

    // Sphere
    const sphereGeo = new THREE.SphereGeometry(0.08, 32, 32);
    const sphereMat = new THREE.MeshPhongMaterial({ color: 0xef4444, emissive: 0x5a1a1a, shininess: 80 });
    this.projectile = new THREE.Mesh(sphereGeo, sphereMat);
    this.projectile.position.copy(this.dragCoords[0] || new THREE.Vector3(-2, -0.5, 0));
    this.scene.add(this.projectile);

    this.dragDuration = Math.max(result.stats.time_drag_s || 0, 1e-3);
    this.animElapsed = 0;
    this._lastFrameTime = null;
  },

  // Called every frame; resizeRendererToCanvas memoizes, so it is a no-op
  // until the canvas actually changes size.
  checkSize() {
    resizeRendererToCanvas(
      this.renderer, this.camera, document.getElementById('three-canvas-projectile'),
    );
  },

  renderFrame() {
    // The loop is cancelled when this tab is not visible (see setTab), so this
    // is only a guard for the frame already in flight. Previously the rAF was
    // rescheduled *before* the `!this.animating` check, so a paused viewport
    // kept waking up 60 times a second for the rest of the session.
    if (!this.renderer || GlobalPhysicsManager.activeTab !== 'projectile') return;

    this.checkSize();

    if (this.autoOrbit) {
      const time = Date.now() * 0.0005;
      const radius = 4.0;
      this.camera.position.x = radius * Math.cos(time);
      this.camera.position.z = radius * Math.sin(time);
      this.camera.position.y = 1.5 + 0.5 * Math.sin(time * 0.5);
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
    }

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

    // Sync sliders
    const sliderX = document.getElementById('cam-slider-x');
    const sliderY = document.getElementById('cam-slider-y');
    const sliderZ = document.getElementById('cam-slider-z');
    const valX = document.getElementById('cam-val-x');
    const valY = document.getElementById('cam-val-y');
    const valZ = document.getElementById('cam-val-z');

    if (sliderX && sliderY && sliderZ) {
      if (document.activeElement !== sliderX) {
        sliderX.value = this.camera.position.x.toFixed(2);
        if (valX) valX.textContent = this.camera.position.x.toFixed(2);
      }
      if (document.activeElement !== sliderY) {
        sliderY.value = this.camera.position.y.toFixed(2);
        if (valY) valY.textContent = this.camera.position.y.toFixed(2);
      }
      if (document.activeElement !== sliderZ) {
        sliderZ.value = this.camera.position.z.toFixed(2);
        if (valZ) valZ.textContent = this.camera.position.z.toFixed(2);
      }
    }

    // Playback trajectory
    if (this.projectile && this.dragCoords.length > 1 && this.dragDuration) {
      const now = performance.now();
      const dtReal = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 0;
      this._lastFrameTime = now;

      this.animElapsed = (this.animElapsed + dtReal) % this.dragDuration;
      const frac = this.animElapsed / this.dragDuration;
      const idxFloat = frac * (this.dragCoords.length - 1);
      const i0 = Math.max(0, Math.min(this.dragCoords.length - 2, Math.floor(idxFloat)));
      const i1 = i0 + 1;
      const t = idxFloat - i0;
      this.projectile.position.lerpVectors(this.dragCoords[i0], this.dragCoords[i1], t);
    } else if (this.projectile && this.dragCoords.length > 0) {
      this.projectile.position.copy(this.dragCoords[0]);
    }

    this.renderer.render(this.scene, this.camera);
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer,
      this.camera,
      document.getElementById('three-canvas-projectile'),
    );
  }
};

// =================================================================
// 3. MAGNETISM & MOTORS CONTROLLER
// =================================================================
const MagnetismForm = {
  currentMode: 'lorentz',
  lastResult: null,

  init() {
    this.bindEvents();
    this.renderPresets();
    this.updateFormDisplay();
  },

  bindEvents() {
    // Mode switcher tabs
    document.querySelectorAll('.mode-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.getAttribute('data-mode');
        this.setMode(mode);
      });
    });

    document.getElementById('magnetism-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.runSimulation();
    });

    // Debounced live input triggers
    let debounceTimer = null;
    document.querySelectorAll('#magnetism-form input[type="number"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.runSimulation(true), 350);
      });
    });

    document.getElementById('motor_poles')?.addEventListener('change', () => {
      this.runSimulation(true);
    });

    document.getElementById('magnet_material')?.addEventListener('change', () => {
      this.runSimulation(true);
    });

    // Encyclopedia tabs
    document.querySelectorAll('.encyclopedia-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        document.querySelectorAll('.encyclopedia-tab-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');

        document.querySelectorAll('.ency-panel').forEach(p => p.style.display = 'none');
        document.getElementById(`ency-${tab}`).style.display = 'block';
      });
    });
  },

  setMode(mode) {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    document.getElementById('simulation-mode').value = mode;

    document.querySelectorAll('.mode-tab-btn').forEach(b => b.classList.remove('mode-tab-btn--active'));
    document.querySelector(`.mode-tab-btn[data-mode="${mode}"]`).classList.add('mode-tab-btn--active');

    this.updateFormDisplay();
    this.renderPresets();

    // Toggle visualizers
    const canvas3D = document.getElementById('three-canvas-magnetism');
    const canvasMotor = document.getElementById('motor-canvas');
    const camCtrls = document.getElementById('camera-ctrls');

    if (GlobalPhysicsManager.activeTab === 'magnetism') {
      if (mode === 'motor') {
        canvas3D.style.display = 'none';
        canvasMotor.style.display = 'block';
        camCtrls.style.display = 'none';
      } else {
        canvas3D.style.display = 'block';
        canvasMotor.style.display = 'none';
        camCtrls.style.display = 'block';
        MagnetismThree.onResize();
      }
    }
    
    // Update headers in active language
    GlobalPhysicsManager.renderHeaders();
    this.runSimulation();
  },

  updateFormDisplay() {
    const subtitle = document.getElementById('form-subtitle');
    document.querySelectorAll('.dynamic-group').forEach(g => g.style.display = 'none');

    const lang = localStorage.getItem('app-language') || 'pt';
    const t = (key, fallback) => window.TRANSLATIONS?.[lang]?.[key] || fallback;

    if (this.currentMode === 'lorentz') {
      subtitle.textContent = t('physics-mag-params-sub', 'Configurações para Força de Lorentz');
      document.getElementById('group-lorentz').style.display = 'block';
    } else if (this.currentMode === 'poles') {
      subtitle.textContent = t('physics-mag-sec-poles', 'Força dos Polos');
      document.getElementById('group-poles').style.display = 'block';
    } else if (this.currentMode === 'motor') {
      subtitle.textContent = t('physics-mag-tab3', 'Dinâmica de Motor CC');
      document.getElementById('group-motor').style.display = 'block';
    }
  },

  renderPresets() {
    const container = document.getElementById('presets-container');
    container.innerHTML = '';
    const modePresets = Presets[this.currentMode];

    modePresets.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--outline';
      btn.style.padding = '6px 8px';
      btn.style.fontSize = '0.7rem';
      btn.style.justifyContent = 'center';
      btn.style.minHeight = 'auto';
      btn.style.cursor = 'pointer';
      btn.textContent = p.name;
      btn.addEventListener('click', () => this.loadPreset(p));
      container.appendChild(btn);
    });
  },

  loadPreset(p) {
    if (this.currentMode === 'lorentz') {
      document.getElementById('q_uc').value = p.q_uc;
      document.getElementById('m_mg').value = p.m_mg;
      document.getElementById('vx').value = p.vx;
      document.getElementById('vy').value = p.vy;
      document.getElementById('vz').value = p.vz;
      document.getElementById('Bx').value = p.Bx;
      document.getElementById('By').value = p.By;
      document.getElementById('Bz').value = p.Bz;
    } else if (this.currentMode === 'poles') {
      document.getElementById('qm1').value = p.qm1;
      document.getElementById('qm2').value = p.qm2;
      document.getElementById('r').value = p.r;
    } else if (this.currentMode === 'motor') {
      document.getElementById('V').value = p.V;
      document.getElementById('R').value = p.R;
      document.getElementById('L').value = p.L;
      document.getElementById('J').value = p.J;
      document.getElementById('b').value = p.b;
      document.getElementById('Kt').value = p.Kt;
      document.getElementById('Ke').value = p.Ke;
      document.getElementById('tl').value = p.tl;
      if (p.poles_count && document.getElementById('motor_poles')) {
        document.getElementById('motor_poles').value = p.poles_count;
      }
    }
    showToast(`Preset "${p.name}" carregado!`, 'info', 2000);
    this.runSimulation();
  },

  getInputs() {
    const data = { mode: this.currentMode };
    if (this.currentMode === 'lorentz') {
      data.q_uc = parseFloat(document.getElementById('q_uc').value);
      data.m_mg = parseFloat(document.getElementById('m_mg').value);
      data.vx = parseFloat(document.getElementById('vx').value);
      data.vy = parseFloat(document.getElementById('vy').value);
      data.vz = parseFloat(document.getElementById('vz').value);
      data.Bx = parseFloat(document.getElementById('Bx').value);
      data.By = parseFloat(document.getElementById('By').value);
      data.Bz = parseFloat(document.getElementById('Bz').value);
    } else if (this.currentMode === 'poles') {
      data.qm1 = parseFloat(document.getElementById('qm1').value);
      data.qm2 = parseFloat(document.getElementById('qm2').value);
      data.r = parseFloat(document.getElementById('r').value);
    } else if (this.currentMode === 'motor') {
      data.V = parseFloat(document.getElementById('V').value);
      data.R = parseFloat(document.getElementById('R').value);
      data.L = parseFloat(document.getElementById('L').value);
      data.J = parseFloat(document.getElementById('J').value);
      data.b = parseFloat(document.getElementById('b').value);
      data.Kt = parseFloat(document.getElementById('Kt').value);
      data.Ke = parseFloat(document.getElementById('Ke').value);
      data.tl = parseFloat(document.getElementById('tl').value);
      data.poles_count = parseInt(document.getElementById('motor_poles')?.value || '2', 10);
      data.magnet_material = document.getElementById('magnet_material')?.value || 'ndfeb_n52';
      data.pole_span_deg = parseFloat(document.getElementById('pole_span_deg')?.value || '120.0');
    }
    return data;
  },

  async runSimulation(auto = false) {
    if (GlobalPhysicsManager.activeTab !== 'magnetism') return;
    const inputs = this.getInputs();
    const btn = document.getElementById('calculate-btn');
    btn.disabled = true;
    if (!auto) showLoading('Simulando equações diferenciais magnéticas…');

    let data;
    try {
      // Already unwrapped from the {status, data} envelope by the client.
      data = await solveMagnetism(inputs);
      this.lastResult = data;
    } catch (e) {
      // A superseded request is not a failure — a newer solve is already running.
      if (isSuperseded(e)) return;
      console.error(e);
      showToast(
        describeApiError(e, 'Falha no cálculo. Verifique as restrições físicas dos dados.'),
        'error',
      );
      btn.disabled = false;
      if (!auto) hideLoading();
      return;
    }

    try {
      MagnetismUI.update(data, this.currentMode);
      MagnetismChart.render(data, this.currentMode);

      if (this.currentMode === 'lorentz' || this.currentMode === 'poles') {
        MagnetismThree.build(data, this.currentMode);
      } else if (this.currentMode === 'motor') {
        MagnetismMotor.build(data);
      }
      window.FloatingPanel?.markUpdated('results');

      if (!auto) showToast('Simulado calculado com sucesso!', 'success');
    } catch (e) {
      console.error('Rendering failed after a successful calculation:', e);
      showToast('Cálculo concluído, mas a visualização falhou.', 'error');
    } finally {
      btn.disabled = false;
      if (!auto) hideLoading();
    }
  }
};

const MagnetismUI = {
  update(data, mode) {
    const tbl = document.getElementById('results-table-body-mag');
    tbl.innerHTML = '';

    const badge1 = document.getElementById('badge-primary');
    const badge2 = document.getElementById('badge-secondary');
    const val1 = document.getElementById('kpi-val-1');
    const val2 = document.getElementById('kpi-val-2');
    const val3 = document.getElementById('kpi-val-3');
    
    const lbl1 = document.getElementById('kpi-lbl-1');
    const lbl2 = document.getElementById('kpi-lbl-2');
    const lbl3 = document.getElementById('kpi-lbl-3');

    const unit1 = document.getElementById('kpi-unit-1');
    const unit2 = document.getElementById('kpi-unit-2');
    const unit3 = document.getElementById('kpi-unit-3');

    const lang = localStorage.getItem('app-language') || 'pt';
    const t = (key, fallback) => window.TRANSLATIONS?.[lang]?.[key] || fallback;

    if (mode === 'lorentz') {
      badge1.style.display = 'inline-flex';
      badge2.style.display = 'none';
      document.getElementById('badge-primary-lbl').textContent = t('physics-mag-lbl-larmor', 'Raio Larmor');
      document.getElementById('badge-primary-val').textContent = data.stats.larmor_radius_m ? data.stats.larmor_radius_m.toFixed(3) + ' m' : 'Infinito';

      lbl1.textContent = t('physics-mag-lbl-larmor', 'Raio de Larmor');
      val1.textContent = data.stats.larmor_radius_m ? data.stats.larmor_radius_m.toFixed(3) : '∞';
      unit1.textContent = 'metros';

      lbl2.textContent = t('physics-mag-lbl-cyclotron', 'Frequência Ciclotrônica');
      val2.textContent = data.stats.cyclotron_frequency_hz.toFixed(2);
      unit2.textContent = 'Hz';

      const fx = data.Fx[0] || 0;
      const fy = data.Fy[0] || 0;
      const fz = data.Fz[0] || 0;
      const f_mag = Math.sqrt(fx*fx + fy*fy + fz*fz);
      
      lbl3.textContent = t('physics-mag-lbl-lorentz-init', 'Força de Lorentz Inicial');
      val3.textContent = f_mag.toExponential(3);
      unit3.textContent = 'Newtons';

      tbl.innerHTML = `
        <tr><td>Carga Elétrica (q)</td><td>${document.getElementById('q_uc').value} &mu;C</td></tr>
        <tr><td>Massa Partícula (m)</td><td>${document.getElementById('m_mg').value} mg</td></tr>
        <tr><td>Magnitude Campo B</td><td>${data.stats.magnetic_field_mag_t.toFixed(2)} T</td></tr>
        <tr><td>Velocidade Perpendicular</td><td>${data.stats.velocity_perp_m_s.toFixed(2)} m/s</td></tr>
        <tr><td>Velocidade Total</td><td>${data.stats.velocity_total_m_s.toFixed(2)} m/s</td></tr>
        <tr><td>Frequência Ciclotrônica</td><td>${data.stats.cyclotron_frequency_hz.toFixed(2)} Hz</td></tr>
        <tr class="results-table__highlight"><td>Força Inicial X</td><td>${fx.toExponential(3)} N</td></tr>
        <tr class="results-table__highlight"><td>Força Inicial Y</td><td>${fy.toExponential(3)} N</td></tr>
        <tr class="results-table__highlight"><td>Força Inicial Z</td><td>${fz.toExponential(3)} N</td></tr>
      `;

      // Legend update
      document.getElementById('magnetism-legend').innerHTML = `
        <span style="color:#ef4444">● Partícula</span>
        <span style="color:#10b981">● Campo Magnético B</span>
        <span style="color:#8b5cf6">● Força F (V x B)</span>
        <span style="color:#cbd5e1">● Velocidade V</span>
      `;

    } else if (mode === 'poles') {
      badge1.style.display = 'inline-flex';
      badge2.style.display = 'none';
      document.getElementById('badge-primary-lbl').textContent = t('physics-mag-lbl-pole-force', 'Força de Polo');
      document.getElementById('badge-primary-val').textContent = data.stats.force_n.toExponential(3) + ' N';

      lbl1.textContent = t('physics-mag-lbl-distance', 'Distância (r)');
      val1.textContent = data.stats.distance_m.toFixed(2);
      unit1.textContent = 'metros';

      lbl2.textContent = t('physics-mag-lbl-behavior', 'Comportamento');
      val2.textContent = data.stats.type === 'Attraction' ? t('physics-mag-val-attraction', 'Atração') : t('physics-mag-val-repulsion', 'Repulsão');
      unit2.textContent = data.stats.force_n < 0 ? 'Polos Opostos' : 'Polos Iguais';

      lbl3.textContent = t('physics-mag-lbl-resultant', 'Força Resultante');
      val3.textContent = Math.abs(data.stats.force_n).toExponential(3);
      unit3.textContent = 'Newtons';

      tbl.innerHTML = `
        <tr><td>Intensidade Polo 1 (qm1)</td><td>${document.getElementById('qm1').value} A&middot;m</td></tr>
        <tr><td>Intensidade Polo 2 (qm2)</td><td>${document.getElementById('qm2').value} A&middot;m</td></tr>
        <tr><td>Distância de Separação (r)</td><td>${data.stats.distance_m.toFixed(2)} m</td></tr>
        <tr><td>Tipo de Interação</td><td>${data.stats.type === 'Attraction' ? 'Atração (Opostos)' : 'Repulsão (Iguais)'}</td></tr>
        <tr class="results-table__highlight"><td>Força Magnética Calculada</td><td>${data.stats.force_n.toExponential(5)} N</td></tr>
      `;

      // Legend update
      document.getElementById('magnetism-legend').innerHTML = `
        <span style="color:#ef4444">● Polo 1 (Norte/Vermelho)</span>
        <span style="color:#3b82f6">● Polo 2 (Sul/Azul)</span>
        <span style="color:#f59e0b">● Vetores de Força F</span>
      `;

    } else if (mode === 'motor') {
      badge1.style.display = 'inline-flex';
      badge2.style.display = 'inline-flex';
      document.getElementById('badge-primary-lbl').textContent = t('physics-mag-lbl-rpm', 'Rpm Estacionário');
      document.getElementById('badge-primary-val').textContent = Math.round(data.stats.steady_state_speed_rpm) + ' RPM';
      // ?? not ||: the service legitimately returns 0.0 for a stalled motor
      // (p_elec below threshold or p_mech <= 0), and `||` treated that real
      // measurement as "missing" and fell through to the next value.
      const effVal = data.stats.efficiency_steady_pct ?? data.stats.max_efficiency_pct ?? 0;
      document.getElementById('badge-secondary-lbl').textContent = t('physics-mag-lbl-efficiency', 'Rendimento Global');
      document.getElementById('badge-secondary-val').textContent = effVal.toFixed(1) + '%';

      lbl1.textContent = t('physics-mag-lbl-final-speed', 'Velocidade Final');
      val1.textContent = Math.round(data.stats.steady_state_speed_rpm);
      unit1.textContent = 'RPM';

      lbl2.textContent = t('physics-mag-lbl-efficiency', 'Eficiência Global (η)');
      val2.textContent = effVal.toFixed(1);
      unit2.textContent = '%';

      lbl3.textContent = t('physics-mag-lbl-settling-time', 'Tempo de Acomodação');
      val3.textContent = data.stats.settling_time_s.toFixed(3);
      unit3.textContent = 'segundos';

      tbl.innerHTML = `
        <tr><td>Material dos Ímãs Permanentes</td><td><strong>${data.stats.magnet_material_name || 'Neodímio N52'}</strong> (B_r = ${data.stats.remanence_br_t ?? 1.45} T)</td></tr>
        <tr><td>Fluxo Magnético no Entreferro (B_gap)</td><td><strong>${data.stats.b_gap_t ?? 1.23} T</strong></td></tr>
        <tr><td>Cobertura Angular dos Polos (&alpha;_p)</td><td>${data.stats.pole_span_deg ?? 120}° por polo</td></tr>
        <tr><td>Quantidade de Ímãs (Estator)</td><td>${data.stats.poles_count ?? 2} Ímãs (${(data.stats.poles_count ?? 2) / 2} Pares N-S)</td></tr>
        <tr><td>Tensão de Alimentação (V)</td><td>${document.getElementById('V').value} V</td></tr>
        <tr><td>Potência Elétrica de Entrada (P_e)</td><td>${data.stats.p_elec_w ?? 0} W</td></tr>
        <tr><td>Potência Mecânica no Eixo (P_m)</td><td>${data.stats.p_mech_w ?? 0} W</td></tr>
        <tr><td>Perdas por Efeito Joule (P_cu)</td><td>${data.stats.p_cu_w ?? 0} W</td></tr>
        <tr class="results-table__highlight"><td>Eficiência Global (&eta;)</td><td><strong>${effVal.toFixed(1)} %</strong></td></tr>
        <tr><td>Velocidade Máxima (Estac.)</td><td>${data.stats.steady_state_speed_rpm.toFixed(0)} RPM (${data.stats.steady_state_speed_rad_s.toFixed(2)} rad/s)</td></tr>
        <tr><td>Corrente de Partida (Pico)</td><td>${data.stats.starting_current_a.toFixed(1)} A</td></tr>
        <tr><td>Torque Eletromagnético Máx</td><td>${data.stats.max_torque_nm.toFixed(2)} N&middot;m</td></tr>
      `;

      document.getElementById('magnetism-legend').innerHTML = `
        <span style="color:#ef4444">● Induzido Rotativo (Comutação CC)</span>
        <span style="color:#cbd5e1">● Estator Fixo (Campos Estáticos)</span>
      `;
    }
  }
};

const MagnetismChart = {
  render(data, mode) {
    let traces = [];
    let layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  '#0d1526',
      font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 10 },
      margin: { t: 15, r: 16, b: 38, l: 56 }
    };

    if (mode === 'lorentz') {
      traces.push({
        x: data.x,
        y: data.y,
        mode: 'lines',
        name: 'Projeção XY',
        line: { color: '#8b5cf6', width: 2.5 }
      });
      traces.push({
        x: data.x,
        y: data.z,
        mode: 'lines',
        name: 'Projeção XZ',
        line: { color: '#3b82f6', width: 2, dash: 'dash' }
      });
      layout.xaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Coordenada X (m)', font: { size: 10 } }
      };
      layout.yaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Coordenadas Y/Z (m)', font: { size: 10 } }
      };
      setChartHeading(
        'physics-mag-chart-title-lorentz', '📉 Projeção de Trajetória Bidimensional',
        'physics-mag-chart-sub-lorentz', 'Projeções XY e XZ da espiral ciclotrônica da partícula',
      );

    } else if (mode === 'poles') {
      traces.push({
        x: data.r_profile,
        y: data.f_profile,
        mode: 'lines',
        name: 'Força vs Distância',
        line: { color: '#f59e0b', width: 3 },
        fill: 'tozeroy',
        fillcolor: 'rgba(245,158,11,0.03)'
      });

      traces.push({
        x: [data.stats.distance_m],
        y: [data.stats.force_n],
        mode: 'markers+text',
        name: 'Ponto Operacional',
        marker: { color: '#ef4444', size: 10 },
        text: [`F: ${data.stats.force_n.toExponential(2)} N`],
        textposition: 'top right'
      });

      layout.xaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        title: { text: 'Distância r (m)', font: { size: 10 } }
      };
      layout.yaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Força F (N)', font: { size: 10 } }
      };
      setChartHeading(
        'physics-mag-chart-title-poles', '📉 Perfil de Força Magnética vs. Distância',
        'physics-mag-chart-sub-poles', 'Gráfico com decaimento quadrático de Coulomb (1/r²)',
      );

    } else if (mode === 'motor') {
      traces.push({
        x: data.t,
        y: data.speed_rpm,
        mode: 'lines',
        name: 'Velocidade (RPM)',
        line: { color: '#10b981', width: 3 },
        yaxis: 'y'
      });
      traces.push({
        x: data.t,
        y: data.I,
        mode: 'lines',
        name: 'Corrente (A)',
        line: { color: '#ef4444', width: 2, dash: 'dash' },
        yaxis: 'y2'
      });

      layout.xaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        title: { text: 'Tempo t (s)', font: { size: 10 } }
      };
      layout.yaxis = {
        gridcolor: 'rgba(255,255,255,0.05)',
        title: { text: 'Velocidade (RPM)', font: { size: 10, color: '#10b981' } },
        tickfont: { color: '#10b981' }
      };
      layout.yaxis2 = {
        title: { text: 'Corrente (A)', font: { size: 10, color: '#ef4444' } },
        tickfont: { color: '#ef4444' },
        overlaying: 'y',
        side: 'right',
        gridcolor: 'transparent'
      };
      layout.showlegend = true;
      layout.legend = { orientation: 'h', y: 1.15, x: 0.1 };

      setChartHeading(
        'physics-mag-chart-title-motor', '📉 Resposta Transiente de Inicialização',
        'physics-mag-chart-sub-motor', 'Constante de tempo elétrica e mecânica sob carga constante',
      );
    }

    // Keyed by mode, not just by tab: the three magnetism modes plot entirely
    // different quantities, so switching mode has to rebuild rather than react.
    PlotlyChartHelper.draw(`magnetism:${mode}`, traces, layout, {
      responsive: true, displaylogo: false,
    });
  }
};

const MagnetismThree = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  grid: null,

  particle: null,
  pathLine: null,
  vectors: [],
  magnets: [],
  fieldLines: null,
  
  // Dynamic moving vectors references
  movingVelocityArrow: null,
  movingForceArrow: null,
  movingBArrow: null,

  currentMode: 'lorentz',
  animating: true,
  animStep: 0,
  pathCoords: [],
  vCoords: [],
  bCoords: [],
  fCoords: [],
  autoOrbit: false,
  loop: null,
  // Camera preset transition state, consumed by renderFrame().
  targetCameraPos: null,
  transitioning: false,
  // Time-based playback state (see renderFrame).
  _lastStepMs: null,
  _stepAccumulator: 0,

  /**
   * Point one of the three moving vectors along `dir`, creating it on first use.
   *
   * @param {string} key    — field name on this object holding the ArrowHelper
   * @param {THREE.Vector3|undefined} dir
   * @param {THREE.Vector3} origin
   * @param {number} colour
   */
  updateMovingArrow(key, dir, origin, colour) {
    const visible = !!dir && dir.lengthSq() > 1e-4;
    let arrow = this[key];

    if (!visible) {
      if (arrow) arrow.visible = false;
      return;
    }

    const length = Math.max(0.4, dir.length());
    const unit = dir.clone().normalize();

    if (!arrow) {
      arrow = new THREE.ArrowHelper(unit, origin, length, colour, 0.15, 0.09);
      this.scene.add(arrow);
      this[key] = arrow;
    } else {
      arrow.position.copy(origin);
      arrow.setDirection(unit);
      arrow.setLength(length, 0.15, 0.09);
    }
    arrow.visible = true;
  },

  init() {
    const canvas = document.getElementById('three-canvas-magnetism');
    if (!canvas || typeof THREE === 'undefined') return;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);

    const w = canvas.offsetWidth || 800;
    const h = canvas.offsetHeight || 500;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(3.5, 3.0, 5.0);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 1;
      this.controls.maxDistance = 20;
      this.controls.target.set(0, 0, 0);
    }

    // High intensity directional light + ambient light for clear 3D rendering
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(5, 10, 7);
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x38bdf8, 0.6);
    dirLight2.position.set(-5, -5, -5);
    this.scene.add(dirLight2);

    this.grid = new THREE.GridHelper(8, 20, 0x38bdf8, 0x1e293b);
    this.grid.position.y = -1.2;
    this.scene.add(this.grid);

    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer, this.camera,
      document.getElementById('three-canvas-magnetism'),
    );
  },

  clear() {
    // Dispose, don't just detach: this runs on every debounced re-solve and
    // rebuilds the particle sphere, the path line, eight Bezier field lines,
    // the bar magnets and a grid of up to 5x3x3 arrow helpers. Detaching alone
    // left every one of those buffers resident on the GPU.
    this.particle = disposeAndRemove(this.scene, this.particle);
    this.pathLine = disposeAndRemove(this.scene, this.pathLine);
    this.fieldLines = disposeAndRemove(this.scene, this.fieldLines);

    this.movingVelocityArrow = disposeAndRemove(this.scene, this.movingVelocityArrow);
    this.movingForceArrow = disposeAndRemove(this.scene, this.movingForceArrow);
    this.movingBArrow = disposeAndRemove(this.scene, this.movingBArrow);

    this.vectors.forEach(v => disposeAndRemove(this.scene, v));
    this.magnets.forEach(m => disposeAndRemove(this.scene, m));
    this.vectors = [];
    this.magnets = [];
    this.pathCoords = [];
    this.vCoords = [];
    this.bCoords = [];
    this.fCoords = [];
    this._lastStepMs = null;
    this._stepAccumulator = 0;
  },

  build(data, mode) {
    this.clear();
    this.currentMode = mode;
    this.animStep = 0;

    if (!data) return;

    if (mode === 'lorentz' && data.x && data.x.length > 0) {
      const pts = [];
      const maxValX = Math.max(...data.x.map(v => Math.abs(v) || 0), 0.1);
      const maxValY = Math.max(...data.y.map(v => Math.abs(v) || 0), 0.1);
      const maxValZ = Math.max(...data.z.map(v => Math.abs(v) || 0), 0.1);
      const scale = 2.2 / Math.max(maxValX, maxValY, maxValZ, 0.1);

      const bxVal = parseFloat(document.getElementById('Bx')?.value || '0') || 0;
      const byVal = parseFloat(document.getElementById('By')?.value || '0') || 0;
      const bzVal = parseFloat(document.getElementById('Bz')?.value || '1') || 1;

      for (let i = 0; i < data.x.length; i++) {
        const vec = new THREE.Vector3((data.x[i] || 0) * scale, (data.y[i] || 0) * scale, (data.z[i] || 0) * scale);
        pts.push(vec);
        this.pathCoords.push(vec);

        // Safe normalization
        const vVec = new THREE.Vector3(data.vx?.[i] || 0, data.vy?.[i] || 0, data.vz?.[i] || 0);
        if (vVec.lengthSq() > 1e-6) vVec.normalize().multiplyScalar(0.7);
        else vVec.set(0, 0, 0);
        this.vCoords.push(vVec);

        const fVec = new THREE.Vector3(data.Fx?.[i] || 0, data.Fy?.[i] || 0, data.Fz?.[i] || 0);
        if (fVec.lengthSq() > 1e-6) fVec.normalize().multiplyScalar(0.7);
        else fVec.set(0, 0, 0);
        this.fCoords.push(fVec);

        const bVec = new THREE.Vector3(bxVal, byVal, bzVal);
        if (bVec.lengthSq() > 1e-6) bVec.normalize().multiplyScalar(0.8);
        else bVec.set(0, 0, 0.8);
        this.bCoords.push(bVec);
      }

      // Flight trajectory curve line
      const pathGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const pathMat = new THREE.LineBasicMaterial({ color: 0xa855f7, linewidth: 3 });
      this.pathLine = new THREE.Line(pathGeo, pathMat);
      this.scene.add(this.pathLine);

      // Charged Particle sphere
      const particleGeo = new THREE.SphereGeometry(0.12, 32, 32);
      const particleMat = new THREE.MeshStandardMaterial({ 
        color: 0xef4444, 
        emissive: 0x7f1d1d, 
        roughness: 0.2, 
        metalness: 0.5 
      });
      this.particle = new THREE.Mesh(particleGeo, particleMat);
      if (pts.length > 0) this.particle.position.copy(pts[0]);
      this.scene.add(this.particle);

      // Background magnetic field vector grid
      const bGridVec = new THREE.Vector3(bxVal, byVal, bzVal);
      if (bGridVec.lengthSq() > 1e-6) {
        bGridVec.normalize();
        for (let x = -2; x <= 2; x += 1.3) {
          for (let y = -1; y <= 2; y += 1.3) {
            for (let z = -1; z <= 2; z += 1.3) {
              const arrow = new THREE.ArrowHelper(bGridVec, new THREE.Vector3(x, y, z), 0.6, 0x10b981, 0.12, 0.08);
              arrow.line.material.opacity = 0.3;
              arrow.line.material.transparent = true;
              this.vectors.push(arrow);
              this.scene.add(arrow);
            }
          }
        }
      }

    } else if (mode === 'poles' && data.stats) {
      const r = data.stats.distance_m ?? 0.2;
      const distScale = Math.max(r * 3.5, 2.2);

      const qm1 = parseFloat(document.getElementById('qm1')?.value || '100');
      const qm2 = parseFloat(document.getElementById('qm2')?.value || '-100');

      // Magnet 1 (at x = -distScale / 2)
      const magnet1 = this.createBarMagnet(qm1 >= 0);
      magnet1.position.x = -distScale / 2;
      this.magnets.push(magnet1);
      this.scene.add(magnet1);

      // Magnet 2 (at x = distScale / 2)
      const magnet2 = this.createBarMagnet(qm2 >= 0);
      magnet2.position.x = distScale / 2;
      this.magnets.push(magnet2);
      this.scene.add(magnet2);

      // Force Arrows
      const isAttraction = (data.stats.force_n < 0) || (qm1 * qm2 < 0);
      const forceVec1 = new THREE.Vector3(isAttraction ? 1 : -1, 0, 0);
      const forceVec2 = new THREE.Vector3(isAttraction ? -1 : 1, 0, 0);
      const arrowLength = 0.9;
      
      const arrow1 = new THREE.ArrowHelper(forceVec1, new THREE.Vector3(-distScale/2, 0.8, 0), arrowLength, 0xf59e0b, 0.22, 0.14);
      const arrow2 = new THREE.ArrowHelper(forceVec2, new THREE.Vector3(distScale/2, 0.8, 0), arrowLength, 0xf59e0b, 0.22, 0.14);
      
      this.vectors.push(arrow1);
      this.vectors.push(arrow2);
      this.scene.add(arrow1);
      this.scene.add(arrow2);

      // Bezier Field lines between poles
      const groupLines = new THREE.Group();
      const numLines = 8;
      for (let i = 0; i < numLines; i++) {
        const angle = (i * Math.PI * 2) / numLines;
        const curveRadius = 0.6;
        
        const pStart = new THREE.Vector3(-distScale/2 + 0.35, 0, 0);
        const pEnd = new THREE.Vector3(distScale/2 - 0.35, 0, 0);
        const pMid = new THREE.Vector3(0, Math.sin(angle) * curveRadius * distScale * 0.4, Math.cos(angle) * curveRadius * distScale * 0.4);

        const curve = new THREE.QuadraticBezierCurve3(pStart, pMid, pEnd);
        const points = curve.getPoints(32);
        const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.75, linewidth: 2 });
        const line = new THREE.Line(lineGeo, lineMat);
        groupLines.add(line);
      }
      this.fieldLines = groupLines;
      this.scene.add(this.fieldLines);
    }
  },

  createBarMagnet(isNorthLeft) {
    const magnetGroup = new THREE.Group();

    const northGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.7, 24);
    northGeo.rotateZ(Math.PI / 2);
    const northMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.3, roughness: 0.4, emissive: 0x3a0808 });
    const northMesh = new THREE.Mesh(northGeo, northMat);
    northMesh.position.x = isNorthLeft ? -0.35 : 0.35;
    magnetGroup.add(northMesh);

    const southGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.7, 24);
    southGeo.rotateZ(Math.PI / 2);
    const southMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.3, roughness: 0.4, emissive: 0x081a3a });
    const southMesh = new THREE.Mesh(southGeo, southMat);
    southMesh.position.x = isNorthLeft ? 0.35 : -0.35;
    magnetGroup.add(southMesh);

    return magnetGroup;
  },

  // Called every frame; resizeRendererToCanvas memoizes, so it is a no-op
  // until the canvas actually changes size.
  checkSize() {
    resizeRendererToCanvas(
      this.renderer, this.camera, document.getElementById('three-canvas-magnetism'),
    );
  },

  renderFrame() {
    // The loop itself is cancelled when this tab is not visible (see setTab),
    // so this is only a cheap guard for the frame already in flight. It used to
    // reschedule rAF *before* this check, which meant a hidden or paused
    // viewport kept waking up 60 times a second forever.
    if (!this.renderer || GlobalPhysicsManager.activeTab !== 'magnetism') return;

    this.checkSize();

    if (this.autoOrbit) {
      const time = Date.now() * 0.0003;
      const radius = 6.0;
      this.camera.position.x = radius * Math.cos(time);
      this.camera.position.z = radius * Math.sin(time);
      this.camera.position.y = 2.0 + 0.5 * Math.sin(time * 0.5);
      this.camera.lookAt(0, 0, 0);
    }

    // Camera preset transition. This block existed only in ProjectileThree, so
    // the preset buttons set MagnetismThree.transitioning / .targetCameraPos
    // and nothing ever consumed them — on the magnetism tab the presets did
    // nothing but switch auto-orbit off.
    if (this.transitioning && this.targetCameraPos) {
      this.camera.position.lerp(this.targetCameraPos, 0.1);
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);

      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.01) {
        this.camera.position.copy(this.targetCameraPos);
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    }

    if (this.controls) this.controls.update();

    // Sync sliders
    const sliderX = document.getElementById('cam-slider-x');
    const sliderY = document.getElementById('cam-slider-y');
    const sliderZ = document.getElementById('cam-slider-z');
    const valX = document.getElementById('cam-val-x');
    const valY = document.getElementById('cam-val-y');
    const valZ = document.getElementById('cam-val-z');

    if (sliderX && sliderY && sliderZ && this.currentMode !== 'motor') {
      if (document.activeElement !== sliderX) {
        sliderX.value = this.camera.position.x.toFixed(2);
        if (valX) valX.textContent = this.camera.position.x.toFixed(2);
      }
      if (document.activeElement !== sliderY) {
        sliderY.value = this.camera.position.y.toFixed(2);
        if (valY) valY.textContent = this.camera.position.y.toFixed(2);
      }
      if (document.activeElement !== sliderZ) {
        sliderZ.value = this.camera.position.z.toFixed(2);
        if (valZ) valZ.textContent = this.camera.position.z.toFixed(2);
      }
    }

    if (this.currentMode === 'lorentz' && this.particle && this.pathCoords.length > 0) {
      const pos = this.pathCoords[this.animStep];
      this.particle.position.copy(pos);

      // Update the three moving vectors in place.
      //
      // These used to be reconstructed every frame: three `new
      // THREE.ArrowHelper` (each a line geometry + a cone geometry + two
      // materials) at ~60 fps, removed from the scene but never disposed —
      // roughly 180 GPU allocations per second that only the driver ever
      // reclaimed. ArrowHelper exposes setDirection/setLength precisely so the
      // helper can be reused, so build once and move it.
      this.updateMovingArrow('movingVelocityArrow', this.vCoords[this.animStep], pos, 0x38bdf8);
      this.updateMovingArrow('movingForceArrow', this.fCoords[this.animStep], pos, 0xa855f7);
      this.updateMovingArrow('movingBArrow', this.bCoords[this.animStep], pos, 0x10b981);

      // Advance by elapsed time, not one array index per frame: indexing by
      // frame made playback speed depend on the display's refresh rate (the
      // projectile view next to it is already time-based).
      const nowMs = Date.now();
      const deltaS = this._lastStepMs === null ? 0
        : Math.min((nowMs - this._lastStepMs) / 1000, 0.1);
      this._lastStepMs = nowMs;
      this._stepAccumulator += deltaS * LORENTZ_STEPS_PER_SECOND;
      if (this._stepAccumulator >= 1) {
        this.animStep = (this.animStep + Math.floor(this._stepAccumulator)) % this.pathCoords.length;
        this._stepAccumulator %= 1;
      }
    }

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  }
};

const MagnetismMotor = {
  ctx: null,
  canvas: null,
  speedRadS: 0.0,
  currentA: 0.0,
  currentAngle: 0.0,
  simTime: 0.0,
  lastTime: performance.now(),
  animating: true,
  loop: null,
  polesCount: 2,
  poleSpanDeg: 120.0,
  materialName: 'Neodímio N52',
  bGap: 1.23,
  efficiencyPct: 85.0,
  pMech: 0,
  pElec: 0,

  init() {
    this.canvas = document.getElementById('motor-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.tSeries = [0, 1.5];
    this.speedSeries = [0, 0];
    this.iSeries = [0, 0];

    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();
  },

  build(data) {
    if (!data || !data.stats) return;
    this.steadySpeed = data.stats.steady_state_speed_rad_s;
    this.settlingTime = data.stats.settling_time_s;
    this.polesCount = data.stats.poles_count ?? 2;
    this.poleSpanDeg = data.stats.pole_span_deg ?? 120.0;
    this.materialName = data.stats.magnet_material_name || 'Neodímio N52';
    this.bGap = data.stats.b_gap_t ?? 1.23;
    // ?? not ||: a stalled motor really does have 0% efficiency, and `||`
    // discarded that measurement and printed a fabricated 85% on the HUD.
    this.efficiencyPct = data.stats.efficiency_steady_pct ?? data.stats.max_efficiency_pct ?? 0.0;
    this.pMech = data.stats.p_mech_w ?? 0;
    this.pElec = data.stats.p_elec_w ?? 0;

    this.tSeries = data.t || [0, 1.5];
    this.speedSeries = data.speed_rad_s || [0, 0];
    this.iSeries = data.I || [0, 0];
    this.iScale = Math.max(...this.iSeries.map(Math.abs), 1e-6);
    this.speedRadS = 0;
    this.currentA = 0;
    this.currentAngle = 0;
    this.simTime = 0;
  },

  interpolateSeries(t, xArr, yArr) {
    const n = xArr.length;
    if (n === 0) return 0;
    if (t <= xArr[0]) return yArr[0];
    if (t >= xArr[n - 1]) return yArr[n - 1];
    const span = xArr[n - 1] - xArr[0];
    const idxFloat = span > 0 ? ((t - xArr[0]) / span) * (n - 1) : 0;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(idxFloat)));
    const i1 = i0 + 1;
    const frac = idxFloat - i0;
    return yArr[i0] + (yArr[i1] - yArr[i0]) * frac;
  },

  checkSize() {
    if (!this.canvas) return;
    const w = this.canvas.offsetWidth || this.canvas.parentElement?.offsetWidth || 0;
    const h = this.canvas.offsetHeight || this.canvas.parentElement?.offsetHeight || 0;
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  },

  renderFrame() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (!this.ctx || this.canvas.style.display === 'none' || GlobalPhysicsManager.activeTab !== 'magnetism') return;

    this.checkSize();

    if (MagnetismForm.currentMode === 'motor' && this.animating) {
      const tEnd = this.tSeries[this.tSeries.length - 1] || 0.1;
      this.simTime = (this.simTime + dt) % tEnd;
      this.speedRadS = this.interpolateSeries(this.simTime, this.tSeries, this.speedSeries);
      this.currentA = this.interpolateSeries(this.simTime, this.tSeries, this.iSeries);
      this.currentAngle += this.speedRadS * dt;
    }

    this.draw();
  },

  draw() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // 1. Draw Stator Magnets dynamically with specified polesCount and poleSpanDeg
    const N = this.polesCount || 2;
    const rStator = 110;
    const spanRad = (this.poleSpanDeg * Math.PI / 180.0) / (N / 2);
    const arcSpan = Math.min((Math.PI * 2 / N) * 0.85, spanRad);

    for (let k = 0; k < N; k++) {
      const angle = (k * Math.PI * 2) / N;
      const isNorth = (k % 2 === 0);

      ctx.beginPath();
      ctx.arc(cx, cy, rStator, angle - arcSpan / 2, angle + arcSpan / 2);
      ctx.lineWidth = 24;
      ctx.strokeStyle = isNorth ? '#ef4444' : '#3b82f6';
      ctx.stroke();

      const lx = cx + Math.cos(angle) * (rStator + 24);
      const ly = cy + Math.sin(angle) * (rStator + 24);
      ctx.fillStyle = isNorth ? '#f87171' : '#60a5fa';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelText = isNorth ? `N${Math.floor(k/2)+1}` : `S${Math.floor(k/2)+1}`;
      ctx.fillText(labelText, lx, ly);
    }

    // Magnetic field lines between opposing North-South poles
    ctx.beginPath();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(16,185,129,0.45)';
    ctx.lineWidth = 2;

    for (let k = 0; k < N / 2; k++) {
      const angle1 = (k * 2 * Math.PI) / N;
      const angle2 = angle1 + Math.PI;

      for (let offset = -40; offset <= 40; offset += 20) {
        const perpX = Math.cos(angle1 + Math.PI / 2) * offset;
        const perpY = Math.sin(angle1 + Math.PI / 2) * offset;

        const x1 = cx + Math.cos(angle1) * 95 + perpX;
        const y1 = cy + Math.sin(angle1) * 95 + perpY;
        const x2 = cx + Math.cos(angle2) * 95 + perpX;
        const y2 = cy + Math.sin(angle2) * 95 + perpY;

        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]); // clear dash

    // 2. Draw Rotor (Armature)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.currentAngle);

    ctx.beginPath();
    ctx.arc(0, 0, 60, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#000';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.stroke();

    const slotCount = 8;
    for (let i = 0; i < slotCount; i++) {
      const angle = (i * Math.PI * 2) / slotCount;
      const sx = Math.cos(angle) * 44;
      const sy = Math.sin(angle) * 44;

      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
      ctx.strokeStyle = '#b45309';
      ctx.stroke();

      const globalY = -sx * Math.sin(this.currentAngle) + sy * Math.cos(this.currentAngle);
      const iSign = Math.abs(this.currentA) / (this.iScale || 1e-6) > 0.02 ? Math.sign(this.currentA || 1) : 0;
      if (iSign !== 0) {
        ctx.fillStyle = '#000';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const inward = (globalY < 0 ? 1 : -1) * iSign > 0;
        ctx.fillText(inward ? '⨂' : '⊙', sx, sy);
      }
    }

    // Commutator Segments
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fillStyle = '#b45309';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-20, 0); ctx.lineTo(20, 0);
    ctx.moveTo(0, -20); ctx.lineTo(0, 20);
    ctx.strokeStyle = '#000';
    ctx.stroke();

    ctx.restore();

    // 3. Brushes
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(cx - 8, cy - 30, 16, 10);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 8, cy - 30, 16, 10);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 8px monospace';
    ctx.fillText('+', cx + 12, cy - 22);

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(cx - 8, cy + 20, 16, 10);
    ctx.strokeRect(cx - 8, cy + 20, 16, 10);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText('-', cx + 12, cy + 28);

    // 4. On-Canvas HUD Badges & Performance Metrics Overlay
    // Top Left Badge: Magnet Material & Gap Flux
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(14, 14, 260, 48, 8); else ctx.fillRect(14, 14, 260, 48);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`🧲 ${this.materialName}`, 24, 32);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`B_gap = ${this.bGap} T  |  α_p = ${this.poleSpanDeg}° (${this.polesCount} Polos)`, 24, 48);

    // Top Right Badge: Efficiency & Power
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(w - 224, 14, 210, 48, 8); else ctx.fillRect(w - 224, 14, 210, 48);
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`⚡ Eficiência η: ${this.efficiencyPct.toFixed(1)}%`, w - 212, 32);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`P_mech = ${this.pMech} W  |  P_elec = ${this.pElec} W`, w - 212, 48);

    // Bottom Center Display: RPM
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 16px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(this.speedRadS * (30.0 / Math.PI))} RPM`, cx, cy + 155);
  }
};

// =================================================================
// 4. GLOBAL PHYSICS DASHBOARD MANAGER
// =================================================================
const GlobalPhysicsManager = {
  activeTab: 'projectile',
  initialized: false,

  init() {
    this.bindEvents();

    const initialTab = window.PHYSICS_ACTIVE_TAB_CONTEXT || 'projectile';
    
    // Initialize child visuals first so they have their renderers set up
    ProjectileForm.init();
    ProjectileThree.init();

    MagnetismForm.init();
    MagnetismThree.init();
    MagnetismMotor.init();

    this.setTab(initialTab);
  },

  bindEvents() {
    // Dynamic sub-navigation tab switcher click listeners
    document.querySelectorAll('.physics-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        this.setTab(tab);

        // Update URL path dynamically (pushState) for a clean client-side feel
        const newUrl = tab === 'projectile' ? '/api/physics/' : '/api/physics/magnetism/';
        window.history.pushState({ tab }, '', newUrl);
      });
    });

    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.tab) {
        this.setTab(e.state.tab);
      }
    });

    window.addEventListener('resize', () => {
      if (this.activeTab === 'projectile') {
        ProjectileThree.onResize();
      } else if (MagnetismForm.currentMode !== 'motor') {
        MagnetismThree.onResize();
      }
    });

    // The camera overlay (presets, auto-orbit, XYZ sliders) is wired once, in
    // the DOMContentLoaded block at the bottom of this file. It used to be
    // wired here as well, with *different* preset coordinates — every button
    // carried two listeners, so a click snapped the camera to this set and then
    // lerped to the other one (btn-view-inlet's two targets were on opposite
    // sides of the scene). The block below also handles the lerp transition and
    // clears auto-orbit, which this one did not.
  },

  setTab(tab) {
    if (this.activeTab === tab && this.initialized) return;
    this.activeTab = tab;
    this.initialized = true;

    // Active button styling
    document.querySelectorAll('.physics-tab-btn').forEach(b => {
      const isCurrent = b.getAttribute('data-tab') === tab;
      b.classList.toggle('physics-tab-btn--active', isCurrent);
    });

    // Display configuration panels
    document.getElementById('panel-projectile').style.display = tab === 'projectile' ? 'block' : 'none';
    document.getElementById('panel-magnetism').style.display = tab === 'magnetism' ? 'block' : 'none';

    // Display results panels
    document.getElementById('results-projectile').style.display = tab === 'projectile' ? 'block' : 'none';
    document.getElementById('results-magnetism').style.display = tab === 'magnetism' ? 'block' : 'none';

    // Toggle header badges
    document.getElementById('badge-range').style.display = tab === 'projectile' ? 'inline-flex' : 'none';
    document.getElementById('badge-height').style.display = tab === 'projectile' ? 'inline-flex' : 'none';
    
    if (tab === 'projectile') {
      document.getElementById('badge-primary').style.display = 'none';
      document.getElementById('badge-secondary').style.display = 'none';
    } else {
      const mode = MagnetismForm.currentMode;
      document.getElementById('badge-primary').style.display = 'inline-flex';
      document.getElementById('badge-secondary').style.display = mode === 'motor' ? 'inline-flex' : 'none';
    }

    // Stop the render loops that belong to the tab being left. Three
    // viewports live on this page (projectile 3D, magnetism 3D, motor 2D) and
    // all three used to keep running at 60 fps regardless of which was on
    // screen — the per-frame guards skipped the *drawing* but the rAF had
    // already been rescheduled at the top of the loop.
    if (tab === 'projectile') {
      MagnetismThree.loop?.stop();
      MagnetismMotor.loop?.stop();
      ProjectileThree.loop?.start();
    } else {
      ProjectileThree.loop?.stop();
      if (MagnetismForm.currentMode === 'motor') {
        MagnetismThree.loop?.stop();
        MagnetismMotor.loop?.start();
      } else {
        MagnetismMotor.loop?.stop();
        MagnetismThree.loop?.start();
      }
    }

    // Both tabs draw into the same #plotly-chart container with incompatible
    // axes and trace counts, so hand it over cleanly (purge + placeholder)
    // rather than leaving the outgoing tab's figure in place until the
    // incoming one happens to finish solving.
    PlotlyChartHelper.resetPlaceholder(tab);

    // Toggle 3D and 2D canvas visualizers
    const canvasProj = document.getElementById('three-canvas-projectile');
    const canvasMag = document.getElementById('three-canvas-magnetism');
    const canvasMotor = document.getElementById('motor-canvas');
    const camCtrls = document.getElementById('camera-ctrls');

    if (tab === 'projectile') {
      canvasProj.style.display = 'block';
      canvasMag.style.display = 'none';
      canvasMotor.style.display = 'none';
      camCtrls.style.display = 'block';
      
      document.getElementById('projectile-legend').style.display = 'flex';
      document.getElementById('magnetism-legend').style.display = 'none';
      
      requestAnimationFrame(() => ProjectileThree.onResize());
    } else {
      canvasProj.style.display = 'none';
      
      const mode = MagnetismForm.currentMode;
      if (mode === 'motor') {
        canvasMag.style.display = 'none';
        canvasMotor.style.display = 'block';
        camCtrls.style.display = 'none';
      } else {
        canvasMag.style.display = 'block';
        canvasMotor.style.display = 'none';
        camCtrls.style.display = 'block';
        requestAnimationFrame(() => MagnetismThree.onResize());
      }

      document.getElementById('projectile-legend').style.display = 'none';
      document.getElementById('magnetism-legend').style.display = 'flex';
    }

    // Re-render local page headers/titles in correct active language
    this.renderHeaders();

    // Trigger initial simulation solver or restore previous state chart
    if (tab === 'projectile') {
      if (lastResult) {
        ProjectileChart.render(lastResult);
        ProjectileThree.buildTrajectory(lastResult);
      } else {
        ProjectileForm.handleSubmit(true);
      }
    } else {
      if (MagnetismForm.lastResult) {
        MagnetismUI.update(MagnetismForm.lastResult, MagnetismForm.currentMode);
        MagnetismChart.render(MagnetismForm.lastResult, MagnetismForm.currentMode);
        if (MagnetismForm.currentMode === 'motor') {
          MagnetismMotor.build(MagnetismForm.lastResult);
        } else {
          MagnetismThree.build(MagnetismForm.lastResult, MagnetismForm.currentMode);
        }
      } else {
        MagnetismForm.runSimulation(true);
      }
    }
  },

  renderHeaders() {
    const lang = localStorage.getItem('app-language') || 'pt';
    const physicsT = (key, fallback) => window.TRANSLATIONS?.[lang]?.[key] || fallback;

    if (this.activeTab === 'projectile') {
      document.getElementById('page-header-title').textContent = physicsT('physics-proj-title', 'Projectile Motion with Air Resistance');
      document.getElementById('page-header-desc').textContent = physicsT('physics-proj-desc', 'Quadratic drag force ($F_d = -\\frac{1}{2} C_d \\rho A v^2$) · Runge-Kutta numerical integration · Vacuum trajectory comparison · Plotly.js plotting · Three.js 3D flight path');
      
      document.getElementById('workbench-title').textContent = physicsT('physics-proj-wb-title', '🌀 3D Flight Path Workbench');
      document.getElementById('workbench-desc').textContent = physicsT('physics-proj-wb-sub', '3D animated projectile simulation (Three.js)');
      
      const breadcrumbEl = document.getElementById('breadcrumb');
      if (breadcrumbEl) breadcrumbEl.textContent = '⚡ Física / Lançamento de Projéteis';
    } else {
      document.getElementById('page-header-title').textContent = physicsT('physics-mag-title', 'Simulador de Eletromagnetismo e Motores Magnéticos');
      document.getElementById('page-header-desc').textContent = physicsT('physics-mag-desc', 'Força de Lorentz (F = q(v x B)) · Atração/Repulsão de Polos · Equações Diferenciais de Motores de CC · Catálogo Químico de Magnetos');
      
      const mode = MagnetismForm.currentMode;
      if (mode === 'motor') {
        document.getElementById('workbench-title').textContent = physicsT('physics-mag-wb-title-motor', '⚙️ Análise Dinâmica: Motor CC');
        document.getElementById('workbench-desc').textContent = physicsT('physics-mag-wb-desc-motor', 'Representação física do rotor com escovas alimentadas');
      } else {
        document.getElementById('workbench-title').textContent = physicsT('physics-mag-wb-title-field', '🌀 Campo Físico e Trajetória 3D');
        document.getElementById('workbench-desc').textContent = physicsT('physics-mag-wb-desc-field', 'Visualização vetorial interativa');
      }

      const breadcrumbEl = document.getElementById('breadcrumb');
      if (breadcrumbEl) breadcrumbEl.textContent = '⚡ Física / Magnetismo e Motores';
    }
  }
};

const Presets = {
  lorentz: [
    { name: "Próton Lento", q_uc: 10.0, m_mg: 1.0, vx: 15, vy: 10, vz: 0, Bx: 0, By: 0, Bz: 1.5 },
    { name: "Ciclotron Helicoidal", q_uc: 20.0, m_mg: 2.0, vx: 30, vy: 0, vz: 4, Bx: 0, By: 0, Bz: 2.0 },
    { name: "Eletron Campo Inverso", q_uc: -15.0, m_mg: 1.5, vx: 20, vy: 20, vz: 2, Bx: 0.2, By: 0, Bz: -1.0 },
    { name: "Partícula Neutra", q_uc: 0.0, m_mg: 1.0, vx: 25, vy: 15, vz: 0, Bx: 0, By: 0, Bz: 1.0 }
  ],
  poles: [
    { name: "Neodímio Forte N52", qm1: 400.0, qm2: -400.0, r: 0.15 },
    { name: "Atração Moderada", qm1: 150.0, qm2: -150.0, r: 0.3 },
    { name: "Repulsão Direta", qm1: 200.0, qm2: 200.0, r: 0.25 },
    { name: "Imãs Fracos", qm1: 40.0, qm2: -40.0, r: 0.5 }
  ],
  motor: [
    { name: "Motor Alta Rotação", V: 24.0, R: 1.2, L: 0.02, J: 0.01, b: 0.002, Kt: 0.35, Ke: 0.35, tl: 0.2 },
    { name: "Industrial Sobrecarga", V: 48.0, R: 4.0, L: 0.15, J: 0.15, b: 0.02, Kt: 1.2, Ke: 1.2, tl: 3.0 },
    { name: "Motor Bloqueado (Stall)", V: 12.0, R: 3.0, L: 0.05, J: 0.05, b: 0.005, Kt: 0.4, Ke: 0.4, tl: 5.0 },
    { name: "Alta Inércia / Partida", V: 36.0, R: 1.5, L: 0.08, J: 0.4, b: 0.01, Kt: 0.7, Ke: 0.7, tl: 0.8 }
  ]
};

// =================================================================
// 5. INITIALIZATION ON DOM CONTENT LOADED
// =================================================================
document.addEventListener('DOMContentLoaded', () => {
  GlobalPhysicsManager.init();

  const orbitCheckbox = document.getElementById('auto-orbit');
  const sliderX = document.getElementById('cam-slider-x');
  const sliderY = document.getElementById('cam-slider-y');
  const sliderZ = document.getElementById('cam-slider-z');
  const valX = document.getElementById('cam-val-x');
  const valY = document.getElementById('cam-val-y');
  const valZ = document.getElementById('cam-val-z');

  const triggerPreset = (x, y, z) => {
    if (GlobalPhysicsManager.activeTab === 'projectile') {
      ProjectileThree.targetCameraPos = new THREE.Vector3(x, y, z);
      ProjectileThree.transitioning = true;
      ProjectileThree.autoOrbit = false;
    } else {
      MagnetismThree.targetCameraPos = new THREE.Vector3(x, y, z);
      MagnetismThree.transitioning = true;
      MagnetismThree.autoOrbit = false;
    }
    if (orbitCheckbox) orbitCheckbox.checked = false;
  };

  document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(2.5, 1.8, 2.8));
  document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 4));
  document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 4.2, 0.01));
  document.getElementById('btn-view-inlet')?.addEventListener('click', () => triggerPreset(-3.5, 0, 0));

  if (orbitCheckbox) {
    orbitCheckbox.addEventListener('change', (e) => {
      const active = e.target.checked;
      if (GlobalPhysicsManager.activeTab === 'projectile') {
        ProjectileThree.autoOrbit = active;
        if (active) { ProjectileThree.transitioning = false; ProjectileThree.targetCameraPos = null; }
      } else {
        MagnetismThree.autoOrbit = active;
        if (active) { MagnetismThree.transitioning = false; MagnetismThree.targetCameraPos = null; }
      }
    });
  }

  const handleSliderChange = () => {
    // Dragging a slider is a manual camera move, so it cancels auto-orbit and
    // any in-flight preset transition. (This was written as
    // `const active = false`, which read like a lost expression.)
    if (GlobalPhysicsManager.activeTab === 'projectile') {
      ProjectileThree.autoOrbit = false;
      ProjectileThree.transitioning = false;
      ProjectileThree.targetCameraPos = null;
      ProjectileThree.camera.position.set(parseFloat(sliderX.value), parseFloat(sliderY.value), parseFloat(sliderZ.value));
      ProjectileThree.camera.lookAt(0, 0, 0);
      if (ProjectileThree.controls) ProjectileThree.controls.target.set(0, 0, 0);
    } else {
      MagnetismThree.autoOrbit = false;
      MagnetismThree.transitioning = false;
      MagnetismThree.targetCameraPos = null;
      MagnetismThree.camera.position.set(parseFloat(sliderX.value), parseFloat(sliderY.value), parseFloat(sliderZ.value));
      MagnetismThree.camera.lookAt(0, 0, 0);
      if (MagnetismThree.controls) MagnetismThree.controls.target.set(0, 0, 0);
    }
    if (orbitCheckbox) orbitCheckbox.checked = false;
    if (valX) valX.textContent = parseFloat(sliderX.value).toFixed(2);
    if (valY) valY.textContent = parseFloat(sliderY.value).toFixed(2);
    if (valZ) valZ.textContent = parseFloat(sliderZ.value).toFixed(2);
  };

  [sliderX, sliderY, sliderZ].forEach(slider => {
    slider?.addEventListener('input', handleSliderChange);
  });

  // Comparison mode toggle for projectile motion
  const refBtn = document.getElementById('btn-toggle-reference');
  const refBtnLabel = () => {
    const lang = localStorage.getItem('app-language') || 'pt';
    const T = window.TRANSLATIONS?.[lang] || {};
    return referenceResult
      ? (T['physics-proj-cmp-btn-clear'] || '🗑 Clear Reference')
      : (T['physics-proj-cmp-btn-fix'] || '📌 Fix as Reference');
  };
  refBtn?.addEventListener('click', () => {
    if (referenceResult) {
      referenceResult = null;
    } else if (lastResult) {
      referenceResult = lastResult;
    } else {
      return;
    }
    refBtn.removeAttribute('data-i18n');
    refBtn.textContent = refBtnLabel();
    if (lastResult) {
      ProjectileChart.render(lastResult);
      ProjectileThree.buildTrajectory(lastResult);
    }
  });

  // Toggle animation loop globally
  document.getElementById('toggle-animation').addEventListener('click', (e) => {
    if (GlobalPhysicsManager.activeTab === 'projectile') {
      ProjectileThree.animating = !ProjectileThree.animating;
      e.target.textContent = ProjectileThree.animating ? '⏸ Pause' : '▶ Resume';
      if (ProjectileThree.animating) ProjectileThree.animate();
    } else {
      MagnetismThree.animating = !MagnetismThree.animating;
      e.target.textContent = MagnetismThree.animating ? '⏸ Pausar' : '▶ Retomar';
      if (MagnetismThree.animating) MagnetismThree.animate();
    }
  });

  // Resize is handled once, in GlobalPhysicsManager.bindEvents(). A second
  // listener here meant onResize() ran twice per resize event, and this copy
  // also called MagnetismThree.onResize() in motor mode, where the WebGL
  // viewport is hidden behind the 2D canvas.
});

// Re-apply translations once the controller above has built its DOM. The
// template's inline i18n block already merged this page's dictionary and ran
// translatePage, but it did so before this module executed, so anything
// rendered by init() still carries its default-language text.
document.addEventListener('DOMContentLoaded', () => {
  retranslate();
});
