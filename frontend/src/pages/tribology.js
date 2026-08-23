/**
 * frontend/src/pages/tribology.js
 * ==============================
 * Vite page bundle entry point for the Tribology & Gears dashboard.
 *
 * Ported from the inline <script> that used to live in templates/app_tribology/index.html.
 * The shared UI helpers and the API client are imported; Three.js and Plotly
 * stay on the globals installed by the template's vendored <script> tags.
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
// Shared axios client: CSRF header, 30 s timeout, envelope unwrapping and
// normalised errors — replacing this page's own copy of the same fetch wrapper.
import { tribologyAPI, describeApiError, latestOnly, isSuperseded } from '../modules/shared/api.js';
import {
  createAnimationLoop,
  disposeAndRemove,
  resizeRendererToCanvas,
} from '../modules/shared/three-utils.js';

// Only the newest in-flight solve is allowed to repaint the page.
const solveTribology = latestOnly((params, config) => tribologyAPI.calculate(params, config));

// -----------------------------------------------------------------
// 1. FORM & PRESET MANAGER
// -----------------------------------------------------------------
const FormManager = {
  form: document.getElementById('tribology-form'),
  presetSelect: document.getElementById('gear-preset'),
  calculateBtn: document.getElementById('calculate-btn'),

  init() {
    // Preset Selector
    this.presetSelect.addEventListener('change', (e) => {
      const presets = {
        high_speed:   { m: 2.0, z1: 24, z2: 48, rpm: 3000.0, viscosity: 0.02, roughness: 0.2, load: 1000.0 },
        heavy_duty:   { m: 4.0, z1: 18, z2: 36, rpm: 600.0, viscosity: 0.15, roughness: 0.8, load: 8000.0 },
        micro_device: { m: 0.5, z1: 15, z2: 30, rpm: 12000.0, viscosity: 0.005, roughness: 0.1, load: 100.0 },
        standard:     { m: 3.0, z1: 20, z2: 40, rpm: 1500.0, viscosity: 0.04, roughness: 0.5, load: 2000.0 }
      };
      const p = presets[e.target.value];
      if (p) {
        document.getElementById('module_mm').value = p.m;
        document.getElementById('pinion_teeth').value = p.z1;
        document.getElementById('gear_teeth').value = p.z2;
        document.getElementById('pinion_rpm').value = p.rpm;
        document.getElementById('viscosity_pa_s').value = p.viscosity;
        document.getElementById('roughness_um').value = p.roughness;
        document.getElementById('load_n').value = p.load;
        showToast(`Preset: Loaded ${e.target.value.replace('_', ' ').toUpperCase()} parameters`, 'info', 2000);
      }
    });

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Live recalculation: debounced re-solve as the user edits any numeric
    // input, plus an immediate re-solve when a material preset changes.
    // The button remains as an immediate fallback.
    let debounceTimer = null;
    this.form.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.handleSubmit(true), 350);
      });
    });
    document.getElementById('pinion-material')?.addEventListener('change', () => this.handleSubmit(true));
    document.getElementById('gear-material')?.addEventListener('change', () => this.handleSubmit(true));

    // Run initial solve
    this.handleSubmit();
  },

  getInputs() {
    const pinionMatOpt = document.getElementById('pinion-material').selectedOptions[0];
    const gearMatOpt = document.getElementById('gear-material').selectedOptions[0];
    return {
      module_mm:      parseFloat(document.getElementById('module_mm').value),
      pinion_teeth:   parseInt(document.getElementById('pinion_teeth').value),
      gear_teeth:     parseInt(document.getElementById('gear_teeth').value),
      pinion_rpm:     parseFloat(document.getElementById('pinion_rpm').value),
      viscosity_pa_s: parseFloat(document.getElementById('viscosity_pa_s').value),
      roughness_um:   parseFloat(document.getElementById('roughness_um').value),
      load_n:         parseFloat(document.getElementById('load_n').value),
      pinion_youngs_modulus_gpa: parseFloat(pinionMatOpt.dataset.e),
      pinion_poissons_ratio:     parseFloat(pinionMatOpt.dataset.nu),
      gear_youngs_modulus_gpa:   parseFloat(gearMatOpt.dataset.e),
      gear_poissons_ratio:       parseFloat(gearMatOpt.dataset.nu),
    };
  },

  async handleSubmit(auto = false) {
    const inputs = this.getInputs();

    this.calculateBtn.disabled = true;
    if (!auto) {
      document.getElementById('btn-text').textContent = 'Solving…';
      showLoading('Solving spur gear geometry & Dowson-Higginson EHL equations…');
    }

    let result;
    try {
      // Already unwrapped from the {status, data} envelope by the client.
      result = await solveTribology(inputs);
    } catch (e) {
      // A superseded request is not a failure — a newer solve is already running.
      if (isSuperseded(e)) return;
      console.error(e);
      showToast(
        describeApiError(e, 'Error calculating EHL properties. Check constraints.'),
        'error',
      );
      this.calculateBtn.disabled = false;
      if (!auto) {
        document.getElementById('btn-text').textContent = 'Solve Sizing & EHL';
        hideLoading();
      }
      return;
    }

    // Rendering sits outside the request try/catch: a dead 3D viewport used to
    // throw here, be caught above, and report a calculation failure for a
    // calculation that had succeeded.
    try {
      UIUpdater.updateAll(inputs, result);
      PlotlyChart.render(result, inputs);
      ThreeGears.updateGears(inputs.module_mm, inputs.pinion_teeth, inputs.gear_teeth, inputs.pinion_rpm, result.ehl.lambda_parameter, result.ehl.regime_code);
      window.FloatingPanel?.markUpdated('results');

      if (!auto) showToast('Tribology & Gear equations solved successfully!', 'success');
    } catch (e) {
      console.error('Rendering failed after a successful calculation:', e);
      showToast('Results computed, but the viewport failed to render.', 'error');
    } finally {
      this.calculateBtn.disabled = false;
      if (!auto) {
        document.getElementById('btn-text').textContent = 'Solve Sizing & EHL';
        hideLoading();
      }
    }
  }
};

// -----------------------------------------------------------------
// 3. UI UPDATER
// -----------------------------------------------------------------
/**
 * Localised label for a lubrication regime.
 *
 * The service returns `regime` in English (its payload matches the other
 * modules') plus a stable `regime_code`. The UI branches on the code and looks
 * the wording up in the page dictionary, so the label follows the language
 * selector instead of whatever the server happened to say.
 */
