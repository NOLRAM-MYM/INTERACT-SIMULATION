// =================================================================
// frontend/src/pages/biology.js
// =================================================================
// Advanced Interactive Molecular & Cellular Biology Simulation Engine
// Three.js (r128), Plotly & REST API integration.
// Features:
// - B-DNA Double Helix with Major/Minor Grooves & Purine/Pyrimidine Geometry
// - 3D Ribosome Translation & Polypeptide Synthesis Engine
// - Ultra-detailed Eukaryotic Animal & Plant Cell Anatomies
// - Microscopic Gram+/- Bacteria & Bacteriophage T4 with Infection
// - Multi-stage Cellular Infection Dynamics & Real-time Telemetry
// - Interactive Raycaster: Hover names, anatomical functions & click focus
// =================================================================

import { showToast, showLoading, hideLoading } from '../modules/shared/utils.js';
import {
  createAnimationLoop,
  disposeObject3D,
  resizeRendererToCanvas,
} from '../modules/shared/three-utils.js';
import { biologyAPI, describeApiError } from '../modules/shared/api.js';


// =================================================================
// 1. THREE.JS 3D BIOLOGY VIEWER (Ultra-Realistic with Raycaster)
// =================================================================
const ThreeBioViewer = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  activeGroup: null,
  autoRotate: true,
  targetCameraPos: null,
  targetLookAt: null,
  transitioning: false,
  camSliders: null,
  loop: null,
  currentMode: 'dna-helix',
  animatedObjects: [],
  raycaster: null,
  mouse: null,
  hoveredMesh: null,
  hoveredOriginalEmissive: null,
  hoveredOriginalEmissiveIntensity: 0,
  tooltipEl: null,
  canvasWrapEl: null,
  clock: null,

  init() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas || typeof THREE === 'undefined') return;

    this.canvasWrapEl = canvas.closest('.sim-canvas-wrap');
    this.tooltipEl = document.getElementById('three-tooltip');
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-999, -999);
    this.targetLookAt = new THREE.Vector3(0, 0, 0);
    this.clock = new THREE.Clock();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);
    this.scene.fog = new THREE.FogExp2(0x050b18, 0.007);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    this.camera.position.set(0, 0, 45);
    this.camera.lookAt(0, 0, 0);

    // Renderer with ACES Filmic Tone Mapping
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;

    // Lighting (Realistic Biological Studio Lighting)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0x38bdf8, 1.5);
    dirLight1.position.set(35, 45, 35);
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xec4899, 1.2);
    dirLight2.position.set(-35, -35, -25);
    this.scene.add(dirLight2);

    const pointLight = new THREE.PointLight(0x60a5fa, 0.9, 120);
    pointLight.position.set(0, 20, 30);
    this.scene.add(pointLight);

    // Orbit Controls
    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.06;
      this.controls.maxDistance = 180;
      this.controls.minDistance = 6;
    }

    // Camera Controls overlay setup
    const orbitCheckbox = document.getElementById('auto-orbit');
    orbitCheckbox?.addEventListener('change', (e) => {
      this.autoRotate = e.target.checked;
      if (this.autoRotate) {
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    });

    const triggerPreset = (x, y, z) => {
      this.targetCameraPos = new THREE.Vector3(x, y, z);
      this.targetLookAt = new THREE.Vector3(0, 0, 0);
      this.transitioning = true;
      this.autoRotate = false;
      if (orbitCheckbox) orbitCheckbox.checked = false;
    };

    document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(25, 20, 35));
    document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 45));
    document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 45, 0.01));
    document.getElementById('btn-view-inlet')?.addEventListener('click', () => triggerPreset(-45, 0, 0));

    // XYZ sliders
    this.camSliders = {
      x: document.getElementById('cam-slider-x'),
      y: document.getElementById('cam-slider-y'),
      z: document.getElementById('cam-slider-z'),
      valX: document.getElementById('cam-val-x'),
      valY: document.getElementById('cam-val-y'),
      valZ: document.getElementById('cam-val-z'),
    };

    const onSliderInput = () => {
      if (!this.camSliders) return;
      this.transitioning = false;
      this.autoRotate = false;
      if (orbitCheckbox) orbitCheckbox.checked = false;

      const px = parseFloat(this.camSliders.x?.value || 0);
      const py = parseFloat(this.camSliders.y?.value || 0);
      const pz = parseFloat(this.camSliders.z?.value || 45);
      this.camera.position.set(px, py, pz);
      if (this.controls) this.controls.target.set(0, 0, 0);
    };

    this.camSliders.x?.addEventListener('input', onSliderInput);
    this.camSliders.y?.addEventListener('input', onSliderInput);
    this.camSliders.z?.addEventListener('input', onSliderInput);

    // Active Group for dynamic models
    this.activeGroup = new THREE.Group();
    this.scene.add(this.activeGroup);

    // Raycaster Mouse & Pointer Listeners
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerleave', () => this.onPointerLeave());
    canvas.addEventListener('click', (e) => this.onPointerClick(e));

    // Animation Loop
    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();

    // Resize listener
    window.addEventListener('resize', () => this.onResize());
  },

  onPointerMove(event) {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast recursively against all children in activeGroup
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.activeGroup.children, true);

    if (intersects.length > 0) {
      let hitMesh = intersects[0].object;
      
      // Walk up parents to find assigned biological userData
      while (hitMesh && !hitMesh.userData?.title && hitMesh.parent && hitMesh.parent !== this.activeGroup) {
        hitMesh = hitMesh.parent;
      }

      if (hitMesh?.userData?.title) {
        if (this.hoveredMesh !== hitMesh) {
          this.unhighlightMesh();
          this.hoveredMesh = hitMesh;
          this.highlightMesh(hitMesh);
        }

        // Show Tooltip and live update dashboard info
        this.showTooltip(event.clientX - rect.left, event.clientY - rect.top, hitMesh.userData);
        
        const wbStatus = document.getElementById('workbench-status');
        if (wbStatus) wbStatus.textContent = hitMesh.userData.title;
        
        canvas.style.cursor = 'pointer';
        return;
      }
    }

    this.unhighlightMesh();
    this.hideTooltip();
    canvas.style.cursor = 'grab';
  },

  onPointerLeave() {
    this.unhighlightMesh();
    this.hideTooltip();
  },

  onPointerClick() {
    if (this.hoveredMesh?.userData) {
      const worldPos = new THREE.Vector3();
      this.hoveredMesh.getWorldPosition(worldPos);
      
      // Smoothly zoom and frame the selected biological structure
      this.targetLookAt = worldPos.clone();
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.targetLookAt).normalize().multiplyScalar(18);
      this.targetCameraPos = worldPos.clone().add(offset);
      this.transitioning = true;
      this.autoRotate = false;
      const orbitCheckbox = document.getElementById('auto-orbit');
      if (orbitCheckbox) orbitCheckbox.checked = false;

      showToast(`🔍 Inspecionando: ${this.hoveredMesh.userData.title}`, 'info', 2200);
    }
  },

  showTooltip(x, y, data) {
    if (!this.tooltipEl) return;
    document.getElementById('tt-title').textContent = data.title || 'Estrutura Biológica';
    document.getElementById('tt-badge').textContent = data.category || 'Elemento';
    document.getElementById('tt-desc').textContent = data.desc || '';
    
    const extraEl = document.getElementById('tt-extra');
    if (extraEl) {
      extraEl.textContent = data.extra || '';
      extraEl.style.display = data.extra ? 'block' : 'none';
    }

    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = `${Math.min(x, this.canvasWrapEl.clientWidth - 140)}px`;
    this.tooltipEl.style.top = `${Math.max(y, 40)}px`;
  },

  hideTooltip() {
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  },

  highlightMesh(mesh) {
    if (mesh.material) {
      if (!this.hoveredOriginalEmissive) {
        this.hoveredOriginalEmissive = mesh.material.emissive ? mesh.material.emissive.clone() : new THREE.Color(0x000000);
        this.hoveredOriginalEmissiveIntensity = mesh.material.emissiveIntensity !== undefined ? mesh.material.emissiveIntensity : 1.0;
      }
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x38bdf8);
        mesh.material.emissiveIntensity = 0.8;
      }
    }
  },

  unhighlightMesh() {
    if (this.hoveredMesh) {
      if (this.hoveredMesh.material && this.hoveredMesh.material.emissive && this.hoveredOriginalEmissive) {
        this.hoveredMesh.material.emissive.copy(this.hoveredOriginalEmissive);
        this.hoveredMesh.material.emissiveIntensity = this.hoveredOriginalEmissiveIntensity;
      }
      this.hoveredMesh = null;
      this.hoveredOriginalEmissive = null;
    }
  },

  renderFrame() {
    if (!this.renderer || !this.scene || !this.camera) return;

    if (this.controls) this.controls.update();

    if (this.autoRotate && this.activeGroup) {
      this.activeGroup.rotation.y += 0.0035;
    }

    // Delta-time based dynamic physics & organic micro-vibrations
    const elapsedTime = this.clock ? this.clock.getElapsedTime() : Date.now() * 0.001;
    this.animatedObjects.forEach(fn => fn(elapsedTime));

    // Smooth Camera Transition (Lerp)
    if (this.transitioning && this.targetCameraPos) {
      this.camera.position.lerp(this.targetCameraPos, 0.065);
      if (this.controls) this.controls.target.lerp(this.targetLookAt, 0.065);
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.08) {
        this.camera.position.copy(this.targetCameraPos);
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    }

    // Synchronize XYZ sliders
    if (this.camSliders && !this.transitioning) {
      if (this.camSliders.x) this.camSliders.x.value = this.camera.position.x;
      if (this.camSliders.y) this.camSliders.y.value = this.camera.position.y;
      if (this.camSliders.z) this.camSliders.z.value = this.camera.position.z;
      if (this.camSliders.valX) this.camSliders.valX.textContent = this.camera.position.x.toFixed(1);
      if (this.camSliders.valY) this.camSliders.valY.textContent = this.camera.position.y.toFixed(1);
      if (this.camSliders.valZ) this.camSliders.valZ.textContent = this.camera.position.z.toFixed(1);
    }

    this.renderer.render(this.scene, this.camera);
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer, this.camera, document.getElementById('three-canvas'),
    );
  },

  clearActiveGroup() {
    this.unhighlightMesh();
    this.hideTooltip();
    this.animatedObjects = [];

    if (!this.activeGroup) return;
    this.scene.remove(this.activeGroup);
    disposeObject3D(this.activeGroup);
    this.activeGroup = new THREE.Group();
    this.scene.add(this.activeGroup);
  },

  registerInteractive(mesh, data) {
    if (!mesh) return;
    mesh.userData = data;
  },

  // ---------------------------------------------------------------
  // 3D MODEL 1A: DNA DOUBLE HELIX (B-DNA)
  // ---------------------------------------------------------------
  buildDnaDoubleHelix(sequence = 'ATGGGCATTGTGGAACAATGCTGT') {
    this.clearActiveGroup();
    this.currentMode = 'dna-helix';

    const baseData = {
      'A': { color: 0xef4444, name: 'Adenina (A)', type: 'Purina (Anel Duplo)', hBonds: 2, extra: 'Forma 2 pontes de H com a Timina' },
      'T': { color: 0x3b82f6, name: 'Timina (T)', type: 'Pirimidina (Anel Simples)', hBonds: 2, extra: 'Substituída por Uracila (U) no RNA' },
      'C': { color: 0x10b981, name: 'Citosina (C)', type: 'Pirimidina (Anel Simples)', hBonds: 3, extra: 'Forma 3 pontes de H com a Guanina (Elevado Tm)' },
      'G': { color: 0xf59e0b, name: 'Guanina (G)', type: 'Purina (Anel Duplo)', hBonds: 3, extra: 'Aumenta estabilidade térmica do duplex' },
    };

    const complementMap = { 'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C' };

    const numBasePairs = Math.min(sequence.length, 36);
    const helixRadius = 4.8;
    const risePerBase = 1.35;
    const twistPerBase = 0.628;

    const strand1Points = [];
    const strand2Points = [];

    const backboneSphereGeo = new THREE.SphereGeometry(0.48, 18, 18);
    const backboneMat = new THREE.MeshStandardMaterial({
      color: 0x8b5cf6,
      roughness: 0.3,
      metalness: 0.15,
      emissive: 0x3b0764,
      emissiveIntensity: 0.35
    });

    for (let i = 0; i < numBasePairs; i++) {
      const angle1 = i * twistPerBase;
      const angle2 = angle1 + Math.PI;
      const y = (i - numBasePairs / 2) * risePerBase;

      const p1 = new THREE.Vector3(Math.cos(angle1) * helixRadius, y, Math.sin(angle1) * helixRadius);
      const p2 = new THREE.Vector3(Math.cos(angle2) * helixRadius, y, Math.sin(angle2) * helixRadius);

      strand1Points.push(p1);
      strand2Points.push(p2);

      // Sugar-phosphate backbone nodes
      const b1 = new THREE.Mesh(backboneSphereGeo, backboneMat.clone());
      b1.position.copy(p1);
      this.activeGroup.add(b1);
      this.registerInteractive(b1, {
        title: 'Desoxirribose-Fosfato (Fita 5\' → 3\')',
        category: 'Esqueleto Covalente',
        desc: 'Ligação fosfodiéster entre carbonos 5\' e 3\' do açúcar.',
        extra: `Posição do nucleotídeo: #${i + 1}`
      });

      const b2 = new THREE.Mesh(backboneSphereGeo, backboneMat.clone());
      b2.position.copy(p2);
      this.activeGroup.add(b2);
      this.registerInteractive(b2, {
        title: 'Desoxirribose-Fosfato (Fita Antiparalela 3\' → 5\')',
        category: 'Esqueleto Covalente',
        desc: 'Fita complementar antiparalela estabilizada por pontes de H.',
        extra: `Posição correspondente: #${i + 1}`
      });

      // Nitrogenous Bases
      const base1 = sequence[i % sequence.length] || 'A';
      const base2 = complementMap[base1] || 'T';
      const d1 = baseData[base1] || baseData['A'];
      const d2 = baseData[base2] || baseData['T'];

      const isPurine1 = base1 === 'A' || base1 === 'G';
      const isPurine2 = base2 === 'A' || base2 === 'G';

      const mat1 = new THREE.MeshStandardMaterial({ color: d1.color, roughness: 0.3, metalness: 0.1 });
      const mat2 = new THREE.MeshStandardMaterial({ color: d2.color, roughness: 0.3, metalness: 0.1 });

      const mid1 = new THREE.Vector3().lerpVectors(p1, new THREE.Vector3(0, y, 0), isPurine1 ? 0.72 : 0.60);
      const mid2 = new THREE.Vector3().lerpVectors(p2, new THREE.Vector3(0, y, 0), isPurine2 ? 0.72 : 0.60);

      const nodeGeo1 = isPurine1 ? new THREE.CylinderGeometry(0.65, 0.65, 0.4, 6) : new THREE.CylinderGeometry(0.5, 0.5, 0.4, 6);
      const nodeGeo2 = isPurine2 ? new THREE.CylinderGeometry(0.65, 0.65, 0.4, 6) : new THREE.CylinderGeometry(0.5, 0.5, 0.4, 6);

      const node1 = new THREE.Mesh(nodeGeo1, mat1);
      node1.position.copy(mid1);
      node1.rotation.x = Math.PI / 2;
      this.activeGroup.add(node1);
      this.registerInteractive(node1, {
        title: d1.name,
        category: d1.type,
        desc: `Base nitrogenada na posição ${i + 1}.`,
        extra: d1.extra
      });

      const node2 = new THREE.Mesh(nodeGeo2, mat2);
      node2.position.copy(mid2);
      node2.rotation.x = Math.PI / 2;
      this.activeGroup.add(node2);
      this.registerInteractive(node2, {
        title: d2.name,
        category: d2.type,
        desc: `Base nitrogenada pareada na posição ${i + 1}.`,
        extra: d2.extra
      });

      // Connecting rungs
      this.activeGroup.add(this._createCylinderBetweenPoints(p1, mid1, 0.18, mat1));
      this.activeGroup.add(this._createCylinderBetweenPoints(p2, mid2, 0.18, mat2));
      
      // Central Hydrogen bond bridge
      const numHBonds = (base1 === 'G' || base1 === 'C') ? 3 : 2;
      const hBondMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
      for (let h = 0; h < numHBonds; h++) {
        const offset = (h - (numHBonds - 1) / 2) * 0.18;
        const oMid1 = mid1.clone().add(new THREE.Vector3(0, offset, 0));
        const oMid2 = mid2.clone().add(new THREE.Vector3(0, offset, 0));
        const hCyl = this._createCylinderBetweenPoints(oMid1, oMid2, 0.08, hBondMat);
        this.activeGroup.add(hCyl);
        this.registerInteractive(hCyl, {
          title: `Ponte de Hidrogênio (${numHBonds}x ${base1}-${base2})`,
          category: 'Interação Intermolecular',
          desc: 'Interação eletrostática fraca responsável pelo pareamento de Watson-Crick.',
          extra: `Energia de ligação: ~${numHBonds * 21} kJ/mol`
        });
      }
    }

    // Continuous Sugar-Phosphate Helical Ribbons (Strands)
    if (strand1Points.length > 1) {
      const curve1 = new THREE.CatmullRomCurve3(strand1Points);
      const tubeGeo1 = new THREE.TubeGeometry(curve1, numBasePairs * 8, 0.32, 10, false);
      const t1 = new THREE.Mesh(tubeGeo1, backboneMat);
      this.activeGroup.add(t1);
      this.registerInteractive(t1, {
        title: 'Fita Líder de DNA (5\' → 3\')',
        category: 'Fita Contínua',
        desc: 'Direção canônica da síntese catalisada pela DNA Polimerase.',
        extra: 'Sentido 5\' Fosfato para 3\' Hidroxila'
      });

      const curve2 = new THREE.CatmullRomCurve3(strand2Points);
      const tubeGeo2 = new THREE.TubeGeometry(curve2, numBasePairs * 8, 0.32, 10, false);
      const t2 = new THREE.Mesh(tubeGeo2, backboneMat);
      this.activeGroup.add(t2);
      this.registerInteractive(t2, {
        title: 'Fita Complementar (3\' → 5\')',
        category: 'Fita Antiparalela',
        desc: 'Molde antiparalelo durante a replicação e transcrição.',
        extra: 'Pareamento A=T e C≡G'
      });
    }

    // Organic thermal micro-vibrations & helical breathing
    this.animatedObjects.push((t) => {
      if (this.activeGroup) {
        this.activeGroup.position.y = Math.sin(t * 1.2) * 0.35;
        this.activeGroup.rotation.z = Math.sin(t * 0.8) * 0.02;
      }
    });

    this.camera.position.set(0, 0, 45);
  },

  // ---------------------------------------------------------------
  // 3D MODEL 1B: RIBOSOME & PROTEIN SYNTHESIS TRANSLATION ENGINE
  // ---------------------------------------------------------------
  buildRibosomeTranslation(mrnaSeq = 'AUGGGCAUUGUGGAACAAUGCUGUACC', peptide = ['Met', 'Gly', 'Ile', 'Val', 'Glu', 'Gln', 'Cys', 'Cys']) {
    this.clearActiveGroup();
    this.currentMode = 'ribosome';

    // 1. Large 60S/50S Ribosomal Subunit (Upper Cap & Exit Tunnel)
    const largeGeo = new THREE.SphereGeometry(8.5, 32, 28);
    const largeMat = new THREE.MeshStandardMaterial({
      color: 0x4f46e5,
      emissive: 0x1e1b4b,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.88
    });
    const largeSubunit = new THREE.Mesh(largeGeo, largeMat);
    largeSubunit.position.set(0, 4.5, 0);
    largeSubunit.scale.set(1.2, 0.9, 1.0);
    this.activeGroup.add(largeSubunit);
    this.registerInteractive(largeSubunit, {
      title: 'Subunidade Ribossomal Maior (60S/50S)',
      category: 'Complexo Ribonucleoproteico',
      desc: 'Contém o Centro Peptidil-Transferase (PTC) que catalisa ligações peptídicas.',
      extra: 'Composta por rRNAs 28S, 5.8S, 5S e ~49 proteínas ribossomais'
    });

    // Exit Tunnel
    const tunnelGeo = new THREE.CylinderGeometry(1.6, 1.6, 5.0, 16);
    const tunnelMat = new THREE.MeshBasicMaterial({ color: 0x020617, side: THREE.BackSide });
    const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat);
    tunnel.position.set(0, 10.5, 0);
    this.activeGroup.add(tunnel);
    this.registerInteractive(tunnel, {
      title: 'Túnel de Saída Polipeptídico',
      category: 'Conduto Estrutural',
      desc: 'Passagem onde a nova proteína nascente emerge para o citosol ou lúmen do RER.',
      extra: 'Diâmetro: ~1.5 a 2.0 nm'
    });

    // 2. Small 40S/30S Ribosomal Subunit (Lower Base)
    const smallGeo = new THREE.SphereGeometry(6.5, 28, 24);
    const smallMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x083344,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.88
    });
    const smallSubunit = new THREE.Mesh(smallGeo, smallMat);
    smallSubunit.position.set(0, -4.5, 0);
    smallSubunit.scale.set(1.3, 0.7, 0.9);
    this.activeGroup.add(smallSubunit);
    this.registerInteractive(smallSubunit, {
      title: 'Subunidade Ribossomal Menor (40S/30S)',
      category: 'Centro de Decodificação',
      desc: 'Responsável pelo reconhecimento códon-anticódon e fidelidade da tradução.',
      extra: 'Composta por rRNA 18S e ~33 proteínas ribossomais'
    });

    // 3. mRNA Ribbon threading through the inter-subunit cleft
    const mrnaPoints = [];
    const numCodons = Math.min(Math.floor(mrnaSeq.length / 3), 14);
    for (let c = 0; c < numCodons; c++) {
      const x = (c - numCodons / 2) * 2.8;
      const y = -0.5 + Math.sin(c * 0.6) * 0.8;
      const z = Math.cos(c * 0.4) * 0.8;
      mrnaPoints.push(new THREE.Vector3(x, y, z));

      const codonStr = mrnaSeq.slice(c * 3, c * 3 + 3);
      const codonGeo = new THREE.SphereGeometry(0.55, 14, 14);
      const codonMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3 });
      const codonMesh = new THREE.Mesh(codonGeo, codonMat);
      codonMesh.position.set(x, y, z);
      this.activeGroup.add(codonMesh);
      this.registerInteractive(codonMesh, {
        title: `Códon #${c + 1}: ${codonStr}`,
        category: 'Trinca de mRNA',
        desc: `Decodificado pelo anticódon do tRNA correspondente.`,
        extra: `Posição na matriz de leitura: bases ${c * 3 + 1}-${c * 3 + 3}`
      });
    }

    if (mrnaPoints.length > 1) {
      const mrnaCurve = new THREE.CatmullRomCurve3(mrnaPoints);
      const mrnaTube = new THREE.Mesh(
        new THREE.TubeGeometry(mrnaCurve, numCodons * 8, 0.22, 10, false),
        new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.35 })
      );
      this.activeGroup.add(mrnaTube);
      this.registerInteractive(mrnaTube, {
        title: 'Fita de mRNA Mensageiro (5\' → 3\')',
        category: 'Ácido Ribonucleico',
        desc: 'Transporta a informação genética transcrita do núcleo até o ribossomo.',
        extra: 'Contém CAP 5\' e cauda Poli-A'
      });
    }

    // 4. tRNAs in A, P, E sites
    const sites = [
      { name: 'Sítio P (Peptidil-tRNA)', x: 0, color: 0x10b981, desc: 'Mantém o tRNA ligado à cadeia polipeptídica em crescimento.', role: 'Elongação Ativa' },
      { name: 'Sítio A (Aminoacil-tRNA)', x: 2.8, color: 0x3b82f6, desc: 'Recebe o novo aminoacil-tRNA com o anticódon correspondente.', role: 'Entrada de Aminoácido' },
      { name: 'Sítio E (Exit / Saída)', x: -2.8, color: 0x94a3b8, desc: 'Libera o tRNA desacilado de volta ao citosol.', role: 'Descarga de tRNA' }
    ];

    sites.forEach(site => {
      const trnaGroup = new THREE.Group();
      const stemGeo = new THREE.CylinderGeometry(0.25, 0.25, 4.0, 10);
      const trnaMat = new THREE.MeshStandardMaterial({ color: site.color, roughness: 0.35 });
      const stem = new THREE.Mesh(stemGeo, trnaMat);
      stem.position.set(site.x, 2.0, 0);
      trnaGroup.add(stem);

      const anticodon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 14), trnaMat);
      anticodon.position.set(site.x, -0.2, 0);
      trnaGroup.add(anticodon);

      this.registerInteractive(stem, {
        title: `tRNA no ${site.name}`,
        category: 'RNA Transportador',
        desc: site.desc,
        extra: `Função chave: ${site.role}`
      });

      if (site.x >= 0) {
        const aaGeo = new THREE.SphereGeometry(0.8, 16, 16);
        const aaMat = new THREE.MeshStandardMaterial({ color: 0xec4899, emissive: 0x831843, roughness: 0.25 });
        const aa = new THREE.Mesh(aaGeo, aaMat);
        aa.position.set(site.x, 4.2, 0);
        trnaGroup.add(aa);
        this.registerInteractive(aa, {
          title: `Aminoácido Carregado (${site.x === 0 ? 'Polipeptídeo' : 'Novo Resíduo'})`,
          category: 'Monômero Proteico',
          desc: 'Ligado via ligação éster de alta energia à extremidade 3\' CCA do tRNA.',
          extra: 'Pronto para formação de ligação peptídica'
        });
      }

      this.activeGroup.add(trnaGroup);
    });

    // 5. Emerging Polypeptide Chain
    const peptidePoints = [];
    const numAA = Math.min(peptide.length || 10, 16);
    const aaColors = [0xec4899, 0x38bdf8, 0x10b981, 0xf59e0b, 0xa855f7, 0xef4444];

    for (let p = 0; p < numAA; p++) {
      const py = 6.0 + p * 1.35;
      const px = Math.sin(p * 0.8) * 1.6;
      const pz = Math.cos(p * 0.8) * 1.6;
      const pos = new THREE.Vector3(px, py, pz);
      peptidePoints.push(pos);

      const aaMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 16, 16),
        new THREE.MeshStandardMaterial({ color: aaColors[p % aaColors.length], roughness: 0.3 })
      );
      aaMesh.position.copy(pos);
      this.activeGroup.add(aaMesh);
      const aaName = typeof peptide[p] === 'string' ? peptide[p] : (peptide[p]?.code3 || 'Aminoácido');
      this.registerInteractive(aaMesh, {
        title: `Resíduo #${p + 1}: ${aaName}`,
        category: 'Cadeia Polipeptídica',
        desc: 'Resíduo de aminoácido unido por ligação peptídica covalente (-CO-NH-).',
        extra: 'Dobra-se em estrutura secundária alfa-hélice/folha-beta'
      });
    }

    if (peptidePoints.length > 1) {
      const pepCurve = new THREE.CatmullRomCurve3(peptidePoints);
      const pepTube = new THREE.Mesh(
        new THREE.TubeGeometry(pepCurve, numAA * 8, 0.2, 10, false),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
      );
      this.activeGroup.add(pepTube);
    }

    // Dynamic translation oscillation
    this.animatedObjects.push((t) => {
      if (largeSubunit && smallSubunit) {
        largeSubunit.position.y = 4.5 + Math.sin(t * 2) * 0.08;
        smallSubunit.position.y = -4.5 - Math.sin(t * 2) * 0.08;
      }
    });

    this.camera.position.set(0, 3, 40);
  },

  // ---------------------------------------------------------------
  // 3D MODEL 2: EUKARYOTIC CELL (ANIMAL VS PLANT)
  // ---------------------------------------------------------------
  buildCellModel(cellType = 'animal', viewMode = '3d-cross') {
    this.clearActiveGroup();
    this.currentMode = 'cell';
    const isCross = viewMode === '3d-cross';

    if (cellType === 'animal') {
      // 1. Plasma Membrane (Peristaltic lipid bilayer)
      const cellGeo = isCross 
        ? new THREE.SphereGeometry(14, 36, 36, 0, Math.PI * 2, 0, Math.PI * 0.58)
        : new THREE.SphereGeometry(14, 36, 36);
      const cellMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: isCross ? 0.32 : 0.85,
        side: THREE.DoubleSide,
        roughness: 0.4
      });
      const cellMesh = new THREE.Mesh(cellGeo, cellMat);
      this.activeGroup.add(cellMesh);
      this.registerInteractive(cellMesh, {
        title: 'Membrana Plasmática Celular',
        category: 'Bicamada Fosfolipídica',
        desc: 'Barreira semipermeável com colesterol e proteínas integrais transportadoras.',
        extra: 'Modelo do Mosaico Fluido'
      });

      // Receptors
      for (let r = 0; r < 24; r++) {
        const phi = Math.random() * Math.PI * 2;
        const theta = isCross ? Math.random() * Math.PI * 0.55 : Math.random() * Math.PI;
        const rx = 14.1 * Math.sin(theta) * Math.cos(phi);
        const ry = 14.1 * Math.sin(theta) * Math.sin(phi);
        const rz = 14.1 * Math.cos(theta);
        const rec = new THREE.Mesh(
          new THREE.CylinderGeometry(0.18, 0.18, 1.2, 8),
          new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.3 })
        );
        rec.position.set(rx, ry, rz);
        rec.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(rx, ry, rz).normalize());
        this.activeGroup.add(rec);
        this.registerInteractive(rec, {
          title: 'Receptor Glicoproteico de Superfície',
          category: 'Proteína de Membrana',
          desc: 'Reconhecimento celular, sinalização hormonal e alvo de vírus (ex: ACE2).',
          extra: 'Glicosilação no Complexo de Golgi'
        });
      }

      // 2. Nucleus
      const nucleusGeo = new THREE.SphereGeometry(4.8, 30, 30);
      const nucleusMat = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, roughness: 0.35 });
      const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
      this.activeGroup.add(nucleus);
      this.registerInteractive(nucleus, {
        title: 'Núcleo Celular & Carioteca',
        category: 'Armazenamento Genético',
        desc: 'Encerra o genoma em cromatina, protegido pela membrana dupla nuclear.',
        extra: 'Controla a transcrição e o ciclo celular'
      });

      // Nuclear Pores
      const poreGeo = new THREE.TorusGeometry(0.35, 0.1, 8, 16);
      const poreMat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
      for (let p = 0; p < 18; p++) {
        const phi = Math.random() * Math.PI * 2;
        const theta = Math.random() * Math.PI;
        const px = 4.8 * Math.sin(theta) * Math.cos(phi);
        const py = 4.8 * Math.sin(theta) * Math.sin(phi);
        const pz = 4.8 * Math.cos(theta);
        const pore = new THREE.Mesh(poreGeo, poreMat);
        pore.position.set(px, py, pz);
        pore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(px, py, pz).normalize());
        this.activeGroup.add(pore);
        this.registerInteractive(pore, {
          title: 'Complexo de Poros Nucleares (NPC)',
          category: 'Canal de Transporte',
          desc: 'Regula o tráfego seletivo de RNA, proteínas e ribossomos entre núcleo e citoplasma.',
          extra: 'Capacidade de até 1.000 translocações/seg'
        });
      }

      // Nucleolus
      const nucleolusGeo = new THREE.SphereGeometry(2.0, 20, 20);
      const nucleolusMat = new THREE.MeshStandardMaterial({ color: 0xd946ef, emissive: 0x701a75, roughness: 0.3 });
      const nucleolus = new THREE.Mesh(nucleolusGeo, nucleolusMat);
      nucleolus.position.set(0.8, 0.8, 0.8);
      this.activeGroup.add(nucleolus);
      this.registerInteractive(nucleolus, {
        title: 'Nucléolo',
        category: 'Biossíntese Ribossômica',
        desc: 'Local de transcrição e processamento intenso do RNA ribossômico (rRNA).',
        extra: 'Montagem prévia das subunidades 40S e 60S'
      });

      // 3. Rough Endoplasmic Reticulum (RER)
      const rerMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      for (let r = 0; r < 3; r++) {
        const rerGeo = new THREE.TorusGeometry(6.2 + r * 1.1, 0.45, 10, 36, Math.PI * 1.4);
        const rer = new THREE.Mesh(rerGeo, rerMat);
        rer.rotation.x = Math.PI / 3 + r * 0.2;
        this.activeGroup.add(rer);
        this.registerInteractive(rer, {
          title: 'Retículo Endoplasmático Rugoso (RER)',
          category: 'Síntese & Dobramento',
          desc: 'Cravejado de ribossomos para síntese de proteínas de secreção e membrana.',
          extra: 'Contém chaperonas moleculares no lúmen'
        });
      }

      // 4. Golgi Apparatus
      const golgiMat = new THREE.MeshStandardMaterial({ color: 0xec4899, roughness: 0.3 });
      for (let g = 0; g < 4; g++) {
        const cisternGeo = new THREE.TorusGeometry(3.2 - g * 0.4, 0.35, 10, 28, Math.PI * 0.9);
        const cistern = new THREE.Mesh(cisternGeo, golgiMat);
        cistern.position.set(-6.5, 5.0, g * 0.6 - 1.0);
        cistern.rotation.y = Math.PI / 4;
        this.activeGroup.add(cistern);
        this.registerInteractive(cistern, {
          title: `Complexo de Golgi (Cisterna ${g === 0 ? 'Cis' : (g === 3 ? 'Trans' : 'Medial')})`,
          category: 'Empacotamento & Secreção',
          desc: 'Modificação pós-traducional (glicosilação/sulfatação) e endereçamento de vesículas.',
          extra: 'Direciona para lisossomos ou exocitose'
        });
      }

      // 5. Mitochondria
      const mitoMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, emissive: 0x451a03 });
      const mitoPositions = [
        { x: 7.5, y: 3.5, z: 2.0, rx: 0.4, rz: 0.8 },
        { x: -7.0, y: -2.0, z: 5.5, rx: -0.5, rz: 0.2 },
        { x: 6.0, y: -6.0, z: -3.0, rx: 0.9, rz: -0.4 },
        { x: -6.5, y: 5.0, z: -4.5, rx: -0.3, rz: 1.2 }
      ];
      mitoPositions.forEach((pos, idx) => {
        const mito = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 3.2, 16), mitoMat);
        mito.position.set(pos.x, pos.y, pos.z);
        mito.rotation.set(pos.rx, 0, pos.rz);
        this.activeGroup.add(mito);
        this.registerInteractive(mito, {
          title: `Mitocôndria #${idx + 1}`,
          category: 'Usina de ATP Celular',
          desc: 'Fosforilação oxidativa, ciclo de Krebs e respiração celular.',
          extra: 'Possui DNA mitocondrial próprio circular'
        });
      });

      // 6. Centrosome with Centrioles
      const centrioleMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.3 });
      const cent1 = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 9), centrioleMat);
      cent1.position.set(3.5, 5.5, 0);
      this.activeGroup.add(cent1);
      this.registerInteractive(cent1, {
        title: 'Centríolo (Triplete de Microtúbulos)',
        category: 'Centro Organizador (MTOC)',
        desc: 'Organiza o fuso mitótico durante a divisão celular e forma cílios/flagelos.',
        extra: 'Estrutura em arranjo 9x3 de tubulina'
      });

    } else {
      // PLANT CELL (Rigid Polyhedral Box with Chloroplasts, Central Vacuole & Cell Wall)
      const wallGeo = isCross ? new THREE.BoxGeometry(24, 18, 13) : new THREE.BoxGeometry(24, 18, 18);
      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x16a34a,
        transparent: true,
        opacity: isCross ? 0.35 : 0.85,
        roughness: 0.5,
        side: THREE.DoubleSide
      });
      const wallMesh = new THREE.Mesh(wallGeo, wallMat);
      this.activeGroup.add(wallMesh);
      this.registerInteractive(wallMesh, {
        title: 'Parede Celular Vegetal (Celulósica)',
        category: 'Estrutura de Suporte Rígida',
        desc: 'Microfibrilas de celulose, hemicelulose e pectina resistem à pressão de turgor.',
        extra: 'Espessura: 0.1 a vários micrômetros'
      });

      const edgeGeo = new THREE.EdgesGeometry(wallGeo);
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x4ade80, linewidth: 2 });
      this.activeGroup.add(new THREE.LineSegments(edgeGeo, edgeMat));

      // 2. Large Central Vacuole
      const vacGeo = new THREE.SphereGeometry(6.2, 30, 30);
      const vacMat = new THREE.MeshStandardMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.6,
        roughness: 0.1,
        metalness: 0.1
      });
      const vacuole = new THREE.Mesh(vacGeo, vacMat);
      vacuole.position.set(3.0, 0.5, 0);
      this.activeGroup.add(vacuole);
      this.registerInteractive(vacuole, {
        title: 'Vacúolo Central com Tonoplasto',
        category: 'Equilíbrio Hidrostático',
        desc: 'Armazena íons, açúcares e mantém o turgor osmótico da célula vegetal.',
        extra: 'Ocupa até 80% do volume celular'
      });

      // 3. Chloroplasts
      const chloroMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x14532d, roughness: 0.3 });
      const granaMat = new THREE.MeshBasicMaterial({ color: 0x15803d });

      const chloroPositions = [
        { x: -8.0, y: 5.0, z: 3.0 },
        { x: -3.5, y: 6.5, z: -3.0 },
        { x: 3.5, y: 6.5, z: 3.5 },
        { x: 8.5, y: -4.5, z: 2.5 },
        { x: -8.5, y: -5.0, z: -3.0 },
        { x: 7.5, y: 4.5, z: -3.5 }
      ];

      chloroPositions.forEach((pos, idx) => {
        const chloroGroup = new THREE.Group();
        const chloro = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.9, 18), chloroMat);
        chloroGroup.add(chloro);

        for (let g = 0; g < 3; g++) {
          const granum = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.7, 10), granaMat);
          granum.position.set((g - 1) * 0.7, 0, 0);
          chloroGroup.add(granum);
        }

        chloroGroup.position.set(pos.x, pos.y, pos.z);
        chloroGroup.rotation.x = Math.PI / 4;
        this.activeGroup.add(chloroGroup);
        this.registerInteractive(chloro, {
          title: `Cloroplasto #${idx + 1} (Fotossíntese)`,
          category: 'Organela Energética Autotrófica',
          desc: 'Contém clorofila e tilacoides empilhados (grana) para fase clara e ciclo de Calvin.',
          extra: 'Converte H2O + CO2 em Glicose + O2'
        });
      });
    }

    this.camera.position.set(0, 0, 44);
  },

  // ---------------------------------------------------------------
  // 3D MODEL 3: MICROORGANISMS (BACTERIA & VIRUSES)
  // ---------------------------------------------------------------
  buildMicrobeModel(microbeType = 'bacteria_gram_neg') {
    this.clearActiveGroup();
    this.currentMode = 'microbe';

    if (microbeType.startsWith('bacteria')) {
      const isGramPos = microbeType === 'bacteria_gram_pos';

      const bodyMat = new THREE.MeshStandardMaterial({
        color: isGramPos ? 0x7c3aed : 0xf43f5e,
        roughness: 0.35
      });
      const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(3.8, 3.8, 10.0, 28), bodyMat);
      const capTop = new THREE.Mesh(new THREE.SphereGeometry(3.8, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), bodyMat);
      capTop.position.y = 5.0;
      const capBottom = new THREE.Mesh(new THREE.SphereGeometry(3.8, 28, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), bodyMat);
      capBottom.position.y = -5.0;

      this.activeGroup.add(cylinder);
      this.activeGroup.add(capTop);
      this.activeGroup.add(capBottom);

      this.registerInteractive(cylinder, {
        title: isGramPos ? 'Bactéria Gram-Positiva (Parede Espessa)' : 'Bactéria Gram-Negativa (Parede Dupla com LPS)',
        category: 'Corpo Bacilar Procarioto',
        desc: isGramPos 
          ? 'Parede espessa de peptidoglicano (~20-80 nm) com ácidos lipoteicoicos.'
          : 'Membrana externa com Lipopolissacarídeo (LPS endotóxico) e espaço periplasmático.',
        extra: 'Ausência de carioteca; nucleoide circular'
      });

      // Bacterial Flagella
      const flagellaMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      const flagellaTubes = [];
      for (let f = 0; f < 3; f++) {
        const points = [];
        for (let t = 0; t <= 14; t++) {
          points.push(new THREE.Vector3(
            Math.sin(t * 0.9 + f) * 1.3 + (f - 1) * 1.5,
            -5.0 - t * 1.6,
            Math.cos(t * 0.9 + f) * 1.3
          ));
        }
        const curve = new THREE.CatmullRomCurve3(points);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, 0.16, 8, false), flagellaMat);
        this.activeGroup.add(tube);
        flagellaTubes.push(tube);
        this.registerInteractive(tube, {
          title: `Flagelo Bacteriano #${f + 1}`,
          category: 'Motor de Mobilidade Rotativo',
          desc: 'Filamento de flagelina impulsionado por gradiente de prótons (motor basal).',
          extra: 'Gira até 100.000 RPM'
        });
      }

      this.animatedObjects.push((t) => {
        flagellaTubes.forEach((tube, idx) => {
          tube.rotation.y = t * 4 + idx;
        });
      });

    } else if (microbeType === 'virus_bacteriophage') {
      // 1. Prolate Icosahedral Head
      const headGeo = new THREE.IcosahedronGeometry(4.2, 0);
      const headMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.3 });
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(0, 6.5, 0);
      head.scale.set(1.0, 1.35, 1.0);
      this.activeGroup.add(head);
      this.registerInteractive(head, {
        title: 'Cápside Icosaédrica Alongada (Cabeça T4)',
        category: 'Invólucro Proteico Viral',
        desc: 'Armazena ~170 kpb de DNA viral de fita dupla sob alta pressão mecânica.',
        extra: 'Composta pelos capsômeros gp23* e gp24*'
      });

      // 2. Collar & Whiskers
      const collar = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.18, 8, 16), new THREE.MeshStandardMaterial({ color: 0x94a3b8 }));
      collar.position.set(0, 4.0, 0);
      collar.rotation.x = Math.PI / 2;
      this.activeGroup.add(collar);
      this.registerInteractive(collar, {
        title: 'Colar e Whiskers (Fibras do Pescoço)',
        category: 'Conector Capsídeo-Cauda',
        desc: 'Sensor ambiental que coordena a ancoragem das fibras caudais.',
        extra: 'Proteínas gpW e gpFII'
      });

      // 3. Contractile Tail Sheath
      const sheathMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.35 });
      for (let r = 0; r < 12; r++) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.4, 14), sheathMat);
        ring.position.set(0, 3.6 - r * 0.45, 0);
        this.activeGroup.add(ring);
        this.registerInteractive(ring, {
          title: `Bainha Contrátil (Anel #${r + 1})`,
          category: 'Sistema de Injeção Mecânica',
          desc: 'Contrai-se para perfurar a parede bacteriana e injetar o genoma viral.',
          extra: 'Estrutura helicoidal de 24 anéis'
        });
      }

      // 4. Baseplate
      const baseplate = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.6, 6), new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      baseplate.position.set(0, -1.8, 0);
      this.activeGroup.add(baseplate);
      this.registerInteractive(baseplate, {
        title: 'Placa Basal Hexagonal com Espículas',
        category: 'Plataforma de Perfuração',
        desc: 'Muda de conformação hexagonal para estelar para liberar a agulha de injeção.',
        extra: 'Contém lisozimas virais para lise da parede'
      });

      // 5. Tail Fibers
      const legMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4 });
      for (let f = 0; f < 6; f++) {
        const angle = (f / 6) * Math.PI * 2;
        const upperLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 4.2, 8), legMat);
        upperLeg.position.set(Math.cos(angle) * 1.6, -3.8, Math.sin(angle) * 1.6);
        upperLeg.rotation.z = Math.cos(angle) * 0.7;
        upperLeg.rotation.x = Math.sin(angle) * 0.7;
        this.activeGroup.add(upperLeg);

        const lowerLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 4.8, 8), legMat);
        lowerLeg.position.set(Math.cos(angle) * 3.8, -6.5, Math.sin(angle) * 3.8);
        lowerLeg.rotation.z = -Math.cos(angle) * 0.45;
        lowerLeg.rotation.x = -Math.sin(angle) * 0.45;
        this.activeGroup.add(lowerLeg);

        this.registerInteractive(upperLeg, {
          title: `Fibra Caudal Longa #${f + 1}`,
          category: 'Antena de Reconhecimento',
          desc: 'Reconhece receptores OmpC e LPS na superfície da bactéria.',
          extra: 'Proteína trimérica gp34-gp37'
        });
      }

    } else if (microbeType === 'virus_enveloped') {
      const envGeo = new THREE.SphereGeometry(6.2, 36, 36);
      const envMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
      const envelope = new THREE.Mesh(envGeo, envMat);
      this.activeGroup.add(envelope);
      this.registerInteractive(envelope, {
        title: 'Envelope Lipídico Viral',
        category: 'Bicamada Lipídica do Hospedeiro',
        desc: 'Adquirido durante o brotamento celular; sensível a sabão e desinfetantes.',
        extra: 'Contém proteínas M e E'
      });

      // Trimeric Spike Glycoproteins
      const spikeMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x450a0a, roughness: 0.3 });
      const numSpikes = 75;
      for (let s = 0; s < numSpikes; s++) {
        const phi = Math.acos(-1 + (2 * s) / numSpikes);
        const theta = Math.sqrt(numSpikes * Math.PI) * phi;
        const x = Math.cos(theta) * Math.sin(phi);
        const y = Math.sin(theta) * Math.sin(phi);
        const z = Math.cos(phi);

        const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.2, 8), spikeMat);
        stalk.position.set(x * 7.0, y * 7.0, z * 7.0);
        stalk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, y, z));

        const crown = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 10), spikeMat);
        crown.position.set(x * 8.2, y * 8.2, z * 8.2);

        this.activeGroup.add(stalk);
        this.activeGroup.add(crown);

        this.registerInteractive(crown, {
          title: 'Glicoproteína Spike (S1/S2 Trímero)',
          category: 'Chave de Entrada Viral',
          desc: 'Domínio RBD liga-se ao receptor ACE2 humano para mediar a fusão de membrana.',
          extra: 'Alvo primário de vacinas e anticorpos neutralizantes'
        });
      }
    }

    this.camera.position.set(0, 0, 36);
  },

  // Host/pathogen traits per scenario. The form offers three
  // (see #bio-infect-scenario) and the service models each one differently --
  // treatment efficacy is scenario-specific -- but this scene used to accept
  // `scenario` and ignore it, so all three rendered as the animal-virus case.
  INFECTION_PROFILES: {
    virus_animal: {
      hostTitle: 'Membrana da Célula Animal',
      hostDesc: 'Bicamada lipídica sob invasão viral ativa.',
      hostColor: 0x1e3a8a,
      lysedColor: 0x7f1d1d,
      receptorTitle: 'Receptor de Ancoragem (ACE2 / CD4)',
      receptorColor: 0x22c55e,
      pathogenTitle: 'Virion',
      pathogenColor: 0xef4444,
    },
    bacteriophage_bacteria: {
      hostTitle: 'Parede Celular Bacteriana (E. coli)',
      hostDesc: 'Envelope de peptidoglicano sob ataque de bacteriófago T4.',
      hostColor: 0x155e75,
      lysedColor: 0x713f12,
      receptorTitle: 'Receptor de Ancoragem (OmpC / LPS)',
      receptorColor: 0xfacc15,
      pathogenTitle: 'Bacteriófago T4',
      pathogenColor: 0xa855f7,
    },
    pathogen_plant: {
      hostTitle: 'Parede Celular Vegetal (celulose)',
      hostDesc: 'Parede rígida de celulose; a entrada depende de lesão ou vetor.',
      hostColor: 0x14532d,
      lysedColor: 0x78350f,
      receptorTitle: 'Sítio de Reconhecimento (PRR / plasmodesmo)',
      receptorColor: 0x84cc16,
      pathogenTitle: 'Fitopatógeno',
      pathogenColor: 0xf97316,
    },
  },

  // ---------------------------------------------------------------
  // 3D MODEL 4: CELLULAR INFECTION SCENE (4 DYNAMIC PHASES)
  // ---------------------------------------------------------------
  buildInfectionScene(scenario = 'virus_animal', phase = 1) {
    this.clearActiveGroup();
    this.currentMode = 'infection';

    const profile = this.INFECTION_PROFILES[scenario]
      || this.INFECTION_PROFILES.virus_animal;

    const membraneGeo = new THREE.CylinderGeometry(20, 20, 4, 36);
    const membraneMat = new THREE.MeshStandardMaterial({ color: profile.hostColor, transparent: true, opacity: 0.65, roughness: 0.4 });
    const membrane = new THREE.Mesh(membraneGeo, membraneMat);
    membrane.position.set(0, -10, 0);
    this.activeGroup.add(membrane);
    this.registerInteractive(membrane, {
      title: profile.hostTitle,
      category: 'Alvo Celular',
      desc: profile.hostDesc,
      extra: `Integridade atual: ${phase === 4 ? '10% (Lise celular)' : '95%'}`
    });

    // Host Receptors
    const recMat = new THREE.MeshStandardMaterial({ color: profile.receptorColor, roughness: 0.3 });
    for (let r = 0; r < 14; r++) {
      const rx = (Math.random() - 0.5) * 26;
      const rz = (Math.random() - 0.5) * 26;
      const rec = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.8, 8), recMat);
      rec.position.set(rx, -7.5, rz);
      this.activeGroup.add(rec);
      this.registerInteractive(rec, {
        title: profile.receptorTitle,
        category: 'Porta de Entrada',
        desc: 'Receptor fisiológico sequestrado pelo patógeno para entrada.',
        extra: 'Sítio de acoplamento molecular'
      });
    }

    const virionMat = new THREE.MeshStandardMaterial({ color: profile.pathogenColor, roughness: 0.35 });

    if (phase === 1) {
      for (let v = 0; v < 12; v++) {
        const virion = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 16), virionMat);
        virion.position.set((Math.random() - 0.5) * 24, -4 + Math.random() * 14, (Math.random() - 0.5) * 24);
        this.activeGroup.add(virion);
        this.registerInteractive(virion, {
          title: `${profile.pathogenTitle} #${v + 1} (Fase de Adsorção)`,
          category: 'Partícula Patogênica',
          desc: 'Navega por difusão browniana buscando receptores celulares.',
          extra: 'Fase 1: Ligação de Alta Afinidade'
        });
      }
    } else if (phase === 2) {
      const dockedPhage = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 16), virionMat);
      dockedPhage.position.set(0, -5.5, 0);
      this.activeGroup.add(dockedPhage);
      this.registerInteractive(dockedPhage, {
        title: `${profile.pathogenTitle} Acoplado & Ativado`,
        category: 'Injeção de Material Genético',
        desc: 'Bainha contraída translocando o genoma para o citoplasma.',
        extra: 'Fase 2: Penetração'
      });

      const injPoints = [
        new THREE.Vector3(0, -5.5, 0),
        new THREE.Vector3(0, -9.0, 0),
        new THREE.Vector3(0, -14.0, 0)
      ];
      const injCurve = new THREE.CatmullRomCurve3(injPoints);
      const injTube = new THREE.Mesh(
        new THREE.TubeGeometry(injCurve, 20, 0.35, 8, false),
        new THREE.MeshBasicMaterial({ color: 0xf43f5e, wireframe: true })
      );
      this.activeGroup.add(injTube);
    } else if (phase === 3) {
      for (let rep = 0; rep < 18; rep++) {
        const geneCopy = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 10, 10),
          new THREE.MeshBasicMaterial({ color: 0xf43f5e })
        );
        geneCopy.position.set((Math.random() - 0.5) * 18, -12 + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 18);
        this.activeGroup.add(geneCopy);
        this.registerInteractive(geneCopy, {
          title: `Cópia do Genoma Viral #${rep + 1}`,
          category: 'Replicação Ativa',
          desc: 'Sintetizado pela polimerase viral às custas de nucleotídeos da célula.',
          extra: 'Fase 3: Sequestro Ribossomal'
        });
      }
    } else if (phase === 4) {
      membrane.material.color.setHex(profile.lysedColor);
      membrane.material.opacity = 0.3;

      for (let b = 0; b < 28; b++) {
        const progeny = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 14), virionMat);
        const rad = 6 + Math.random() * 16;
        const phi = Math.random() * Math.PI * 2;
        progeny.position.set(rad * Math.cos(phi), -6 + (Math.random() - 0.5) * 16, rad * Math.sin(phi));
        this.activeGroup.add(progeny);
        this.registerInteractive(progeny, {
          title: `Nova Partícula Viral Filha #${b + 1}`,
          category: 'Progênie Liberada',
          desc: 'Pronta para infectar células adjacentes no tecido.',
          extra: 'Fase 4: Lise e Disseminação'
        });
      }
    }

    this.camera.position.set(0, 4, 38);
  },

  _createCylinderBetweenPoints(p1, p2, radius, material) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const length = dir.length();
    const halfDir = dir.clone().multiplyScalar(0.5);
    const pos = p1.clone().add(halfDir);

    const geo = new THREE.CylinderGeometry(radius, radius, length, 8);
    const mesh = new THREE.Mesh(geo, material);

    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  }
};


