/**
 * frontend/src/modules/fluids/fluids-three.js
 * ===============================================
 * Three.js 3D pipe flow viewport.
 *
 * Scene composition:
 *   - Transparent cylindrical pipe along the X axis, radius scaled to the
 *     real bore on a log scale
 *   - 600 coloured particles whose speed follows the velocity profile
 *   - Velocity-to-colour mapping: blue (slow) → green → red (fast)
 *   - Camera presets, manual XYZ sliders, auto-orbit, and OrbitControls
 *
 * Ported verbatim from the inline controller that used to live in
 * templates/app_fluids/pipe_flow.html. The previous version of this module was
 * a simpler, drifted reimplementation (fixed radius, no OrbitControls, no
 * presets) that had never been loaded by a page — the template's copy was the
 * one users actually ran, so that is the behaviour preserved here.
 *
 * Exports:
 *   ThreePipe.init()
 *   ThreePipe.updateParticles(result, diameterMm)
 */

// THREE, OrbitControls and Plotly are read from the globals installed by the
// vendored <script> tags in the template, not imported from npm. The vendored
// three build is r128 (2021) while package.json resolves to 0.166 — a jump of
// ~38 revisions that includes r155's redefinition of light intensity units, so
// the two are not interchangeable and this code targets the vendored one.
// (The vendored plotly is plotly.js-dist@2.33.0, the same major version npm
// resolves to; only three actually differs.)

import {
  createAnimationLoop,
  disposeAndRemove,
  resizeRendererToCanvas,
} from '../shared/three-utils.js';

// Particle drift is expressed in scene units per frame, but the real velocity
// spans ~5 orders of magnitude (a 0.1 mm bore reaches hundreds of m/s). Feeding
// it in raw made particles jump more than a scene unit per frame across a
// 4-unit pipe, which reads as a flicker at the inlet rather than as flow, while
// slow flows looked frozen. Map it the same way the radius is mapped: on a log
// scale, into a band that stays legible at both ends.
const FLOW_SPEED_MS_MIN = 1e-3;
const FLOW_SPEED_MS_MAX = 1e3;
const FLOW_SCENE_SPEED_MIN = 0.15;
const FLOW_SCENE_SPEED_MAX = 2.5;

export function velocityMsToSceneSpeed(velocityMs) {
  const clamped = Math.min(Math.max(Math.abs(velocityMs), FLOW_SPEED_MS_MIN), FLOW_SPEED_MS_MAX);
  const logMin = Math.log10(FLOW_SPEED_MS_MIN);
  const logMax = Math.log10(FLOW_SPEED_MS_MAX);
  const frac = (Math.log10(clamped) - logMin) / (logMax - logMin);
  return FLOW_SCENE_SPEED_MIN + frac * (FLOW_SCENE_SPEED_MAX - FLOW_SCENE_SPEED_MIN);
}

// Scene length is kept fixed (pipe length ranges from mm to 100 km, which
// cannot be mapped to scene units without making the tube invisible or the
// camera useless). The radius, however, is scaled to the real diameter on a
// log scale — diameter_mm ranges over 5 orders of magnitude (0.1–10000 mm),
// so a linear mapping would make most real-world diameters look identical.
const PIPE_SCENE_LENGTH = 4.0;
const PIPE_DIAMETER_MM_MIN = 0.1;
const PIPE_DIAMETER_MM_MAX = 10000.0;
const PIPE_SCENE_RADIUS_MIN = 0.15;
const PIPE_SCENE_RADIUS_MAX = 0.9;

export function diameterMmToSceneRadius(diameterMm) {
  const clamped = Math.min(Math.max(diameterMm, PIPE_DIAMETER_MM_MIN), PIPE_DIAMETER_MM_MAX);
  const logMin = Math.log10(PIPE_DIAMETER_MM_MIN);
  const logMax = Math.log10(PIPE_DIAMETER_MM_MAX);
  const frac = (Math.log10(clamped) - logMin) / (logMax - logMin);
  return PIPE_SCENE_RADIUS_MIN + frac * (PIPE_SCENE_RADIUS_MAX - PIPE_SCENE_RADIUS_MIN);
}