function regimeLabel(regimeCode, fallback) {
  const lang = localStorage.getItem('app-language') || 'pt';
  return window.TRANSLATIONS?.[lang]?.[`trib-regime-${regimeCode}`] || fallback;
}

const UIUpdater = {
  updateAll(inputs, result) {
    const e = result.ehl;
    const g = result.geometry;
    
    // Top badges
    document.getElementById('lambda-value').textContent = e.lambda_parameter.toFixed(3);
    document.getElementById('hmin-value').textContent = e.h_min_um.toFixed(4) + ' μm';

    // Status Workbench badge
    const statusTag = document.getElementById('workbench-status');
    if (statusTag) {
      statusTag.textContent = `${regimeLabel(e.regime_code, e.regime)} (Λ=${e.lambda_parameter.toFixed(2)})`;
      statusTag.className = 'regime-tag';
      if (e.regime_code === 'boundary') statusTag.classList.add('regime-tag--turbulent'); // Red-ish
      else if (e.regime_code === 'mixed') statusTag.classList.add('regime-tag--transition'); // Yellow-ish
      else statusTag.classList.add('regime-tag--laminar'); // Green-ish
    }

    // KPI Cards
    document.getElementById('kpi-ratio-val').textContent = g.gear_ratio.toFixed(2);
    document.getElementById('kpi-ratio-desc').textContent = `${inputs.pinion_teeth}T / ${inputs.gear_teeth}T`;
    document.getElementById('kpi-velocity-val').textContent = e.pitch_line_velocity_m_s.toFixed(2);
    document.getElementById('kpi-regime-val').textContent = regimeLabel(e.regime_code, e.regime);
    document.getElementById('kpi-lambda-desc').textContent = `Lambda Λ = ${e.lambda_parameter.toFixed(3)}`;

    // Add colored borders and backgrounds based on EHL status
    const kpiLambda = document.getElementById('kpi-lambda-card');
    kpiLambda.className = 'kpi-card kpi-card--lambda kpi-card--highlight';
    kpiLambda.classList.remove('kpi-card--boundary', 'kpi-card--mixed', 'kpi-card--hydrodynamic');
    
    if (e.regime_code === 'boundary') {
      kpiLambda.classList.add('kpi-card--boundary');
    } else if (e.regime_code === 'mixed') {
      kpiLambda.classList.add('kpi-card--mixed');
    } else {
      kpiLambda.classList.add('kpi-card--hydrodynamic');
    }

    // Detailed Table
    document.getElementById('tbl-d1').textContent = g.pitch_diameter_pinion_mm.toFixed(2) + ' mm';
    document.getElementById('tbl-d2').textContent = g.pitch_diameter_gear_mm.toFixed(2) + ' mm';
    document.getElementById('tbl-a').textContent = g.center_distance_mm.toFixed(2) + ' mm';
    document.getElementById('tbl-u').textContent = e.entrainment_velocity_m_s.toFixed(3) + ' m/s';
    document.getElementById('tbl-f').textContent = e.normal_load_n.toFixed(1) + ' N';
    document.getElementById('tbl-radius').textContent = (e.equivalent_radius_m * 1000).toFixed(2) + ' mm';
    document.getElementById('tbl-u-param').textContent = e.u_dimensionless.toExponential(4);
    document.getElementById('tbl-w-param').textContent = e.w_dimensionless.toExponential(4);
    document.getElementById('tbl-hmin').textContent = e.h_min_um.toFixed(5) + ' μm';
    document.getElementById('tbl-lambda').textContent = e.lambda_parameter.toFixed(4);
  }
};