// =================================================================
// 2. DASHBOARD CONTROLLER & EVENT MANAGER
// =================================================================
const BiologyDashboard = {
  currentTab: 'dna',
  dnaViewMode: 'helix',
  currentCellType: 'animal',
  currentCellView: '3d-cross',
  presets: {},
  structures: {},
  lastAnalyzedDna: null,

  async init() {
    ThreeBioViewer.init();
    this.bindEvents();

    try {
      this.presets = await biologyAPI.getPresets();
      this.structures = await biologyAPI.getCellStructures();
      this.populateOrganelleSelect('animal');
      this.updateMicrobeInfo('bacteria_gram_neg');
    } catch (e) {
      console.error(e);
    }

    // Trigger initial DNA analysis
    this.runDnaAnalysis();
  },

  bindEvents() {
    document.querySelectorAll('.bio-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        this.setTab(tab);
      });
    });

    document.getElementById('btn-bio-transcribe')?.addEventListener('click', () => this.runDnaAnalysis());

    document.querySelectorAll('.btn-dna-view').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-dna-view').forEach(b => b.classList.remove('btn-dna-view--active'));
        e.currentTarget.classList.add('btn-dna-view--active');
        this.dnaViewMode = e.currentTarget.getAttribute('data-view') || 'helix';
        this.renderDna3D();
      });
    });

    document.getElementById('bio-dna-preset-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (this.presets[val]) {
        document.getElementById('bio-dna-input').value = this.presets[val].dna;
        this.runDnaAnalysis();
      }
    });

    document.getElementById('btn-bio-mutate')?.addEventListener('click', () => this.applyRandomMutation());
    document.getElementById('btn-mut-missense')?.addEventListener('click', () => this.applySpecificMutation('missense'));
    document.getElementById('btn-mut-nonsense')?.addEventListener('click', () => this.applySpecificMutation('nonsense'));
    document.getElementById('btn-mut-frameshift')?.addEventListener('click', () => this.applySpecificMutation('frameshift'));
    document.getElementById('btn-mut-silent')?.addEventListener('click', () => this.applySpecificMutation('silent'));

    document.querySelectorAll('.btn-cell-type').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-cell-type').forEach(b => b.classList.remove('btn-cell-type--active'));
        e.currentTarget.classList.add('btn-cell-type--active');
        this.currentCellType = e.currentTarget.getAttribute('data-cell');
        this.populateOrganelleSelect(this.currentCellType);
        ThreeBioViewer.buildCellModel(this.currentCellType, this.currentCellView);
      });
    });

    document.querySelectorAll('.btn-cell-view').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-cell-view').forEach(b => b.classList.remove('btn-cell-view--active'));
        e.currentTarget.classList.add('btn-cell-view--active');
        this.currentCellView = e.currentTarget.getAttribute('data-view');
        ThreeBioViewer.buildCellModel(this.currentCellType, this.currentCellView);
      });
    });

    document.getElementById('bio-organelle-select')?.addEventListener('change', (e) => {
      const orgId = e.target.value;
      const list = this.currentCellType === 'animal' ? this.structures.animal_cell : this.structures.plant_cell;
      const item = list?.find(o => o.id === orgId);
      if (item) {
        document.getElementById('bio-org-title').textContent = `${item.icon} ${item.name}`;
        document.getElementById('bio-org-desc').textContent = item.function;
        document.getElementById('bio-org-energy').textContent = `⚡ Papel Energético: ${item.energy_atp}`;
      }
    });

    document.getElementById('bio-microbe-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      this.updateMicrobeInfo(val);
      ThreeBioViewer.buildMicrobeModel(val);
    });

    document.getElementById('btn-bio-inject-action')?.addEventListener('click', () => {
      showToast('💥 Injeção de genoma viral disparada!', 'success');
      ThreeBioViewer.buildMicrobeModel(document.getElementById('bio-microbe-select')?.value);
    });

    const loadSlider = document.getElementById('bio-slider-load');
    const immSlider = document.getElementById('bio-slider-immune');

    loadSlider?.addEventListener('input', (e) => {
      document.getElementById('bio-val-load').textContent = `${e.target.value} part.`;
    });

    immSlider?.addEventListener('input', (e) => {
      document.getElementById('bio-val-immune').textContent = `${e.target.value}%`;
    });

    // Read the selected scenario rather than hardcoding the animal-virus case:
    // the form offers three, and the scene now renders each one differently.
    const currentScenario = () =>
      document.getElementById('bio-infect-scenario')?.value || 'virus_animal';

    for (const phase of [1, 2, 3, 4]) {
      document.getElementById(`btn-infect-phase-${phase}`)?.addEventListener(
        'click', () => ThreeBioViewer.buildInfectionScene(currentScenario(), phase),
      );
    }

    // Re-render the scene when the scenario changes, so the viewport does not
    // keep showing the previous host/pathogen pair.
    document.getElementById('bio-infect-scenario')?.addEventListener('change', () => {
      if (ThreeBioViewer.currentMode === 'infection') {
        ThreeBioViewer.buildInfectionScene(currentScenario(), 1);
      }
    });

    document.getElementById('btn-bio-run-infection')?.addEventListener('click', () => this.runInfectionSimulation());
    document.getElementById('btn-bio-reset-infection')?.addEventListener('click', () => {
      if (loadSlider) { loadSlider.value = 50; document.getElementById('bio-val-load').textContent = '50 part.'; }
      if (immSlider) { immSlider.value = 40; document.getElementById('bio-val-immune').textContent = '40%'; }
      this.runInfectionSimulation();
    });
  },

  setTab(tab) {
    if (this.currentTab === tab) return;
    this.currentTab = tab;

    document.querySelectorAll('.bio-tab-btn').forEach(b => b.classList.remove('bio-tab-btn--active'));
    document.querySelector(`.bio-tab-btn[data-tab="${tab}"]`)?.classList.add('bio-tab-btn--active');

    ['panel-dna', 'panel-cells', 'panel-microbes', 'panel-infection'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    const modeBadges = {
      'dna': 'DNA / Dogma',
      'cells': 'Célula Animal & Vegetal',
      'microbes': 'Bactérias & Vírus',
      'infection': 'Infecção Celular'
    };

    document.getElementById('bio-mode-val').textContent = modeBadges[tab] || tab;

    const infectionChartCard = document.getElementById('infection-chart-card');
    const polypeptideBox = document.getElementById('polypeptide-box');
    const threeLegend = document.getElementById('three-legend');

    if (tab === 'dna') {
      document.getElementById('panel-dna').style.display = 'block';
      document.getElementById('page-title').textContent = 'Biologia Molecular — Dogma Central da Genética';
      document.getElementById('page-desc').textContent = 'Explore a dupla hélice de DNA em 3D, transcrição para mRNA, ribossomo e tradução proteica.';
      document.getElementById('workbench-title').textContent = '🧬 3D DNA & Molecular Workbench';
      document.getElementById('workbench-status').textContent = this.dnaViewMode === 'ribosome' ? 'Ribossomo 70S/80S' : 'Dupla Hélice (B-DNA)';
      document.getElementById('workbench-desc').textContent = 'Estrutura molecular 3D ultraestrutural em Three.js';
      if (infectionChartCard) infectionChartCard.style.display = 'none';
      if (polypeptideBox) polypeptideBox.style.display = 'block';
      if (threeLegend) {
        threeLegend.innerHTML = `
          <span style="color:#ef4444">● Adenina (A)</span>
          <span style="color:#3b82f6">● Timina (T)</span>
          <span style="color:#10b981">● Citosina (C)</span>
          <span style="color:#f59e0b">● Guanina (G)</span>
          <span style="color:#8b5cf6">● Esqueleto Açúcar-Fosfato</span>
        `;
      }
      this.runDnaAnalysis();

    } else if (tab === 'cells') {
      document.getElementById('panel-cells').style.display = 'block';
      document.getElementById('page-title').textContent = 'Citologia — Célula Animal vs Célula Vegetal';
      document.getElementById('page-desc').textContent = 'Compare organelas eucarióticas em corte tridimensional: mitocôndrias, cloroplastos, vacúolos e parede celular.';
      document.getElementById('workbench-title').textContent = '🌿 Modelo Celular 3D com Organelas';
      document.getElementById('workbench-status').textContent = 'Corte Citológico';
      document.getElementById('workbench-desc').textContent = 'Corte transversal anatômico renderizado em Three.js';
      if (infectionChartCard) infectionChartCard.style.display = 'none';
      if (polypeptideBox) polypeptideBox.style.display = 'none';
      if (threeLegend) {
        threeLegend.innerHTML = `
          <span style="color:#8b5cf6">● Núcleo / DNA</span>
          <span style="color:#f59e0b">● Mitocôndrias (ATP)</span>
          <span style="color:#22c55e">● Cloroplastos</span>
          <span style="color:#60a5fa">● Vacúolo</span>
          <span style="color:#38bdf8">● Membrana Plasmática</span>
        `;
      }

      ThreeBioViewer.buildCellModel(this.currentCellType, this.currentCellView);

    } else if (tab === 'microbes') {
      document.getElementById('panel-microbes').style.display = 'block';
      document.getElementById('page-title').textContent = 'Microbiologia & Virologia — Bactérias e Vírus';
      document.getElementById('page-desc').textContent = 'Estrutura de bactérias Gram+/- e arquitetura de vírus e bacteriófagos com ancoragem.';
      document.getElementById('workbench-title').textContent = '🦠 Visualizador 3D de Microrganismos';
      document.getElementById('workbench-status').textContent = 'Morfologia Patogênica';
      document.getElementById('workbench-desc').textContent = 'Arquitetura de cápside, flagelos e envelope viral';
      if (infectionChartCard) infectionChartCard.style.display = 'none';
      if (polypeptideBox) polypeptideBox.style.display = 'none';
      if (threeLegend) {
        threeLegend.innerHTML = `
          <span style="color:#38bdf8">● Cápside / Flagelos</span>
          <span style="color:#ef4444">● Espículas / Receptores</span>
          <span style="color:#7c3aed">● Parede Peptidoglicano</span>
        `;
      }

      const mType = document.getElementById('bio-microbe-select')?.value || 'bacteria_gram_neg';
      ThreeBioViewer.buildMicrobeModel(mType);

    } else if (tab === 'infection') {
      document.getElementById('panel-infection').style.display = 'block';
      document.getElementById('page-title').textContent = 'Simulador de Infecção Celular & Cinética Imune';
      document.getElementById('page-desc').textContent = 'Ataque patogênico em tempo real contra células animais e vegetais com curvas de lise e resposta imune.';
      document.getElementById('workbench-title').textContent = '⚔️ Ataque Viral / Bacteriano à Célula';
      document.getElementById('workbench-status').textContent = 'Cinética de Invasão';
      document.getElementById('workbench-desc').textContent = 'Animação 3D de adsorção, injeção de genoma e resposta celular';
      if (infectionChartCard) infectionChartCard.style.display = 'block';
      if (polypeptideBox) polypeptideBox.style.display = 'none';
      if (threeLegend) {
        threeLegend.innerHTML = `
          <span style="color:#1e3a8a">● Célula Hospedeira</span>
          <span style="color:#22c55e">● Receptores de Membrana</span>
          <span style="color:#ef4444">● Partículas Virais Atacantes</span>
          <span style="color:#f43f5e">● Injeção Genética</span>
        `;
      }

      this.runInfectionSimulation();
    }
  },

  populateOrganelleSelect(cellType) {
    const sel = document.getElementById('bio-organelle-select');
    if (!sel || !this.structures) return;
    const list = cellType === 'animal' ? this.structures.animal_cell : this.structures.plant_cell;
    if (!list) return;

    sel.innerHTML = list.map(o => `<option value="${o.id}">${o.icon} ${o.name}</option>`).join('');
    if (list[0]) {
      document.getElementById('bio-org-title').textContent = `${list[0].icon} ${list[0].name}`;
      document.getElementById('bio-org-desc').textContent = list[0].function;
      document.getElementById('bio-org-energy').textContent = `⚡ Papel Energético: ${list[0].energy_atp}`;
    }
  },

  updateMicrobeInfo(microbeType) {
    const container = document.getElementById('bio-microbe-components');
    if (!container || !this.structures.microbes) return;
    const m = this.structures.microbes[microbeType];
    if (!m) return;

    let html = `<strong>${m.name}</strong><br>`;
    if (m.envelope) html += `• <strong>Envelope/Parede:</strong> ${m.envelope}<br>`;
    if (m.genome) html += `• <strong>Genoma:</strong> ${m.genome}<br>`;
    if (m.ribosome) html += `• <strong>Ribossomos:</strong> ${m.ribosome}<br>`;
    if (m.motility) html += `• <strong>Mobilidade:</strong> ${m.motility}<br>`;
    if (m.structure) html += `• <strong>Estrutura:</strong> ${m.structure}<br>`;
    if (m.spikes) html += `• <strong>Espículas/Spikes:</strong> ${m.spikes}<br>`;
    if (m.infection_mechanism) html += `• <strong>Mecanismo de Ataque:</strong> ${m.infection_mechanism}<br>`;

    container.innerHTML = html;
  },

  async runDnaAnalysis() {
    const input = document.getElementById('bio-dna-input');
    const seq = input?.value.trim().toUpperCase() || 'ATGGGCATTGTGGAACAATGCTGTACCAGCATCTGCTCCCTCTACCAGCTGGAGAACTACTGCAACTAG';

    showLoading('Transcrevendo e sintetizando proteína…');
    try {
      const data = await biologyAPI.analyzeDna(seq);
      this.lastAnalyzedDna = data;

      const compEl = document.getElementById('bio-dna-complement');
      if (compEl) compEl.textContent = data.dna_complement;

      const mrnaEl = document.getElementById('bio-mrna-output');
      if (mrnaEl) mrnaEl.textContent = data.mrna_sequence;

      const protEl = document.getElementById('bio-protein-primary');
      if (protEl) protEl.textContent = data.polypeptide_3letter || 'Nenhum peptídeo gerado.';

      // Standard Dashboard KPIs
      document.getElementById('kpi-lbl-1').textContent = 'Tamanho da Fita';
      document.getElementById('prop-symbol').textContent = `${data.dna_length} pb`;
      document.getElementById('prop-name').textContent = 'Pares de bases nitrogenadas';

      document.getElementById('kpi-lbl-2').textContent = 'Teor GC & Tm';
      document.getElementById('prop-z').textContent = `${data.gc_content_pct}%`;
      document.getElementById('kpi-unit-2').textContent = `Tm estimado: ${data.melting_temp_celsius} °C`;

      document.getElementById('kpi-lbl-3').textContent = 'Massa Molecular';
      document.getElementById('prop-mass').textContent = `${data.protein_mass_kda} kDa`;
      document.getElementById('kpi-unit-3').textContent = `${data.amino_acid_count} Aminoácidos`;

      // Results Table
      document.getElementById('table-title').textContent = '📋 Relatório de Síntese & Genética';
      document.getElementById('results-table-body').innerHTML = `
        <tr><td>Sequência de DNA (5' → 3')</td><td style="font-family:var(--font-mono); font-size:0.72rem;">${data.dna_sequence.slice(0, 32)}... (${data.dna_length} pb)</td></tr>
        <tr><td>mRNA Transcrito</td><td style="font-family:var(--font-mono); font-size:0.72rem; color:var(--accent-warning);">${data.mrna_sequence.slice(0, 32)}...</td></tr>
        <tr><td>Códons Decodificados</td><td>${data.codons.length} códons (1 Início, 1 Parada)</td></tr>
        <tr><td>Massa Molar da Proteína</td><td><strong>${data.protein_mass_da} Da</strong> (${data.protein_mass_kda} kDa)</td></tr>
        <tr><td>Teor GC (Estabilidade Térmica)</td><td>${data.gc_content_pct}% GC (Tm: ${data.melting_temp_celsius} °C)</td></tr>
        <tr><td>Carga Elétrica Líquida (pH 7.4)</td><td>${data.net_charge_ph74 >= 0 ? '+' : ''}${data.net_charge_ph74} e</td></tr>
        <tr class="results-table__highlight"><td>Cadeia Polipeptídica (1 letra)</td><td style="font-family:var(--font-mono); font-size:0.75rem; color:#38bdf8;">${data.polypeptide_1letter}</td></tr>
      `;

      // Render 3D Model
      this.renderDna3D();

      window.FloatingPanel?.markUpdated('results');
      showToast('DNA transcrito e traduzido com sucesso!', 'success');
    } catch (e) {
      console.error(e);
      showToast(describeApiError(e, 'Erro ao analisar o DNA.'), 'error');
    } finally {
      hideLoading();
    }
  },

  renderDna3D() {
    if (!this.lastAnalyzedDna) return;
    if (this.dnaViewMode === 'helix') {
      ThreeBioViewer.buildDnaDoubleHelix(this.lastAnalyzedDna.dna_sequence);
      document.getElementById('workbench-status').textContent = 'Dupla Hélice (B-DNA)';
    } else {
      ThreeBioViewer.buildRibosomeTranslation(
        this.lastAnalyzedDna.mrna_sequence,
        this.lastAnalyzedDna.codons.map(c => c.code3 || c.amino_acid)
      );
      document.getElementById('workbench-status').textContent = 'Ribossomo 70S/80S & Tradução';
    }
  },

  applyRandomMutation() {
    const input = document.getElementById('bio-dna-input');
    const seq = input.value.trim().toUpperCase();
    if (!seq.length) return;
    const bases = ['A', 'T', 'C', 'G'];
    const pos = Math.floor(Math.random() * seq.length);
    const original = seq[pos];
    const available = bases.filter(b => b !== original);
    const mutated = available[Math.floor(Math.random() * available.length)];
    const newSeq = seq.slice(0, pos) + mutated + seq.slice(pos + 1);
    input.value = newSeq;
    showToast(`Mutação pontual introduzida na posição ${pos + 1}: ${original} → ${mutated}`, 'warning');
    this.runDnaAnalysis();
  },

  applySpecificMutation(type) {
    const input = document.getElementById('bio-dna-input');
    let seq = input.value.trim().toUpperCase();
    if (seq.length < 9) return;

    if (type === 'missense') {
      seq = seq.slice(0, 3) + 'AGC' + seq.slice(6);
      showToast('Mutação Missense introduzida (Glicina → Serina)', 'warning');
    } else if (type === 'nonsense') {
      seq = seq.slice(0, 6) + 'TAG' + seq.slice(9);
      showToast('Mutação Nonsense introduzida (Códon prematuro STOP TAG)', 'error');
    } else if (type === 'frameshift') {
      seq = seq.slice(0, 4) + 'C' + seq.slice(4);
      showToast('Mutação Frameshift introduzida (Inserção +1 base altera leitura)', 'error');
    } else if (type === 'silent') {
      seq = seq.slice(0, 3) + 'GGT' + seq.slice(6);
      showToast('Mutação Silenciosa introduzida (GGC → GGT mantém Glicina)', 'info');
    }

    input.value = seq;
    this.runDnaAnalysis();
  },

  async runInfectionSimulation() {
    const scenario = document.getElementById('bio-infect-scenario')?.value || 'virus_animal';
    const initialLoad = parseInt(document.getElementById('bio-slider-load')?.value || '50', 10);
    const immuneLevel = parseInt(document.getElementById('bio-slider-immune')?.value || '40', 10);
    const treatment = document.getElementById('bio-infect-treatment')?.value || 'none';

    showLoading('Simulando dinâmica de infecção celular…');
    try {
      const data = await biologyAPI.simulateInfection({
        scenario,
        initial_load: initialLoad,
        immune_defense_level: immuneLevel,
        treatment,
        duration_steps: 30
      });

      ThreeBioViewer.buildInfectionScene(scenario, 2);
      this.renderInfectionChart(data.timeline);

      document.getElementById('kpi-lbl-1').textContent = 'Pico de Carga';
      document.getElementById('prop-symbol').textContent = `${data.max_pathogen_count} part.`;
      document.getElementById('prop-name').textContent = 'Pico de partículas no tecido';

      document.getElementById('kpi-lbl-2').textContent = 'Viabilidade Celular';
      document.getElementById('prop-z').textContent = `${data.final_cell_health}%`;
      document.getElementById('kpi-unit-2').textContent = 'Integridade celular final';

      document.getElementById('kpi-lbl-3').textContent = 'Energia Celular';
      document.getElementById('prop-mass').textContent = `${data.final_atp}%`;
      document.getElementById('kpi-unit-3').textContent = `Desfecho: ${data.outcome}`;

      document.getElementById('table-title').textContent = '📋 Relatório de Cinética Infecciosa';
      document.getElementById('results-table-body').innerHTML = `
        <tr><td>Cenário Patogênico</td><td><strong>${scenario.replace('_', ' ').toUpperCase()}</strong></td></tr>
        <tr><td>Carga Inicial vs Pico Máximo</td><td>${data.initial_load} → <strong>${data.max_pathogen_count}</strong> partículas</td></tr>
        <tr><td>Viabilidade Celular Final</td><td style="color:${data.final_cell_health > 30 ? 'var(--accent-success)' : 'var(--accent-danger)'}; font-weight:700;">${data.final_cell_health}%</td></tr>
        <tr><td>Energia Metabólica (ATP)</td><td>${data.final_atp}%</td></tr>
        <tr><td>Tratamento Farmacológico</td><td>${treatment.replace('_', ' ')}</td></tr>
        <tr class="results-table__highlight"><td>Desfecho da Infecção</td><td><strong>${data.outcome}</strong></td></tr>
      `;

      const extraCard = document.getElementById('extra-analysis-card');
      const extraContent = document.getElementById('extra-analysis-content');
      if (extraCard && extraContent) {
        extraContent.innerHTML = `
          • <strong>Cinética da Infecção:</strong> O patógeno utilizou os ribossomos e ATP do hospedeiro para montagem de novas partículas virais.<br>
          • <strong>Ação Imunológica:</strong> Eficácia de depuração proporcional aos anticorpos e barreiras celulares.<br>
          • <strong>Conclusão:</strong> ${data.outcome}
        `;
      }

      window.FloatingPanel?.markUpdated('results');
      showToast('Simulação de infecção concluída!', 'success');
    } catch (e) {
      console.error(e);
      showToast('Erro ao executar simulação de infecção.', 'error');
    } finally {
      hideLoading();
    }
  },

  renderInfectionChart(timeline) {
    if (typeof Plotly === 'undefined' || !timeline || !timeline.length) return;

    const times = timeline.map(t => `${t.time_hours}h`);
    const pathogen = timeline.map(t => t.pathogen_count);
    const health = timeline.map(t => t.host_cell_health);
    const atp = timeline.map(t => t.cellular_atp);

    const trace1 = {
      x: times,
      y: pathogen,
      name: 'Carga Viral / Bactérias',
      type: 'scatter',
      mode: 'lines+markers',
      line: { color: '#ef4444', width: 3 }
    };

    const trace2 = {
      x: times,
      y: health,
      name: 'Viabilidade Celular (%)',
      type: 'scatter',
      mode: 'lines',
      line: { color: '#10b981', width: 2, dash: 'dot' }
    };

    const trace3 = {
      x: times,
      y: atp,
      name: 'Nível de ATP (%)',
      type: 'scatter',
      mode: 'lines',
      line: { color: '#f59e0b', width: 2 }
    };

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 10 },
      margin: { t: 20, r: 20, l: 35, b: 35 },
      showlegend: true,
      legend: { orientation: 'h', y: -0.25 },
      xaxis: { gridcolor: 'rgba(255,255,255,0.08)' },
      yaxis: { gridcolor: 'rgba(255,255,255,0.08)' }
    };

    Plotly.newPlot('infection-plot', [trace1, trace2, trace3], layout, { responsive: true, displayModeBar: false });
  }
};

// =================================================================
// INITIALIZATION
// =================================================================
document.addEventListener('DOMContentLoaded', () => {
  BiologyDashboard.init();
  window.BiologyDashboard = BiologyDashboard;
});