export const ThreePipe = {
  scene:     null,
  camera:    null,
  renderer:  null,
  controls:  null,
  particles: null,
  pipeMesh:  null,
  endRings:  [],
  pipeRadiusScene: 0.5,
  animating: true,
  velocities: [],
  maxVelocity: 1,

  // Camera state for transitions & auto-orbit. targetLookAt is filled in by
  // init(): constructing a THREE.Vector3 here would run at module-evaluation
  // time, so a failed vendored-script load would throw before any of the
  // `typeof THREE === 'undefined'` guards below could run, taking the form and
  // the charts down with the viewport.
  targetCameraPos: null,
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

    // Camera (perspective, looking along pipe axis)
    this.camera = new THREE.PerspectiveCamera(50, canvas.offsetWidth / canvas.offsetHeight, 0.01, 100);
    this.camera.position.set(3, 1.5, 3);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=false: let the stylesheet own the canvas box (see
    // resizeRendererToCanvas). Passing the default true pins width/height in
    // px and freezes the viewport at its first-load size.
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // Orbit Controls for dynamic XYZ rotation/zoom/pan. The vendored
    // OrbitControls.js attaches itself to the THREE global.
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 10;

    // Ambient + directional light
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0x6699ff, 1.2);
    dirLight.position.set(2, 4, 3);
    this.scene.add(dirLight);

    // Pipe mesh + end caps, sized from the current form diameter (falls back
    // to the default radius if the field isn't populated yet).
    const initialDiameterMm = parseFloat(document.getElementById('diameter_mm')?.value) || 50.0;
    this.rebuildPipeGeometry(initialDiameterMm);

    // Set up DOM elements for camera controls
    const orbitCheckbox = document.getElementById('auto-orbit');
    const sliderX = document.getElementById('cam-slider-x');
    const sliderY = document.getElementById('cam-slider-y');
    const sliderZ = document.getElementById('cam-slider-z');
    const valX = document.getElementById('cam-val-x');
    const valY = document.getElementById('cam-val-y');
    const valZ = document.getElementById('cam-val-z');

    // Auto-Orbit toggle
    if (orbitCheckbox) {
      orbitCheckbox.addEventListener('change', (e) => {
        this.autoOrbit = e.target.checked;
        if (this.autoOrbit) {
          this.transitioning = false;
          this.targetCameraPos = null;
        }
      });
    }

    // Camera preset helper function
    const triggerPreset = (x, y, z) => {
      this.targetCameraPos = new THREE.Vector3(x, y, z);
      this.transitioning = true;
      this.autoOrbit = false;
      if (orbitCheckbox) orbitCheckbox.checked = false;
    };

    document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(3, 1.5, 3));
    document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 4));
    document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 4.2, 0.01)); // slight offset to prevent Euler gimbal lock
    document.getElementById('btn-view-inlet')?.addEventListener('click', () => triggerPreset(-3.5, 0, 0));

    // Manual slider inputs
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

    // Initial particles with default (uniform) velocities
    this.createParticles(1.0, 'Laminar');

    // Start animation loop. The loop owns its rAF handle so it can actually be
    // stopped; calling start() twice is a no-op rather than a second loop.
    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();

    // Toggle button. This only pauses the *particle* animation — the render
    // loop keeps running so OrbitControls and the camera presets stay live
    // while paused, which they did not when the toggle stopped rAF outright.
    document.getElementById('toggle-animation')?.addEventListener('click', (e) => {
      this.animating = !this.animating;
      e.target.textContent = this.animating ? '⏸ Pause' : '▶ Resume';
    });

    // Resize handler
    window.addEventListener('resize', () => this.onResize());
  },

  rebuildPipeGeometry(diameterMm) {
    if (!this.scene) return;

    // Dispose geometry *and* material: this runs on every diameter change, and
    // materials used to leak here (only geometry was released). The end rings
    // also shared one geometry between both meshes, so the old per-ring
    // dispose() ran twice over the same buffer.
    this.pipeMesh = disposeAndRemove(this.scene, this.pipeMesh);
    this.endRings.forEach(ring => disposeAndRemove(this.scene, ring));
    this.endRings = [];

    const sceneRadius = diameterMmToSceneRadius(diameterMm);
    this.pipeRadiusScene = sceneRadius;

    const pipeGeo = new THREE.CylinderGeometry(sceneRadius, sceneRadius, PIPE_SCENE_LENGTH, 32, 1, true);
    const pipeMat = new THREE.MeshPhongMaterial({
      color: 0x1e3a5f,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      wireframe: false,
    });
    this.pipeMesh = new THREE.Mesh(pipeGeo, pipeMat);
    this.pipeMesh.rotation.z = Math.PI / 2;  // Horizontal pipe (along X axis)
    this.scene.add(this.pipeMesh);

    // Pipe end caps (rings), radius/tube thickness scaled with the pipe
    const ringGeo = new THREE.TorusGeometry(sceneRadius, Math.max(sceneRadius * 0.04, 0.008), 12, 32);
    const ringMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, opacity: 0.6, transparent: true });
    [-PIPE_SCENE_LENGTH / 2, PIPE_SCENE_LENGTH / 2].forEach(x => {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.x = x;
      ring.rotation.y = Math.PI / 2;
      this.scene.add(ring);
      this.endRings.push(ring);
    });
  },

  createParticles(maxVel, regime) {
    // Disposes the PointsMaterial too — it used to be re-created and leaked on
    // every rebuild, i.e. on every debounced re-solve.
    this.particles = disposeAndRemove(this.scene, this.particles);

    const N = 600;
    const R = this.pipeRadiusScene;  // Pipe inner radius in scene units (real diameter, log-scaled)
    const L = PIPE_SCENE_LENGTH;     // Pipe length in scene units (fixed, see comment above)

    const positions = new Float32Array(N * 3);
    const colors    = new Float32Array(N * 3);
    this.velocities = new Array(N);

    for (let i = 0; i < N; i++) {
      // Random position inside cylinder
      const r     = R * Math.sqrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const x     = (Math.random() - 0.5) * L;

      positions[i * 3]     = x;
      positions[i * 3 + 1] = r * Math.cos(theta);
      positions[i * 3 + 2] = r * Math.sin(theta);

      // Velocity from profile (normalised r/R)
      const rNorm = r / R;
      let vNorm;
      if (regime === 'Laminar') {
        vNorm = 1.0 - rNorm * rNorm;  // parabolic
      } else {
        vNorm = Math.pow(Math.max(0, 1 - rNorm), 1 / 7);  // power law
      }

      this.velocities[i] = vNorm * maxVel;

      // Color: blue (slow) → cyan → green → yellow → red (fast)
      const t = vNorm;
      const c = new THREE.Color().setHSL(0.65 - t * 0.65, 1.0, 0.55);
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      sizeAttenuation: true,
    });

    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
    this.maxVelocity = maxVel;
  },

  updateParticles(result, diameterMm) {
    if (!this.scene) return;
    // Re-scale the pipe/rings to the real diameter before rebuilding
    // particles, so the 3D geometry always matches what was submitted.
    if (diameterMm) this.rebuildPipeGeometry(diameterMm);
    // Log-scale the real velocity into a drift rate that stays readable across
    // the whole 0.001-1000 m/s range the API can return.
    const maxV = result.velocity_m_s > 0
      ? velocityMsToSceneSpeed(result.velocity_m_s)
      : FLOW_SCENE_SPEED_MIN;
    this.createParticles(maxV, result.flow_regime);
  },

  renderFrame() {
    if (!this.renderer) return;

    // 1. Handle auto-orbit rotation
    if (this.autoOrbit) {
      const time = Date.now() * 0.0005;
      const radius = 4.2;
      this.camera.position.x = radius * Math.cos(time);
      this.camera.position.z = radius * Math.sin(time);
      this.camera.position.y = 1.2 + 0.6 * Math.sin(time * 0.5);
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
    }

    // 2. Handle preset transitions (lerp)
    if (this.transitioning && this.targetCameraPos) {
      this.camera.position.lerp(this.targetCameraPos, 0.1);
      this.camera.lookAt(this.targetLookAt);
      if (this.controls) this.controls.target.copy(this.targetLookAt);

      // Stop transitioning if we are close enough
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.01) {
        this.camera.position.copy(this.targetCameraPos);
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    }

    if (this.controls) {
      this.controls.update();
    }

    // 3. Sync sliders with the actual camera position
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

    if (this.animating && this.particles) {
      const pos = this.particles.geometry.attributes.position;
      const L   = PIPE_SCENE_LENGTH;
      const dt  = 0.006;

      for (let i = 0; i < pos.count; i++) {
        // Move particle along pipe axis (X direction)
        let x = pos.array[i * 3] + this.velocities[i] * dt;

        // Wrap around pipe length. A plain `if (x > L/2) x = -L/2` only works
        // while a particle advances less than one pipe length per frame; a fast
        // flow overshot the far end by several lengths and every particle got
        // slammed back to exactly the inlet, which looked like a flicker rather
        // than flow. Modulo keeps the overshoot as position within the pipe.
        if (x > L / 2) x = -L / 2 + ((x + L / 2) % L);
        else if (x < -L / 2) x = L / 2 - ((L / 2 - x) % L);

        pos.array[i * 3] = x;
      }
      pos.needsUpdate = true;

      // Slow pipe rotation for visual depth
      this.particles.rotation.x += 0.001;
    }

    this.renderer.render(this.scene, this.camera);
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer,
      this.camera,
      document.getElementById('three-canvas'),
    );
  },
};