// -----------------------------------------------------------------
// 4. PLOTLY CHART
// -----------------------------------------------------------------
const PlotlyChart = {
  rendered: false,

  /**
   * @param {Object} result — API payload
   * @param {Object} inputs — the values that produced it (see FormManager.getInputs)
   */
  render(result, inputs) {
    const sweep = result.sweep;

    // Draw the speed sweep line
    const trace = {
      x: sweep.rpms,
      y: sweep.lambdas,
      mode: 'lines',
      name: 'Lambda index (Λ)',
      line: { color: '#a78bfa', width: 3 },
    };

    // Current operating point marker. Taken from the submitted inputs rather
    // than re-read from the DOM: with the 350 ms debounce the field can already
    // hold a newer value than the response being drawn, which put the marker at
    // one speed and the curve at another.
    const opTrace = {
      x: [inputs.pinion_rpm],
      y: [result.ehl.lambda_parameter],
      mode: 'markers',
      name: 'Operating Point',
      marker: { color: '#ffffff', size: 10, line: { color: '#8b5cf6', width: 2 } }
    };

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  '#0d1526',
      font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 10 },
      margin: { t: 10, r: 16, b: 36, l: 48 },
      xaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Pinion Speed (RPM)', font: { size: 10, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 9 }
      },
      yaxis: {
        gridcolor: 'rgba(255,255,255,0.05)',
        zerolinecolor: 'rgba(255,255,255,0.15)',
        title: { text: 'Lambda Parameter (Λ)', font: { size: 10, color: '#64748b' } },
        tickfont: { family: 'JetBrains Mono, monospace', size: 9 }
      },
      legend: { x: 0.05, y: 0.95, font: { size: 8 } },
      
      // Highlight zones using shapes
      shapes: [
        // Boundary Friction Zone (Lambda < 1) - Red band
        {
          type: 'rect',
          xref: 'paper', yref: 'y',
          x0: 0, x1: 1,
          y0: 0, y1: 1.0,
          fillcolor: 'rgba(239, 68, 68, 0.06)',
          line: { width: 0 }
        },
        // Mixed Lubrication Zone (1 <= Lambda < 3) - Yellow band
        {
          type: 'rect',
          xref: 'paper', yref: 'y',
          x0: 0, x1: 1,
          y0: 1.0, y1: 3.0,
          fillcolor: 'rgba(245, 158, 11, 0.06)',
          line: { width: 0 }
        },
        // Full Hydrodynamic Zone (Lambda >= 3) - Green band
        {
          type: 'rect',
          xref: 'paper', yref: 'y',
          x0: 0, x1: 1,
          y0: 3.0, y1: Math.max(10, Math.max(...sweep.lambdas) * 1.1),
          fillcolor: 'rgba(16, 185, 129, 0.06)',
          line: { width: 0 }
        }
      ],

      // Λ = h_min / Rq, so the composite roughness is what the whole curve is
      // normalised against — state it, otherwise the y axis has no scale the
      // reader can anchor to.
      annotations: [{
        xref: 'paper', yref: 'paper',
        x: 1, y: 1.06,
        xanchor: 'right', yanchor: 'bottom',
        showarrow: false,
        text: `Λ = h<sub>min</sub> / Rq · Rq = ${inputs.roughness_um} μm`,
        font: { size: 9, color: '#64748b' },
      }],
    };

    document.getElementById('chart-placeholder')?.remove();

    if (!this.rendered) {
      Plotly.newPlot('plotly-chart', [trace, opTrace], layout, { responsive: true, displaylogo: false });
      this.rendered = true;
    } else {
      Plotly.react('plotly-chart', [trace, opTrace], layout, { responsive: true, displaylogo: false });
    }
  }
};

// -----------------------------------------------------------------
// 5. THREE.JS Spur Gear interlocking simulation
// -----------------------------------------------------------------
const ThreeGears = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  pinionMesh: null,
  gearMesh: null,
  filmIndicator: null,
  
  pinionSpeed: 0.01,
  pinionTeeth: 20,
  gearTeeth: 40,
  module: 3.0,

  targetCameraPos: null,
  // Filled in by init(). Constructing a THREE.Vector3 at module-evaluation time
  // would throw before the `typeof THREE === 'undefined'` guard below could
  // run, taking the form and the chart down with the viewport.
  targetLookAt: null,
  transitioning: false,
  autoOrbit: false,
  loop: null,
  // Accumulated rotation angle. Driven by elapsed time per frame rather than by
  // absolute Date.now(), see renderFrame().
  pinionAngle: 0,
  _lastFrameMs: null,

  init() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas || typeof THREE === 'undefined') return;

    this.targetLookAt = new THREE.Vector3(0, 0, 0);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    this.camera.position.set(0, 0, 3.5);
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
      this.controls.minDistance = 1;
      this.controls.maxDistance = 15;
    }

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const pointLight = new THREE.PointLight(0xffffff, 0.9);
    pointLight.position.set(5, 5, 5);
    this.scene.add(pointLight);

    const dirLight = new THREE.DirectionalLight(0x60a5fa, 0.6);
    dirLight.position.set(-5, -2, -5);
    this.scene.add(dirLight);

    // Grid Floor
    const grid = new THREE.GridHelper(10, 20, 0x1e3a5f, 0x111e35);
    grid.position.y = -1.5;
    this.scene.add(grid);

    // Camera controls listeners
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

    document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(2.0, 1.5, 2.5));
    document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 3.5));
    document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 3.5, 0.01));
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

    // Hover tooltip: raycast against the pinion/gear meshes and show the
    // geometry/speed data already computed for that gear (no API call).
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerleave', () => window.ThreeTooltip?.hide());

    // Start rendering loop. Owns its rAF handle so it can be stopped, and
    // parks itself while the tab is hidden.
    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();

    window.addEventListener('resize', () => this.onResize());
  },

  onPointerMove(e) {
    if (!this.pinionMesh || !this.gearMesh) { window.ThreeTooltip?.hide(); return; }
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects([this.pinionMesh, this.gearMesh]);

    if (hits.length > 0) {
      const isPinion = hits[0].object === this.pinionMesh;
      const teeth = isPinion ? this.pinionTeeth : this.gearTeeth;
      const diameterMm = this.module * teeth;
      const rpm = isPinion ? this.rpm : (this.rpm * this.pinionTeeth / this.gearTeeth);
      const html = `<strong>${isPinion ? 'Pinion' : 'Gear'}</strong> (Z=${teeth})<br>`
        + `d = ${diameterMm.toFixed(1)} mm &middot; ${rpm.toFixed(0)} RPM`;
      window.ThreeTooltip?.show(html, e.clientX, e.clientY);
      return;
    }
    window.ThreeTooltip?.hide();
  },

  createGearGeometry(pitchRadius, numTeeth, thickness) {
    const shape = new THREE.Shape();
    // Dedendum and addendum relative spacing
    const addendum = pitchRadius + 0.15 * (pitchRadius / numTeeth);
    const dedendum = pitchRadius - 0.2 * (pitchRadius / numTeeth);
    
    for (let i = 0; i < numTeeth; i++) {
      const angle = (i / numTeeth) * Math.PI * 2;
      const midAngle1 = angle + (0.25 / numTeeth) * Math.PI * 2;
      const midAngle2 = angle + (0.5 / numTeeth) * Math.PI * 2;
      const midAngle3 = angle + (0.75 / numTeeth) * Math.PI * 2;
      const nextAngle = ((i + 1) / numTeeth) * Math.PI * 2;
      
      const x0 = dedendum * Math.cos(angle);
      const y0 = dedendum * Math.sin(angle);
      
      if (i === 0) {
        shape.moveTo(x0, y0);
      } else {
        shape.lineTo(x0, y0);
      }
      shape.lineTo(addendum * Math.cos(midAngle1), addendum * Math.sin(midAngle1));
      shape.lineTo(addendum * Math.cos(midAngle2), addendum * Math.sin(midAngle2));
      shape.lineTo(dedendum * Math.cos(midAngle3), dedendum * Math.sin(midAngle3));
      shape.lineTo(dedendum * Math.cos(nextAngle), dedendum * Math.sin(nextAngle));
    }
    
    // Add central shaft shaft hole
    const holePath = new THREE.Path();
    holePath.absarc(0, 0, Math.min(0.25, pitchRadius * 0.28), 0, Math.PI * 2, true);
    shape.holes.push(holePath);

    const extrudeSettings = {
      depth: thickness,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.015,
      bevelThickness: 0.015
    };
    
    return new THREE.ExtrudeGeometry(shape, extrudeSettings);
  },

  updateGears(module, Z1, Z2, rpm, lambda, regimeCode) {
    // 1. Remove old meshes, releasing their GPU buffers. These are
    // ExtrudeGeometry built from an N-tooth THREE.Shape — the most expensive
    // geometry in the project — and this runs on every debounced re-solve, so
    // detaching without disposing leaked a full gear pair per keystroke.
    this.pinionMesh = disposeAndRemove(this.scene, this.pinionMesh);
    this.gearMesh = disposeAndRemove(this.scene, this.gearMesh);
    this.filmIndicator = disposeAndRemove(this.scene, this.filmIndicator);

    this.module = module;
    this.pinionTeeth = Z1;
    this.gearTeeth = Z2;
    this.rpm = rpm;
    // Rotation speed based on RPM input
    this.pinionSpeed = (rpm / 1500.0) * 0.4;

    // 2. Standard pitch diameters
    const d1 = module * Z1;
    const d2 = module * Z2;
    const r1 = d1 / 2.0;
    const r2 = d2 / 2.0;

    // Scale viewport coordinates so max gear radius is scaled to 1.1 units
    const maxR = Math.max(r1, r2);
    const scale = 1.1 / maxR;
    const r1_s = r1 * scale;
    const r2_s = r2 * scale;
    const thick_s = 0.22;

    // 3. Materials
    const pinionMat = new THREE.MeshPhongMaterial({ color: 0x60a5fa, shininess: 80, specular: 0x555555 });
    const gearMat = new THREE.MeshPhongMaterial({ color: 0xf59e0b, shininess: 80, specular: 0x555555 });

    // 4. Create Geometries
    const pinionGeo = this.createGearGeometry(r1_s, Z1, thick_s);
    const gearGeo = this.createGearGeometry(r2_s, Z2, thick_s);

    // Center geometry origins to be in middle of gear
    pinionGeo.center();
    gearGeo.center();

    this.pinionMesh = new THREE.Mesh(pinionGeo, pinionMat);
    this.gearMesh = new THREE.Mesh(gearGeo, gearMat);

    // Position them so their pitch point contact is at the exact origin (0,0,0)
    this.pinionMesh.position.set(-r1_s, 0, 0);
    this.gearMesh.position.set(r2_s, 0, 0);

    this.scene.add(this.pinionMesh);
    this.scene.add(this.gearMesh);

    // 5. Contact point oil film indicator
    const filmColor = regimeCode === 'boundary' ? 0xef4444 : (regimeCode === 'mixed' ? 0xf59e0b : 0x34d399);
    const filmGeo = new THREE.SphereGeometry(0.045, 16, 16);
    const filmMat = new THREE.MeshBasicMaterial({ color: filmColor, transparent: true, opacity: 0.85 });
    this.filmIndicator = new THREE.Mesh(filmGeo, filmMat);
    this.filmIndicator.position.set(0, 0, thick_s / 2);
    this.scene.add(this.filmIndicator);
  },

  renderFrame() {
    if (!this.renderer) return;

    const nowMs = Date.now();
    const deltaS = this._lastFrameMs === null
      ? 0
      : Math.min((nowMs - this._lastFrameMs) / 1000, 0.1); // clamp after a tab stall
    this._lastFrameMs = nowMs;

    // Rotate gears synchronously.
    //
    // The angle is *accumulated* from elapsed time rather than computed as
    // `Date.now() * speed`. With the absolute form, changing the RPM rescaled
    // the whole elapsed-time axis at once, so both gears jumped instantly to a
    // completely different phase — and since only the pinion angle was rescaled
    // while the mesh offset stayed fixed, the teeth visibly stopped meshing.
    if (this.pinionMesh && this.gearMesh) {
      this.pinionAngle += deltaS * this.pinionSpeed;

      const theta1 = this.pinionAngle;
      // Rotation of Gear is opposite and ratioed
      const theta2 = -(theta1 * this.pinionTeeth / this.gearTeeth) + (Math.PI + Math.PI / this.gearTeeth);

      this.pinionMesh.rotation.z = theta1;
      this.gearMesh.rotation.z = theta2;
    }

    // Camera Auto-orbit
    if (this.autoOrbit) {
      const orbitTime = Date.now() * 0.0004;
      const radius = 3.5;
      this.camera.position.x = radius * Math.cos(orbitTime);
      this.camera.position.z = radius * Math.sin(orbitTime);
      this.camera.position.y = 0.5 * Math.sin(orbitTime * 0.5);
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
    }

    // Camera preset lerping
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

    // Sync camera slider coordinates
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
  ThreeGears.init();
});

// Re-apply translations once the controller above has built its DOM. The
// template's inline i18n block already merged this page's dictionary and ran
// translatePage, but it did so before this module executed, so anything
// rendered by init() still carries its default-language text.
document.addEventListener('DOMContentLoaded', () => {
  retranslate();
});
