/**
 * frontend/src/pages/chemistry.js
 * ==============================
 * Vite page bundle entry point for the Chemistry & Atoms dashboard.
 *
 * Ported from the inline <script> that used to live in templates/app_chemistry/index.html.
 * The shared UI helpers and the API client are imported; Three.js stays on the
 * global installed by the template's vendored <script> tag.
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
import { chemistryAPI, describeApiError } from '../modules/shared/api.js';
import {
  createAnimationLoop,
  disposeObject3D,
  resizeRendererToCanvas,
} from '../modules/shared/three-utils.js';

// =================================================================
// 1. CONFIGURAÇÕES E ESTADO
// =================================================================
const categoryColors = {
  "diatomic nonmetal": "rgba(16, 185, 129, 0.12)",
  "polyatomic nonmetal": "rgba(16, 185, 129, 0.12)",
  "noble gas": "rgba(6, 182, 212, 0.12)",
  "alkali metal": "rgba(239, 68, 68, 0.12)",
  "alkaline earth metal": "rgba(245, 158, 11, 0.12)",
  "metalloid": "rgba(59, 130, 246, 0.12)",
  "halogen": "rgba(139, 92, 246, 0.12)",
  "transition metal": "rgba(51, 65, 85, 0.35)",
  "lanthanide": "rgba(167, 139, 250, 0.12)",
  "actinide": "rgba(244, 114, 182, 0.12)",
  "post-transition metal": "rgba(100, 116, 139, 0.12)",
  "unknown": "rgba(255, 255, 255, 0.02)"
};

const categoryBorders = {
  "diatomic nonmetal": "rgba(16, 185, 129, 0.4)",
  "polyatomic nonmetal": "rgba(16, 185, 129, 0.4)",
  "noble gas": "rgba(6, 182, 212, 0.4)",
  "alkali metal": "rgba(239, 68, 68, 0.4)",
  "alkaline earth metal": "rgba(245, 158, 11, 0.4)",
  "metalloid": "rgba(59, 130, 246, 0.4)",
  "halogen": "rgba(139, 92, 246, 0.4)",
  "transition metal": "rgba(51, 65, 85, 0.5)",
  "lanthanide": "rgba(167, 139, 250, 0.4)",
  "actinide": "rgba(244, 114, 182, 0.4)",
  "post-transition metal": "rgba(100, 116, 139, 0.4)",
  "unknown": "rgba(255, 255, 255, 0.1)"
};

// Presentational-only CPK-style colors for the custom molecule builder — not
// scientific data, so a small curated palette + category fallback is fine
// (unlike mass/electronegativity/radius, which now come from the real
// backend dataset for any of the 118 elements, not just these 10).
const elementColorPalette = {
  "H": "#ffffff", "C": "#4b5563", "O": "#ef4444", "N": "#3b82f6",
  "Na": "#a78bfa", "Cl": "#10b981", "Fe": "#f59e0b", "Li": "#ec4899",
  "F": "#14b8a6", "Mg": "#047857",
};
const categorySolidColors = {
  "diatomic nonmetal": "#10b981", "polyatomic nonmetal": "#10b981",
  "noble gas": "#06b6d4", "alkali metal": "#ef4444",
  "alkaline earth metal": "#f59e0b", "metalloid": "#3b82f6",
  "halogen": "#8b5cf6", "transition metal": "#94a3b8",
  "lanthanide": "#a78bfa", "actinide": "#f472b6",
  "post-transition metal": "#64748b", "unknown": "#cbd5e1",
};

function getElementDisplayColor(symbol, category) {
  return elementColorPalette[symbol] || categorySolidColors[category] || '#94a3b8';
}

function getElementDisplayRadius(atomicRadiusPm) {
  // Map real covalent radius (typically ~30-230 pm) to a scene-friendly
  // visual radius, clamped so very large/small atoms stay legible.
  if (!atomicRadiusPm) return 0.22;
  return Math.min(0.34, Math.max(0.14, 0.10 + (atomicRadiusPm / 230) * 0.24));
}

// Educational approximation of covalent valence: the maximum total bond
// order (single=1, double=2, triple=3, summed) an atom can form before its
// octet/duet is considered satisfied. Shared by the real-time bond
// validator (molecule builder) and the post-simulation summary, so there is
// a single source of truth instead of two separate tables.
const VALENCE_LIMITS = {
  H: 1, He: 0, Li: 1, Be: 2, B: 3, C: 4, N: 3, O: 2, F: 1, Ne: 0,
  Na: 1, Mg: 2, Al: 3, Si: 4, P: 3, S: 2, Cl: 1, Ar: 0,
  K: 1, Ca: 2, Fe: 3, Cu: 2, Zn: 2, Br: 1, Ag: 1, I: 1, Au: 3, Pb: 4,
};

function valenceLimitFor(element) {
  return VALENCE_LIMITS[element] ?? 4;
}

function bondCountFor(atomIdx, bonds) {
  return bonds.reduce((sum, b) => (
    (b.atom1Index === atomIdx || b.atom2Index === atomIdx) ? sum + b.order : sum
  ), 0);
}

// Mutual-repulsion + spring relaxation shared by the custom molecule
// builder (bonds present) and the stoichiometry "composition cloud"
// (bonds=[], pure repulsion spreads the atoms apart without overlap).
function relaxAtomPositions(atoms, bonds) {
  atoms.forEach(a => {
    a.x = (Math.random() - 0.5) * 0.4;
    a.y = (Math.random() - 0.5) * 0.4;
    a.z = (Math.random() - 0.5) * 0.4;
  });

  const k = 0.18, d0 = 0.85, repulsion = 0.06, damping = 0.82, iterations = 85;
  const velocities = atoms.map(() => ({ x: 0, y: 0, z: 0 }));

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const a1 = atoms[i], a2 = atoms[j];
        const dx = a2.x - a1.x, dy = a2.y - a1.y, dz = a2.z - a1.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
        const f = repulsion / (dist * dist);
        const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
        velocities[i].x -= fx; velocities[i].y -= fy; velocities[i].z -= fz;
        velocities[j].x += fx; velocities[j].y += fy; velocities[j].z += fz;
      }
    }

    bonds.forEach(bond => {
      const a1 = atoms[bond.atom1Index], a2 = atoms[bond.atom2Index];
      if (!a1 || !a2) return;
      const dx = a2.x - a1.x, dy = a2.y - a1.y, dz = a2.z - a1.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const f = k * (dist - d0);
      const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
      velocities[bond.atom1Index].x += fx; velocities[bond.atom1Index].y += fy; velocities[bond.atom1Index].z += fz;
      velocities[bond.atom2Index].x -= fx; velocities[bond.atom2Index].y -= fy; velocities[bond.atom2Index].z -= fz;
    });

    for (let i = 0; i < atoms.length; i++) {
      atoms[i].x += velocities[i].x; atoms[i].y += velocities[i].y; atoms[i].z += velocities[i].z;
      velocities[i].x *= damping; velocities[i].y *= damping; velocities[i].z *= damping;
    }
  }

  let cx = 0, cy = 0, cz = 0;
  atoms.forEach(a => { cx += a.x; cy += a.y; cz += a.z; });
  if (atoms.length) { cx /= atoms.length; cy /= atoms.length; cz /= atoms.length; }
  atoms.forEach(a => { a.x -= cx; a.y -= cy; a.z -= cz; });
}

let customAtoms = [];
let customBonds = [];

// =================================================================
// 1b. MOLECULE BUILDER — drag-and-drop bench (wide periodic-table panel)
//
// Atoms are dragged in from the periodic table (dragstart sets the
// element symbol) and dropped onto #molecule-canvas, becoming entries in
// the same customAtoms/customBonds arrays that runCustomSimulation()
// already knows how to relax + render via ThreeAtom.buildMolecule — this
// bench only changes *how* those arrays get populated (drag instead of
// dropdowns), not what happens afterwards.
//
// Two canvas interaction modes:
//   - "move": free-drag to reposition an atom chip.
//   - "bond": drag from one chip to another to connect them, validated
//     against VALENCE_LIMITS in real time (rejected bonds never enter
//     customBonds, so the post-simulation warning is just a fallback).
// =================================================================
const MoleculeBuilder = {
  mode: 'move',
  canvas: null,
  svg: null,
  draggingChip: null,     // { idx, offsetX, offsetY } while repositioning
  bondDragFromIdx: null,  // atom index while drawing a rubber-band bond line
  tempLine: null,

  init() {
    this.canvas = document.getElementById('molecule-canvas');
    this.svg = document.getElementById('molecule-canvas-svg');
    if (!this.canvas) return;

    this.canvas.addEventListener('dragover', (e) => e.preventDefault());
    this.canvas.addEventListener('drop', (e) => this.onDrop(e));

    document.getElementById('btn-canvas-mode-move')?.addEventListener('click', () => this.setMode('move'));
    document.getElementById('btn-canvas-mode-bond')?.addEventListener('click', () => this.setMode('bond'));

    window.addEventListener('pointermove', (e) => this.onGlobalPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onGlobalPointerUp(e));
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById('btn-canvas-mode-move')?.classList.toggle('molecule-builder__mode-btn--active', mode === 'move');
    document.getElementById('btn-canvas-mode-bond')?.classList.toggle('molecule-builder__mode-btn--active', mode === 'bond');
  },

  async onDrop(e) {
    e.preventDefault();
    const symbol = e.dataTransfer.getData('text/plain');
    if (!symbol) return;
    const listEntry = DashboardManager.elementsBySymbol[symbol];
    if (!listEntry) return;

    const rect = this.canvas.getBoundingClientRect();
    const x2d = Math.max(22, Math.min(rect.width - 22, e.clientX - rect.left));
    const y2d = Math.max(22, Math.min(rect.height - 22, e.clientY - rect.top));

    try {
      // Already unwrapped from the {status, data} envelope by the client.
      const el = await chemistryAPI.getElement(symbol);
      customAtoms.push({
        element: symbol,
        name: listEntry.name,
        mass: listEntry.mass,
        color: getElementDisplayColor(symbol, listEntry.category),
        radius: getElementDisplayRadius(el.atomic_radius_pm),
        electronegativity: el.electronegativity,
        x2d, y2d,
      });
      this.renderAll();
    } catch (err) {
      console.error(err);
      showToast('Erro ao buscar propriedades do elemento.', 'error');
    }
  },

  onChipPointerDown(e, idx) {
    e.preventDefault();
    e.stopPropagation();
    const rect = this.canvas.getBoundingClientRect();
    const atom = customAtoms[idx];

    if (this.mode === 'bond') {
      this.bondDragFromIdx = idx;
      this.tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      this.tempLine.setAttribute('class', 'molecule-canvas__temp-line');
      this.tempLine.setAttribute('x1', atom.x2d);
      this.tempLine.setAttribute('y1', atom.y2d);
      this.tempLine.setAttribute('x2', atom.x2d);
      this.tempLine.setAttribute('y2', atom.y2d);
      this.svg.appendChild(this.tempLine);
    } else {
      this.draggingChip = {
        idx,
        offsetX: (e.clientX - rect.left) - atom.x2d,
        offsetY: (e.clientY - rect.top) - atom.y2d,
      };
    }
  },

  onGlobalPointerMove(e) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();

    if (this.draggingChip) {
      const atom = customAtoms[this.draggingChip.idx];
      atom.x2d = Math.max(22, Math.min(rect.width - 22, e.clientX - rect.left - this.draggingChip.offsetX));
      atom.y2d = Math.max(22, Math.min(rect.height - 22, e.clientY - rect.top - this.draggingChip.offsetY));
      this.updateChipPosition(this.draggingChip.idx);
    } else if (this.bondDragFromIdx !== null && this.tempLine) {
      this.tempLine.setAttribute('x2', e.clientX - rect.left);
      this.tempLine.setAttribute('y2', e.clientY - rect.top);
    }
  },

  onGlobalPointerUp(e) {
    if (this.draggingChip) {
      this.draggingChip = null;
    } else if (this.bondDragFromIdx !== null) {
      const targetIdx = this.hitTestChip(e.clientX, e.clientY);
      this.tryCreateBond(this.bondDragFromIdx, targetIdx);
      if (this.tempLine) { this.tempLine.remove(); this.tempLine = null; }
      this.bondDragFromIdx = null;
    }
  },

  hitTestChip(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const chip = el?.closest('.atom-chip');
    return chip ? parseInt(chip.dataset.idx, 10) : null;
  },

  tryCreateBond(fromIdx, toIdx) {
    if (toIdx === null || toIdx === fromIdx) return;
    const a1 = customAtoms[fromIdx], a2 = customAtoms[toIdx];
    if (!a1 || !a2) return;

    const exists = customBonds.some(b =>
      (b.atom1Index === fromIdx && b.atom2Index === toIdx) ||
      (b.atom1Index === toIdx && b.atom2Index === fromIdx));
    if (exists) { showToast('Já existe uma ligação entre esses átomos.', 'error'); return; }

    const order = parseInt(document.getElementById('builder-bond-order').value, 10) || 1;
    const limit1 = valenceLimitFor(a1.element);
    const limit2 = valenceLimitFor(a2.element);
    const used1 = bondCountFor(fromIdx, customBonds);
    const used2 = bondCountFor(toIdx, customBonds);

    if (used1 + order > limit1) {
      showToast(`⚠️ ${a1.element}#${fromIdx} já atingiu o limite de ${limit1} ligação(ões).`, 'error');
      return;
    }
    if (used2 + order > limit2) {
      showToast(`⚠️ ${a2.element}#${toIdx} já atingiu o limite de ${limit2} ligação(ões).`, 'error');
      return;
    }

    customBonds.push({ atom1Index: fromIdx, atom2Index: toIdx, order });
    this.renderAll();
  },

  removeAtom(idx) {
    DashboardManager.removeCustomAtom(idx);
    this.renderAll();
  },

  clearAll() {
    customAtoms = [];
    customBonds = [];
    this.renderAll();
  },

  updateChipPosition(idx) {
    const chip = this.canvas.querySelector(`.atom-chip[data-idx="${idx}"]`);
    const atom = customAtoms[idx];
    if (chip && atom) {
      chip.style.left = `${atom.x2d}px`;
      chip.style.top = `${atom.y2d}px`;
    }
    customBonds.forEach((b, bi) => {
      if (b.atom1Index !== idx && b.atom2Index !== idx) return;
      const line = this.svg.querySelector(`.bond-line[data-bi="${bi}"]`);
      const a1 = customAtoms[b.atom1Index], a2 = customAtoms[b.atom2Index];
      if (line && a1 && a2) {
        line.setAttribute('x1', a1.x2d); line.setAttribute('y1', a1.y2d);
        line.setAttribute('x2', a2.x2d); line.setAttribute('y2', a2.y2d);
      }
    });
  },

  renderChip(idx) {
    const atom = customAtoms[idx];
    const chip = document.createElement('div');
    chip.className = 'atom-chip';
    chip.dataset.idx = idx;
    chip.style.left = `${atom.x2d}px`;
    chip.style.top = `${atom.y2d}px`;
    chip.style.background = atom.color;
    const limit = valenceLimitFor(atom.element);
    const used = bondCountFor(idx, customBonds);
    chip.innerHTML = `
      ${atom.element}
      <span class="atom-chip__valence${used === limit && limit > 0 ? ' atom-chip__valence--full' : ''}">${used}/${limit}</span>
      <button type="button" class="atom-chip__remove" aria-label="Remover átomo">✕</button>
    `;
    chip.querySelector('.atom-chip__remove').addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.removeAtom(idx);
    });
    chip.addEventListener('pointerdown', (ev) => this.onChipPointerDown(ev, idx));
    this.canvas.appendChild(chip);
  },

  renderAll() {
    if (!this.canvas) return;
    this.canvas.querySelectorAll('.atom-chip').forEach(c => c.remove());
    this.svg.innerHTML = '';

    const hint = document.getElementById('molecule-canvas-hint');
    if (hint) hint.style.display = customAtoms.length ? 'none' : 'flex';

    customBonds.forEach((b, bi) => {
      const a1 = customAtoms[b.atom1Index], a2 = customAtoms[b.atom2Index];
      if (!a1 || !a2) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'bond-line');
      line.dataset.bi = bi;
      line.setAttribute('x1', a1.x2d); line.setAttribute('y1', a1.y2d);
      line.setAttribute('x2', a2.x2d); line.setAttribute('y2', a2.y2d);
      line.setAttribute('stroke-width', String(2 + (b.order - 1) * 2));
      this.svg.appendChild(line);
    });

    customAtoms.forEach((atom, idx) => this.renderChip(idx));
    this.updateStatus();
    this.updateSummary();
  },

  updateStatus() {
    const statusEl = document.getElementById('molecule-equilibrium-status');
    if (!statusEl) return;
    if (customAtoms.length === 0) {
      statusEl.textContent = 'Nenhum átomo adicionado.';
      statusEl.className = 'molecule-builder__status';
      return;
    }
    const complete = customAtoms.filter((a, i) => {
      const limit = valenceLimitFor(a.element);
      return limit > 0 && bondCountFor(i, customBonds) === limit;
    }).length;
    if (complete === customAtoms.length) {
      statusEl.textContent = '✅ Todos os átomos com valência completa.';
      statusEl.className = 'molecule-builder__status molecule-builder__status--ok';
    } else {
      statusEl.textContent = `ℹ️ ${customAtoms.length - complete} átomo(s) ainda com ligações livres.`;
      statusEl.className = 'molecule-builder__status';
    }
  },

  updateSummary() {
    const summaryEl = document.getElementById('molecule-builder-summary');
    if (!summaryEl) return;
    if (customBonds.length === 0) {
      summaryEl.textContent = customAtoms.length ? 'Nenhuma ligação criada ainda.' : '';
      return;
    }
    const orderNames = { 1: 'simples', 2: 'dupla', 3: 'tríplice' };
    summaryEl.textContent = customBonds.map(b => {
      const a1 = customAtoms[b.atom1Index], a2 = customAtoms[b.atom2Index];
      return `${a1.element}#${b.atom1Index}-${a2.element}#${b.atom2Index} (${orderNames[b.order]})`;
    }).join(' · ');
  },
};

// =================================================================
// 1c. IUPAC NOMENCLATURE & FORMULA ENGINE
// =================================================================
const IUPACNomenclature = {
  knownMolecules: {
    'H2O': { name: 'Água (Monóxido de Di-hidrogênio)', type: 'Óxido / Solvente Polar', iupac: 'Oxidano' },
    'CO2': { name: 'Dióxido de Carbono', type: 'Óxido Ácido Linear', iupac: 'Dióxido de Carbono' },
    'CH4': { name: 'Metano', type: 'Hidrocarboneto (Alcano)', iupac: 'Metano' },
    'NH3': { name: 'Amônia (Azano)', type: 'Base de Lewis Piramidal', iupac: 'Azano' },
    'HCl': { name: 'Ácido Clorídrico (Cloreto de Hidrogênio)', type: 'Hidrácido Forte', iupac: 'Clorano' },
    'HF': { name: 'Fluoreto de Hidrogênio', type: 'Hidrácido com Pontes de H', iupac: 'Fluorano' },
    'H2O2': { name: 'Peróxido de Hidrogênio (Água Oxigenada)', type: 'Peróxido Oxidante', iupac: 'Dioxidano' },
    'H2SO4': { name: 'Ácido Sulfúrico', type: 'Oxiácido Forte Diprótico', iupac: 'Sulfato de Di-hidrogênio' },
    'HNO3': { name: 'Ácido Nítrico', type: 'Oxiácido Forte Monoprótico', iupac: 'Nitrato de Hidrogênio' },
    'H3PO4': { name: 'Ácido Fosfórico', type: 'Oxiácido Triprótico', iupac: 'Fosfato de Tri-hidrogênio' },
    'H2CO3': { name: 'Ácido Carbônico', type: 'Oxiácido Instável', iupac: 'Carbonato de Di-hidrogênio' },
    'HCN': { name: 'Cianeto de Hidrogênio', type: 'Nitrila / Hidrácido', iupac: 'Cianeto de Hidrogênio' },
    'NaCl': { name: 'Cloreto de Sódio (Sal de Cozinha)', type: 'Sal Iônico Haleto', iupac: 'Cloreto de Sódio' },
    'KCl': { name: 'Cloreto de Potássio', type: 'Sal Iônico Mineral', iupac: 'Cloreto de Potássio' },
    'NaOH': { name: 'Hidróxido de Sódio (Soda Cáustica)', type: 'Base Forte Arrhenius', iupac: 'Hidróxido de Sódio' },
    'KOH': { name: 'Hidróxido de Potássio', type: 'Base Forte', iupac: 'Hidróxido de Potássio' },
    'Ca(OH)2': { name: 'Hidróxido de Cálcio (Cal Extinta)', type: 'Base Dibásica', iupac: 'Di-hidróxido de Cálcio' },
    'CaCO3': { name: 'Carbonato de Cálcio (Calcário)', type: 'Sal Insolúvel Oxissal', iupac: 'Carbonato de Cálcio' },
    'CaO': { name: 'Óxido de Cálcio (Cal Viva)', type: 'Óxido Básico', iupac: 'Monóxido de Cálcio' },
    'MgO': { name: 'Óxido de Magnésio (Magnésia)', type: 'Óxido Refratário', iupac: 'Monóxido de Magnésio' },
    'Fe2O3': { name: 'Óxido de Ferro(III) (Ferrugem / Hematita)', type: 'Óxido Metálico', iupac: 'Trióxido de Diferro' },
    'FeO': { name: 'Óxido de Ferro(II)', type: 'Óxido Metálico', iupac: 'Monóxido de Ferro' },
    'Fe3O4': { name: 'Magnetita (Óxido Duplo de Ferro)', type: 'Óxido Magnético', iupac: 'Tetraóxido de Triferro' },
    'Al2O3': { name: 'Óxido de Alumínio (Alumina)', type: 'Óxido Anfótero', iupac: 'Trióxido de Dialumínio' },
    'LiF': { name: 'Fluoreto de Lítio', type: 'Sal Iônico Cristalino', iupac: 'Fluoreto de Lítio' },
    'C2H6': { name: 'Etano', type: 'Alcano Saturado', iupac: 'Etano' },
    'C2H4': { name: 'Eteno (Etileno)', type: 'Alceno Insaturado (Ligação Dupla)', iupac: 'Eteno' },
    'C2H2': { name: 'Etino (Acetileno)', type: 'Alcino Insaturado (Ligação Tripla)', iupac: 'Etino' },
    'C3H8': { name: 'Propano', type: 'Gás GLP Alcano', iupac: 'Propano' },
    'C4H10': { name: 'Butano', type: 'Gás GLP Alcano', iupac: 'Butano' },
    'CH3OH': { name: 'Metanol (Álcool Metílico)', type: 'Álcool Primário Polar', iupac: 'Metanol' },
    'C2H5OH': { name: 'Etanol (Álcool Etílico)', type: 'Álcool Primário', iupac: 'Etanol' },
    'C2H6O': { name: 'Etanol / Éter Dimetílico', type: 'Composto Oxigenado', iupac: 'Etanol ou Metoximetano' },
    'CH2O': { name: 'Formaldeído (Metanal)', type: 'Aldeído Simples', iupac: 'Metanal' },
    'CH3COOH': { name: 'Ácido Acético (Vinagre)', type: 'Ácido Carboxílico', iupac: 'Ácido Etanoico' },
    'C2H4O2': { name: 'Ácido Acético / Formiato de Metila', type: 'Composto Carboxílico', iupac: 'Ácido Etanoico' },
    'C6H6': { name: 'Benzeno', type: 'Hidrocarboneto Aromático', iupac: 'Ciclo-hexa-1,3,5-trieno' },
    'C6H12O6': { name: 'Glicose / Frutose (Monossacarídeo)', type: 'Carboidrato Energético', iupac: 'D-Glicose' },
    'O2': { name: 'Gás Oxigênio (Dioxigênio)', type: 'Substância Simples Diatômica', iupac: 'Dioxigênio' },
    'N2': { name: 'Gás Nitrogênio (Dinitrogênio)', type: 'Substância com Ligação Tripla N≡N', iupac: 'Dinitrogênio' },
    'H2': { name: 'Gás Hidrogênio (Di-hidrogênio)', type: 'Molécula Covalente Leve', iupac: 'Di-hidrogênio' },
    'Cl2': { name: 'Gás Cloro (Dicloro)', type: 'Halogênio Diatômico Oxidante', iupac: 'Dicloro' },
    'F2': { name: 'Gás Flúor (Diflúor)', type: 'Halogênio Altamente Reativo', iupac: 'Diflúor' },
    'Br2': { name: 'Bromo Líquido (Dibromo)', type: 'Halogênio Líquido', iupac: 'Dibromo' },
    'I2': { name: 'Iodo Sólido (Di-iodo)', type: 'Halogênio Sublimável', iupac: 'Di-iodo' },
    'O3': { name: 'Ozônio (Trioxigênio)', type: 'Alótropo Angular Oxidante', iupac: 'Trioxigênio' },
    'SO2': { name: 'Dióxido de Enxofre', type: 'Óxido Ácido Angular', iupac: 'Dióxido de Enxofre' },
    'SO3': { name: 'Trióxido de Enxofre', type: 'Anidrido Sulfúrico Trigonal', iupac: 'Trióxido de Enxofre' },
    'NO': { name: 'Monóxido de Nitrogênio (Óxido Nítrico)', type: 'Radical Livre Neutro', iupac: 'Monóxido de Nitrogênio' },
    'NO2': { name: 'Dióxido de Nitrogênio', type: 'Gás Castanho Radicalar', iupac: 'Dióxido de Nitrogênio' },
    'N2O': { name: 'Óxido Nitroso (Gás Hilariante)', type: 'Óxido Linear Anestésico', iupac: 'Monóxido de Dinitrogênio' },
    'CO': { name: 'Monóxido de Carbono', type: 'Óxido Neutro com Ligação Tripla', iupac: 'Monóxido de Carbono' },
    'PCl3': { name: 'Tricloreto de Fósforo', type: 'Haleto Piramidal', iupac: 'Triclorofosfano' },
    'PCl5': { name: 'Pentacloreto de Fósforo', type: 'Haleto com Octeto Expandido', iupac: 'Pentaclorofosforano' },
    'SF6': { name: 'Hexafluoreto de Enxofre', type: 'Gás Dielétrico Octaédrico', iupac: 'Hexafluorossulfurano' },
    'BF3': { name: 'Trifluoreto de Boro', type: 'Ácido de Lewis Trigonal Hipovalente', iupac: 'Trifluoroborano' },
    'BeCl2': { name: 'Dicloreto de Berílio', type: 'Haleto Linear Hipovalente', iupac: 'Dicloroberílio' },
    'CCl4': { name: 'Tetracloreto de Carbono', type: 'Solvente Apolar Tetraédrico', iupac: 'Tetraclorometano' }
  },

  getEmpiricalFormula(counts) {
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const nums = Object.values(counts);
    if (!nums.length) return '';
    const divisor = nums.reduce((g, n) => gcd(g, n), nums[0]);
    let emp = '';
    const sorted = Object.keys(counts).sort((a, b) => {
      if (a === 'C') return -1;
      if (b === 'C') return 1;
      if (a === 'H') return -1;
      if (b === 'H') return 1;
      return a.localeCompare(b);
    });
    sorted.forEach(k => {
      const c = counts[k] / divisor;
      emp += k + (c > 1 ? c : '');
    });
    return emp;
  },

  generateSystematicName(atoms, counts, bonds) {
    const elements = Object.keys(counts);
    if (elements.length === 1) {
      const el = elements[0];
      const count = counts[el];
      const greek = { 1: 'Mono', 2: 'Di', 3: 'Tri', 4: 'Tetra', 5: 'Penta', 6: 'Hexa', 8: 'Octa' };
      return `${greek[count] || count + '-'}${el} (Substância Simples)`;
    }

    if (elements.length === 2 && counts['C'] && counts['H']) {
      const nC = counts['C'];
      const nH = counts['H'];
      const prefixes = { 1: 'Met', 2: 'Et', 3: 'Prop', 4: 'But', 5: 'Pent', 6: 'Hex', 7: 'Hept', 8: 'Oct', 9: 'Non', 10: 'Dec' };
      const base = prefixes[nC] || `C${nC}`;
      if (nH === 2 * nC + 2) return `${base}ano (Alcano Saturado)`;
      if (nH === 2 * nC) return `${base}eno (Alceno Insaturado)`;
      if (nH === 2 * nC - 2) return `${base}ino (Alcino com Ligação Tripla)`;
      return `Hidrocarboneto ${base}-${nH}H`;
    }

    if (elements.length === 2) {
      const greek = { 1: 'mono', 2: 'di', 3: 'tri', 4: 'tetra', 5: 'penta', 6: 'hexa', 7: 'hepta', 8: 'octa' };
      const a = elements[0], b = elements[1];
      const an = atoms.find(at => at.element === a);
      const bn = atoms.find(at => at.element === b);
      const elPos = (an?.electronegativity ?? 2.0) <= (bn?.electronegativity ?? 2.0) ? a : b;
      const elNeg = elPos === a ? b : a;

      const suffixMap = {
        'O': 'óxido', 'Cl': 'cloreto', 'F': 'fluoreto', 'Br': 'brometo',
        'I': 'iodeto', 'S': 'sulfeto', 'N': 'nitreto', 'P': 'fosfeto', 'H': 'hidreto', 'C': 'carbeto'
      };

      const negName = suffixMap[elNeg] || `${elNeg}eto`;
      const pNeg = greek[counts[elNeg]] || `${counts[elNeg]}-`;
      const pPos = counts[elPos] > 1 ? `de ${greek[counts[elPos]] || ''}${elPos}` : `de ${elPos}`;

      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      return `${cap(pNeg)}${negName} ${pPos}`;
    }

    return `Composto Poliatômico (${Object.entries(counts).map(([k, v]) => `${k}${v > 1 ? v : ''}`).join('')})`;
  }
};

// =================================================================
// 1d. BOND FEASIBILITY & VSEPR MOLECULAR GEOMETRY ANALYZER
// =================================================================
const BondFeasibilityAnalyzer = {
  analyze(atoms, bonds) {
    if (!atoms.length) return null;

    const bondAnalysis = bonds.map(b => {
      const a1 = atoms[b.atom1Index];
      const a2 = atoms[b.atom2Index];
      const en1 = a1.electronegativity;
      const en2 = a2.electronegativity;
      let deltaEN = null;
      let ionicPercent = null;
      let classification = 'Indeterminada';
      let isHydrogenBondDonor = false;

      if (en1 != null && en2 != null) {
        deltaEN = Math.abs(en1 - en2);
        ionicPercent = (1 - Math.exp(-0.25 * deltaEN * deltaEN)) * 100;

        if (deltaEN >= 1.7) {
          classification = 'Iônica';
        } else if (deltaEN >= 0.4) {
          classification = 'Covalente Polar';
        } else {
          classification = 'Covalente Apolar';
        }

        if ((a1.element === 'H' && ['F', 'O', 'N'].includes(a2.element)) ||
            (a2.element === 'H' && ['F', 'O', 'N'].includes(a1.element))) {
          isHydrogenBondDonor = true;
        }
      }

      return {
        atom1: a1.element,
        idx1: b.atom1Index,
        atom2: a2.element,
        idx2: b.atom2Index,
        order: b.order,
        deltaEN,
        ionicPercent,
        classification,
        isHydrogenBondDonor
      };
    });

    let centralIdx = 0;
    let maxConnections = -1;
    atoms.forEach((a, i) => {
      const conn = bonds.filter(b => b.atom1Index === i || b.atom2Index === i).length;
      if (conn > maxConnections && a.element !== 'H') {
        maxConnections = conn;
        centralIdx = i;
      }
    });

    const centralAtom = atoms[centralIdx];
    const centralBonds = bonds.filter(b => b.atom1Index === centralIdx || b.atom2Index === centralIdx);
    const centralBondPairs = centralBonds.reduce((acc, b) => acc + b.order, 0);

    const VALENCE_ELECTRONS = {
      H: 1, He: 2, Li: 1, Be: 2, B: 3, C: 4, N: 5, O: 6, F: 7, Ne: 8,
      Na: 1, Mg: 2, Al: 3, Si: 4, P: 5, S: 6, Cl: 7, Ar: 8,
      K: 1, Ca: 2, Fe: 2, Cu: 2, Zn: 2, Br: 7, I: 7, Xe: 8
    };
    const centralValence = VALENCE_ELECTRONS[centralAtom?.element] ?? 4;
    const centralLoneElectrons = Math.max(0, centralValence - centralBondPairs);
    const centralLonePairs = Math.floor(centralLoneElectrons / 2);
    const stericNumber = centralBonds.length + centralLonePairs;

    let geometry = 'Linear';
    let idealAngle = '180°';
    let vseprCode = `AX${centralBonds.length}E${centralLonePairs}`;

    if (centralBonds.length <= 1) {
      geometry = 'Linear (Diatômica)';
      idealAngle = '180°';
    } else if (stericNumber === 2) {
      geometry = 'Linear';
      idealAngle = '180°';
    } else if (stericNumber === 3) {
      if (centralLonePairs === 0) { geometry = 'Trigonal Plana'; idealAngle = '120°'; }
      else { geometry = 'Angular'; idealAngle = '≈ 117.5°'; }
    } else if (stericNumber === 4) {
      if (centralLonePairs === 0) { geometry = 'Tetraédrica'; idealAngle = '109.5°'; }
      else if (centralLonePairs === 1) { geometry = 'Piramidal Trigonal'; idealAngle = '≈ 107°'; }
      else { geometry = 'Angular'; idealAngle = '≈ 104.5°'; }
    } else if (stericNumber === 5) {
      if (centralLonePairs === 0) { geometry = 'Bipiramidal Trigonal'; idealAngle = '90° / 120°'; }
      else if (centralLonePairs === 1) { geometry = 'Gangorra (See-saw)'; idealAngle = '≈ 90° / 117°'; }
      else if (centralLonePairs === 2) { geometry = 'Forma de T'; idealAngle = '≈ 90°'; }
      else { geometry = 'Linear'; idealAngle = '180°'; }
    } else if (stericNumber === 6) {
      if (centralLonePairs === 0) { geometry = 'Octaédrica'; idealAngle = '90°'; }
      else if (centralLonePairs === 1) { geometry = 'Piramidal Quadrada'; idealAngle = '≈ 90°'; }
      else { geometry = 'Quadrada Plana'; idealAngle = '90°'; }
    } else {
      geometry = 'Complexa / Hipervalente';
      idealAngle = 'Variável';
    }

    const observations = [];
    let hasRadical = false;
    let hasExpandedOctet = false;
    let hasNobleGas = false;

    atoms.forEach((a, i) => {
      const bCount = bonds.reduce((sum, b) => (b.atom1Index === i || b.atom2Index === i ? sum + b.order : sum), 0);
      const val = VALENCE_ELECTRONS[a.element] ?? 4;
      const unshared = Math.max(0, val - bCount);
      if (unshared % 2 !== 0) hasRadical = true;
      if (['He', 'Ne', 'Ar', 'Kr', 'Xe', 'Rn'].includes(a.element)) hasNobleGas = true;
      if (['P', 'S', 'Cl', 'Br', 'I', 'Xe'].includes(a.element) && bCount > 4) hasExpandedOctet = true;
    });

    if (bondAnalysis.some(b => b.isHydrogenBondDonor)) {
      observations.push('💧 <strong>Pontes de Hidrogênio:</strong> A presença de ligações H-F, H-O ou H-N confere alta atração intermolecular por pontes de hidrogênio (elevando o ponto de ebulição).');
    }

    if (hasNobleGas) {
      observations.push('⚠️ <strong>Gás Nobre Detectado:</strong> Gases nobres possuem camada de valência completa ($ns^2 np^6$) e raramente formam ligações covalentes estáveis sem agentes oxidantes extremos.');
    }

    if (hasRadical) {
      observations.push('⚡ <strong>Espécie Radicalar / Elétron Desemparelhado:</strong> A molécula possui elétrons desemparelhados na camada de valência, conferindo alto paramagnetismo e reatividade.');
    }

    if (hasExpandedOctet) {
      observations.push('🔮 <strong>Octeto Expandido (Hipervalência):</strong> Elementos a partir do 3º período utilizam orbitais d vazios para acomodar mais de 8 elétrons na camada de valência.');
    }

    const ionicCount = bondAnalysis.filter(b => b.classification === 'Iônica').length;
    const polarCount = bondAnalysis.filter(b => b.classification === 'Covalente Polar').length;
    const apolarCount = bondAnalysis.filter(b => b.classification === 'Covalente Apolar').length;

    if (ionicCount > 0 && (polarCount + apolarCount === 0)) {
      observations.push('🧂 <strong>Caráter Reticular Iônico:</strong> Predomínio de ligações iônicas. Em condições ambiente, forma retículo cristalino sólido de alto ponto de fusão.');
    } else if (polarCount > 0) {
      observations.push('🧲 <strong>Polaridade de Ligações:</strong> Ligações covalentes polares geram vetores momento de dipolo (\\vec{\\mu}). A polaridade total dependerá da simetria espacial.');
    } else if (apolarCount > 0 && bonds.length > 0) {
      observations.push('🌐 <strong>Caráter Covalente Apolar:</strong> Compartilhamento equitativo de densidade eletrônica entre átomos com eletronegatividades próximas.');
    }

    return {
      bondAnalysis,
      centralAtom: centralAtom?.element,
      centralIdx,
      stericNumber,
      centralLonePairs,
      vseprCode,
      geometry,
      idealAngle,
      observations
    };
  }
};

// =================================================================
// 1e. ELEMENT & ISOTOPE BUILDER ENGINE
// =================================================================
const ElementBuilderEngine = {
  getSystematicIupac(Z) {
    const roots = {
      0: 'nil', 1: 'un', 2: 'bi', 3: 'tri', 4: 'quad',
      5: 'pent', 6: 'hex', 7: 'sept', 8: 'oct', 9: 'enn'
    };
    const digits = String(Z).split('').map(Number);
    let name = digits.map(d => roots[d]).join('');
    if (name.endsWith('i')) name = name.slice(0, -1);
    name += 'ium';
    const symbol = digits.map((d, i) => (i === 0 ? roots[d][0].toUpperCase() : roots[d][0])).join('');
    const capName = name.charAt(0).toUpperCase() + name.slice(1);
    return { name: capName, symbol };
  },

  getAufbauConfiguration(Z) {
    const subshells = [
      { name: '1s', n: 1, cap: 2 },
      { name: '2s', n: 2, cap: 2 },
      { name: '2p', n: 2, cap: 6 },
      { name: '3s', n: 3, cap: 2 },
      { name: '3p', n: 3, cap: 6 },
      { name: '4s', n: 4, cap: 2 },
      { name: '3d', n: 3, cap: 10 },
      { name: '4p', n: 4, cap: 6 },
      { name: '5s', n: 5, cap: 2 },
      { name: '4d', n: 4, cap: 10 },
      { name: '5p', n: 5, cap: 6 },
      { name: '6s', n: 6, cap: 2 },
      { name: '4f', n: 4, cap: 14 },
      { name: '5d', n: 5, cap: 10 },
      { name: '6p', n: 6, cap: 6 },
      { name: '7s', n: 7, cap: 2 },
      { name: '5f', n: 5, cap: 14 },
      { name: '6d', n: 6, cap: 10 },
      { name: '7p', n: 7, cap: 6 },
      { name: '8s', n: 8, cap: 2 },
      { name: '5g', n: 5, cap: 18 },
      { name: '6f', n: 6, cap: 14 },
      { name: '7d', n: 7, cap: 10 },
      { name: '8p', n: 8, cap: 6 },
    ];

    let rem = Z;
    const parts = [];
    let maxN = 1;
    let lastBlock = 's';

    for (const sub of subshells) {
      if (rem <= 0) break;
      const count = Math.min(rem, sub.cap);
      rem -= count;
      parts.push(`${sub.name}${count}`);
      if (sub.n > maxN) maxN = sub.n;
      lastBlock = sub.name[1];
    }

    return {
      full: parts.join(' '),
      period: maxN,
      block: lastBlock,
      subshells: parts
    };
  },

  analyzeNucleus(Z, N, E) {
    const A = Z + N;
    const nzRatio = Z > 0 ? N / Z : 0;
    const netCharge = Z - E;
    const magicZ = [2, 8, 20, 28, 50, 82, 114, 126];
    const magicN = [2, 8, 20, 28, 50, 82, 126, 184];

    const isMagicZ = magicZ.includes(Z);
    const isMagicN = magicN.includes(N);
    const isDoublyMagic = isMagicZ && isMagicN;

    let stabilityClass = 'Estável';
    let decayMode = 'Nenhum (Nuclídeo Estável)';
    let halfLife = 'Estável (> 10²⁴ anos)';
    let islandProximity = 'Fora da região superpesada';

    if (Z > 110) {
      const distZ = Math.abs(Z - 120);
      const distN = Math.abs(N - 184);
      const score = Math.max(0, 100 - (distZ * 8 + distN * 4));
      islandProximity = `Proximidade da Ilha de Estabilidade: ${score}% (Centro previsto: Z=120/126, N=184)`;
    }

    const idealN = Z < 20 ? Z : Z * (1 + 0.006 * Z);
    if (Z <= 82 && Math.abs(N - idealN) <= (Z < 20 ? 1 : 4) && !(Z === 43 || Z === 61)) {
      stabilityClass = 'Estável (Cinturão de Estabilidade)';
      decayMode = 'Nenhum';
      halfLife = 'Estável';
    } else if (Z > 82) {
      stabilityClass = 'Radioativo (Instável - Superpesado/Actinídeo)';
      if (Z >= 104) {
        decayMode = (N / Z < 1.4) ? 'Emissão Alfa (α) / Fissão Espontânea' : 'Fissão Espontânea / Emissão Alfa';
        halfLife = (Z > 118) ? 'Microsegundos a Milissegundos (Teórico)' : 'Milissegundos a Segundos';
      } else {
        decayMode = (N / Z > 1.55) ? 'Decaimento Beta Negativo (β⁻)' : 'Emissão Alfa (α)';
        halfLife = 'Minutos a Bilhões de Anos';
      }
    } else {
      stabilityClass = 'Radioativo (Isótopo Instável)';
      if (N > idealN) {
        decayMode = 'Decaimento Beta Negativo (β⁻): n → p + e⁻ + ν̄_e';
      } else {
        decayMode = 'Decaimento Beta Positivo (β⁺) ou Captura Eletrônica: p → n + e⁺ + ν_e';
      }
      halfLife = 'Segundos a Milhares de Anos';
    }

    return {
      A,
      nzRatio: nzRatio.toFixed(3),
      netCharge,
      stabilityClass,
      decayMode,
      halfLife,
      isDoublyMagic,
      isMagicZ,
      isMagicN,
      islandProximity
    };
  }
};

// =================================================================
// 2. DASHBOARD MANAGER
// =================================================================
// Dictionary lookup for JS-generated text (reports, dynamic titles) — falls
// back to the Portuguese default when the key/language is missing.
const chemT = (key, fallback) => {
  const lang = localStorage.getItem('app-language') || 'pt';
  return window.TRANSLATIONS?.[lang]?.[key] || fallback;
};

const DashboardManager = {
  currentTab: 'explorer',
  elementsCache: [],
  elementsBySymbol: {},
  selectedSymbol: 'Fe',

  async init() {
    this.bindEvents();
    
    // Load elements catalog and render Periodic Table
    await this.loadPeriodicTable();
    
    // Select default element (Iron)
    this.selectElement('Fe');
  },

  bindEvents() {
    // Top Tabs switcher
    document.querySelectorAll('.chem-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        this.setTab(tab);
      });
    });

    // Explorer Search
    document.getElementById('search-btn').addEventListener('click', () => {
      const q = document.getElementById('element-search').value.trim();
      if (q) this.selectElement(q);
    });

    // Opens the wide periodic-table panel (full grid, no cramped scrolling)
    document.getElementById('btn-open-periodic-table')?.addEventListener('click', () => {
      this.openPeriodicTablePanel(false);
    });

    // Opens the same wide panel in "builder" layout (table + molecule bench)
    document.getElementById('btn-open-molecule-builder')?.addEventListener('click', () => {
      this.openPeriodicTablePanel(true);
    });

    // The FAB carries data-panel="periodic", so base.html's generic handler
    // owns open/close. This listener only picks the explorer-vs-builder layout,
    // which the generic handler knows nothing about.
    //
    // It must not open the panel itself. It used to call
    // openPeriodicTablePanel() behind a stopImmediatePropagation(), on the
    // premise that this code parsed before base.html's script and so ran first.
    // That was true while it was an inline <script>; as a deferred ES module it
    // binds inside its own DOMContentLoaded, which fires *after* the listener
    // base.html registered during parsing. So base's toggle ran first and
    // stopImmediatePropagation — which only suppresses listeners registered
    // later on the same element — could not stop it. The result was a FAB that
    // opened the panel but could never close it: base closed, this reopened.
    document.getElementById('fab-periodic-table')?.addEventListener('click', () => {
      const builderActive = this.currentTab === 'simulator'
        && document.getElementById('view-custom-molecule')?.style.display !== 'none';
      this.applyPeriodicPanelLayout(builderActive);
    });

    document.getElementById('element-search')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const q = document.getElementById('element-search').value.trim();
        if (q) this.selectElement(q);
      }
    });

    // Simulator Buttons
    document.getElementById('synthesize-btn').addEventListener('click', () => {
      const formula = document.getElementById('compound-select').value;
      this.runSimulation('bond', formula, '');
    });

    document.getElementById('react-btn').addEventListener('click', () => {
      const rxnId = document.getElementById('reaction-select').value;
      this.runSimulation('reaction', '', rxnId);
    });

    // Stoichiometry engine
    document.getElementById('stoich-btn').addEventListener('click', () => {
      const formula = document.getElementById('stoich-formula').value.trim();
      if (formula) this.runStoichiometry(formula);
    });
    document.getElementById('stoich-formula').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const formula = e.target.value.trim();
        if (formula) this.runStoichiometry(formula);
      }
    });

    // Custom Molecule Builder toggles
    const btnModePreset = document.getElementById('btn-mode-preset');
    const btnModeCustom = document.getElementById('btn-mode-custom');
    const viewPreset = document.getElementById('view-preset-molecule');
    const viewCustom = document.getElementById('view-custom-molecule');

    if (btnModePreset && btnModeCustom && viewPreset && viewCustom) {
      const tableFab = document.getElementById('fab-periodic-table');
      btnModePreset.addEventListener('click', () => {
        btnModePreset.classList.add('chem-mode-tab-btn--active');
        btnModeCustom.classList.remove('chem-mode-tab-btn--active');
        viewPreset.style.display = 'block';
        viewCustom.style.display = 'none';
        if (tableFab) tableFab.style.display = 'none';
      });

      btnModeCustom.addEventListener('click', () => {
        btnModeCustom.classList.add('chem-mode-tab-btn--active');
        btnModePreset.classList.remove('chem-mode-tab-btn--active');
        viewPreset.style.display = 'none';
        viewCustom.style.display = 'block';
        if (tableFab) tableFab.style.display = 'flex';
      });
    }

    // Clear Custom button (lives inside the molecule builder bench)
    document.getElementById('btn-clear-custom')?.addEventListener('click', () => {
      MoleculeBuilder.clearAll();
      showToast('Molécula personalizada limpa.', 'info');
    });

    // Simulate Custom button
    document.getElementById('btn-simulate-custom')?.addEventListener('click', () => {
      if (customAtoms.length === 0) {
        showToast('Adicione pelo menos um átomo para simular.', 'error');
        return;
      }
      this.runCustomSimulation();
    });

    // Element Builder Controls
    const pSlider = document.getElementById('slider-builder-protons');
    const nSlider = document.getElementById('slider-builder-neutrons');
    const eSlider = document.getElementById('slider-builder-electrons');

    const updateSliderVals = () => {
      if (pSlider) document.getElementById('val-builder-protons').textContent = pSlider.value;
      if (nSlider) document.getElementById('val-builder-neutrons').textContent = nSlider.value;
      if (eSlider) document.getElementById('val-builder-electrons').textContent = eSlider.value;
    };

    [pSlider, nSlider, eSlider].forEach(slider => {
      slider?.addEventListener('input', () => {
        updateSliderVals();
        const presetSelect = document.getElementById('builder-preset-select');
        if (presetSelect) presetSelect.value = 'custom';
      });
    });

    // Neutralize button (e- = Z)
    document.getElementById('btn-builder-neutral')?.addEventListener('click', () => {
      if (pSlider && eSlider) {
        eSlider.value = pSlider.value;
        updateSliderVals();
      }
    });

    // Preset selector
    document.getElementById('builder-preset-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      const presets = {
        'H-1': { Z: 1, N: 0, E: 1 },
        'H-2': { Z: 1, N: 1, E: 1 },
        'H-3': { Z: 1, N: 2, E: 1 },
        'He-4': { Z: 2, N: 2, E: 2 },
        'C-12': { Z: 6, N: 6, E: 6 },
        'C-14': { Z: 6, N: 8, E: 6 },
        'Fe-56': { Z: 26, N: 30, E: 26 },
        'U-235': { Z: 92, N: 143, E: 92 },
        'Og-294': { Z: 118, N: 176, E: 118 },
        'Uue-315': { Z: 119, N: 196, E: 119 },
        'Ubn-320': { Z: 120, N: 200, E: 120 },
        'Island-126': { Z: 126, N: 184, E: 126 },
      };
      if (presets[val]) {
        const p = presets[val];
        if (pSlider) pSlider.value = p.Z;
        if (nSlider) nSlider.value = p.N;
        if (eSlider) eSlider.value = p.E;
        updateSliderVals();
        this.constructCustomElement(p.Z, p.N, p.E);
      }
    });

    // Construct Element button
    document.getElementById('btn-builder-construct')?.addEventListener('click', () => {
      const Z = parseInt(pSlider?.value || '26', 10);
      const N = parseInt(nSlider?.value || '30', 10);
      const E = parseInt(eSlider?.value || '26', 10);
      this.constructCustomElement(Z, N, E);
    });
  },

  // Opens the wide periodic-table panel in either layout: plain table
  // (Explorer — click a cell to inspect it) or table + molecule-building
  // bench (Simulator's "Criador Dinâmico" — drag elements onto the canvas).
  /**
   * Switch the periodic panel between explorer and builder layout.
   * Does not change whether the panel is open — see openPeriodicTablePanel.
   */
  applyPeriodicPanelLayout(builder) {
    const panel = document.getElementById('periodic-panel');
    panel?.classList.toggle('periodic-panel--builder', !!builder);

    const bench = document.getElementById('molecule-builder');
    if (bench) bench.style.display = builder ? 'flex' : 'none';

    const title = document.getElementById('periodic-panel-title');
    if (title) {
      title.textContent = builder
        ? chemT('chem-panel-builder', '🧪 Tabela Periódica — Bancada de Montagem')
        : chemT('chem-panel-periodic', '🧪 Tabela Periódica dos Elementos Químicos');
    }

    if (builder) MoleculeBuilder.renderAll();
  },

  /** Apply a layout and open the panel. For the explicit "open" buttons. */
  openPeriodicTablePanel(builder) {
    this.applyPeriodicPanelLayout(builder);
    window.FloatingPanel?.open('periodic');
  },

  setTab(tab) {
    if (this.currentTab === tab) return;
    this.currentTab = tab;

    document.querySelectorAll('.chem-tab-btn').forEach(b => b.classList.remove('chem-tab-btn--active'));
    document.querySelector(`.chem-tab-btn[data-tab="${tab}"]`).classList.add('chem-tab-btn--active');

    // Show/hide sections
    const explorerPanels = document.getElementById('panel-explorer');
    const simulatorPanels = document.getElementById('panel-simulator');
    const elBuilderPanels = document.getElementById('panel-element-builder');
    const tableCard = document.getElementById('periodic-table-card');
    const tableFab = document.getElementById('fab-periodic-table');
    const extraCard = document.getElementById('extra-analysis-card');

    if (extraCard) extraCard.style.display = 'none';

    if (tab === 'explorer') {
      explorerPanels.style.display = 'block';
      simulatorPanels.style.display = 'none';
      if (elBuilderPanels) elBuilderPanels.style.display = 'none';
      tableCard.style.display = 'block';
      if (tableFab) tableFab.style.display = 'flex';

      this.renderHeaders();

      // Select selected elements back
      this.selectElement(this.selectedSymbol);

    } else if (tab === 'simulator') {
      explorerPanels.style.display = 'none';
      simulatorPanels.style.display = 'block';
      if (elBuilderPanels) elBuilderPanels.style.display = 'none';
      tableCard.style.display = 'none';
      if (tableFab) tableFab.style.display = 'none';
      window.FloatingPanel?.close('periodic');

      this.renderHeaders();

      // Trigger default compound simulation
      document.getElementById('synthesize-btn').click();

    } else if (tab === 'element-builder') {
      explorerPanels.style.display = 'none';
      simulatorPanels.style.display = 'none';
      if (elBuilderPanels) elBuilderPanels.style.display = 'block';
      tableCard.style.display = 'none';
      if (tableFab) tableFab.style.display = 'none';
      window.FloatingPanel?.close('periodic');

      this.renderHeaders();

      const pSlider = document.getElementById('slider-builder-protons');
      const nSlider = document.getElementById('slider-builder-neutrons');
      const eSlider = document.getElementById('slider-builder-electrons');
      const Z = parseInt(pSlider?.value || '26', 10);
      const N = parseInt(nSlider?.value || '30', 10);
      const E = parseInt(eSlider?.value || '26', 10);
      this.constructCustomElement(Z, N, E);
    }
  },

  // Renders the page header, workbench header and 3D legend for the current
  // tab in the active language.
  renderHeaders() {
    if (this.currentTab === 'explorer') {
      document.getElementById('page-title').innerHTML = chemT('chem-title-explorer', 'Tabela Periódica Interativa');
      document.getElementById('page-desc').innerHTML = chemT('chem-desc-explorer', 'Explore as características físicas e químicas de todos os 118 elementos com simulação atômica de Bohr.');
      document.getElementById('workbench-title').innerHTML = chemT('chem-wb-title-explorer', '🌀 Banco de Átomos de Bohr 3D');
      document.getElementById('workbench-desc').innerHTML = chemT('chem-wb-desc-explorer', 'Órbitas eletrônicas concêntricas animadas em Three.js');

      document.getElementById('three-legend').innerHTML = `
        <span style="color:#ef4444">${chemT('chem-legend-proton', '● Próton')}</span>
        <span style="color:#3b82f6">${chemT('chem-legend-neutron', '● Nêutron')}</span>
        <span style="color:#8b5cf6">${chemT('chem-legend-electron', '● Elétron')}</span>
      `;
    } else if (this.currentTab === 'simulator') {
      document.getElementById('page-title').innerHTML = chemT('chem-title-simulator', 'Simulador de Ligações & Reações Químicas');
      document.getElementById('page-desc').innerHTML = chemT('chem-desc-simulator', 'Sintetize moléculas ou execute reações dinâmicas. Analise produtos, massas e ligações.');
      document.getElementById('workbench-title').innerHTML = chemT('chem-wb-title-simulator', '🧪 Visualizador Molecular 3D');
      document.getElementById('workbench-desc').innerHTML = chemT('chem-wb-desc-simulator', 'Modelo molecular tridimensional (Ball-and-Stick)');

      document.getElementById('three-legend').innerHTML = `
        <span style="color:#ef4444">${chemT('chem-legend-oxygen', '● Oxigênio')}</span>
        <span style="color:#cbd5e1">${chemT('chem-legend-carbon', '● Carbono / Outros')}</span>
        <span style="color:#ffffff">${chemT('chem-legend-hydrogen', '● Hidrogênio')}</span>
        <span style="color:#10b981">${chemT('chem-legend-halogens', '● Halogênios')}</span>
      `;
    } else if (this.currentTab === 'element-builder') {
      document.getElementById('page-title').innerHTML = '🔬 Construtor de Novo Elemento &amp; Isótopos';
      document.getElementById('page-desc').innerHTML = 'Crie nuclídeos e novos elementos hipotéticos (Z &gt; 118). Analise estabilidade nuclear e nomenclatura IUPAC sistemática.';
      document.getElementById('workbench-title').innerHTML = '🌀 Modelo Atômico Quântico de Bohr';
      document.getElementById('workbench-desc').innerHTML = 'Distribuição eletrônica de Aufbau e núcleo isotópico em tempo real';

      document.getElementById('three-legend').innerHTML = `
        <span style="color:#ef4444">● Próton (Z)</span>
        <span style="color:#3b82f6">● Nêutron (N)</span>
        <span style="color:#8b5cf6">● Elétron (e⁻)</span>
      `;
    }
  },

  async loadPeriodicTable() {
    try {
      this.elementsCache = await chemistryAPI.getElements();
      this.elementsBySymbol = {};
      this.elementsCache.forEach(el => { this.elementsBySymbol[el.symbol] = el; });
      this.renderPeriodicTable(this.elementsCache);
    } catch (e) {
      console.error(e);
      showToast('Erro ao carregar a tabela periódica.', 'error');
    }
  },

  renderPeriodicTable(elements) {
    const grid = document.getElementById('periodic-table-grid');
    grid.innerHTML = '';

    // Create 118 element cells mapped by row & col
    elements.forEach(el => {
      const cell = document.createElement('div');
      cell.className = 'periodic-element-cell';
      cell.dataset.symbol = el.symbol;

      const pos = this.getGridPosition(el);
      cell.style.gridRow = pos.row;
      cell.style.gridColumn = pos.col;

      // Color coding based on category
      const cat = el.category || 'unknown';
      cell.style.backgroundColor = categoryColors[cat] || categoryColors['unknown'];
      cell.style.borderColor = categoryBorders[cat] || categoryBorders['unknown'];

      cell.innerHTML = `
        <span class="periodic-element-cell__number">${el.number}</span>
        <span class="periodic-element-cell__symbol">${el.symbol}</span>
        <span class="periodic-element-cell__name">${el.name}</span>
      `;

      cell.addEventListener('click', () => this.selectElement(el.symbol));

      // Draggable everywhere (harmless in Explorer mode — the molecule
      // canvas drop target only exists/renders in the builder layout).
      cell.draggable = true;
      cell.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', el.symbol);
        e.dataTransfer.effectAllowed = 'copy';
      });
      grid.appendChild(cell);
    });

    // Draw spacer placeholders for Lanthanides/Actinides row references
    const lanthSpacer = document.createElement('div');
    lanthSpacer.className = 'periodic-table__spacer';
    lanthSpacer.style.gridRow = 6;
    lanthSpacer.style.gridColumn = 3;
    lanthSpacer.textContent = '57-71';
    grid.appendChild(lanthSpacer);

    const actSpacer = document.createElement('div');
    actSpacer.className = 'periodic-table__spacer';
    actSpacer.style.gridRow = 7;
    actSpacer.style.gridColumn = 3;
    actSpacer.textContent = '89-103';
    grid.appendChild(actSpacer);
  },

  getGridPosition(el) {
    let row = el.period;
    let col = el.group;

    // Handle Lanthanides
    if (el.number >= 57 && el.number <= 71) {
      row = 9;
      col = el.number - 57 + 3;
    }
    // Handle Actinides
    else if (el.number >= 89 && el.number <= 103) {
      row = 10;
      col = el.number - 89 + 3;
    }
    return { row, col };
  },

  async selectElement(symbol) {
    showLoading(`Carregando elemento ${symbol}…`);
    try {
      const el = await chemistryAPI.getElement(symbol);

      this.selectedSymbol = el.symbol;

      // Active state on Table cell
      document.querySelectorAll('.periodic-element-cell').forEach(cell => {
        cell.classList.toggle('periodic-element-cell--active', cell.dataset.symbol.toUpperCase() === el.symbol.toUpperCase());
      });

      this.updateExplorerUI(el);
      ThreeAtom.buildAtom(el.atomic_number, el.electron_configuration);
      window.FloatingPanel?.markUpdated('results');

      // Picking an element from the wide periodic-table panel closes it,
      // so the freshly-selected 3D atom is immediately visible.
      if (document.getElementById('periodic-panel')?.classList.contains('is-open')) {
        window.FloatingPanel?.close('periodic');
      }
    } catch (e) {
      console.error(e);
      showToast(`Elemento ${symbol} não encontrado.`, 'error');
    } finally {
      hideLoading();
    }
  },

  updateExplorerUI(el) {
    document.getElementById('element-value').textContent = `${el.name} (${el.symbol})`;
    document.getElementById('number-value').textContent = el.atomic_number;
    document.getElementById('workbench-status').textContent = `${el.symbol} (Z=${el.atomic_number})`;

    // KPI Cards
    document.getElementById('kpi-lbl-1').textContent = chemT('chem-kpi-symbol', 'Símbolo');
    document.getElementById('prop-symbol').textContent = el.symbol;
    document.getElementById('prop-name').textContent = el.name;

    document.getElementById('kpi-lbl-2').textContent = chemT('chem-kpi-z', 'Número Atômico');
    document.getElementById('prop-z').textContent = el.atomic_number;
    document.getElementById('kpi-unit-2').textContent = chemT('chem-unit-protons', 'prótons');

    document.getElementById('kpi-lbl-3').textContent = chemT('chem-kpi-mass', 'Massa Atômica');
    document.getElementById('prop-mass').textContent = el.atomic_mass.toFixed(4);
    document.getElementById('kpi-unit-3').textContent = chemT('chem-unit-amu', 'u (unidade de massa atômica)');

    document.getElementById('table-title').textContent = chemT('chem-tbl-element', '📋 Características do Elemento');

    // Build standard properties rows
    document.getElementById('results-table-body').innerHTML = `
      <tr><td>${chemT('chem-row-period', 'Período')}</td><td>${el.period}</td></tr>
      <tr><td>${chemT('chem-row-group', 'Grupo')}</td><td>${el.group || 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-config', 'Conf. Eletrônica')}</td><td style="font-family:var(--font-mono); font-size:0.75rem;">${el.electron_configuration || 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-electroneg', 'Eletronegatividade')}</td><td>${el.electronegativity ? el.electronegativity.toFixed(2) : 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-radius', 'Raio Covalente')}</td><td>${el.atomic_radius_pm ? el.atomic_radius_pm + ' pm' : 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-ionization', 'Energia de Ionização')}</td><td>${el.ionisation_energy_ev ? el.ionisation_energy_ev.toFixed(3) + ' eV' : 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-density', 'Densidade')}</td><td>${el.density_g_cm3 ? el.density_g_cm3.toExponential(3) + ' g/cm³' : 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-melting', 'Ponto de Fusão')}</td><td>${el.melting_point_k ? el.melting_point_k.toFixed(1) + ' K' : 'N/A'}</td></tr>
      <tr><td>${chemT('chem-row-boiling', 'Ponto de Ebulição')}</td><td>${el.boiling_point_k ? el.boiling_point_k.toFixed(1) + ' K' : 'N/A'}</td></tr>
      <tr class="results-table__highlight"><td>${chemT('chem-row-oxidation', 'Estados de Oxidação')}</td><td>${el.oxidation_states?.length ? el.oxidation_states.join(', ') : 'N/A'}</td></tr>
    `;
  },

  async runSimulation(mode, formula, rxnId) {
    showLoading('Simulando ligação química e massas…');
    try {
      const data = await chemistryAPI.simulate({ mode, formula, reaction_id: rxnId });

      this.updateSimulatorUI(data, mode);
      ThreeAtom.buildMolecule(data.atoms || data.product_atoms);
      window.FloatingPanel?.markUpdated('results');
    } catch (e) {
      console.error(e);
      showToast(describeApiError(e, 'Erro ao simular ligação química.'), 'error');
    } finally {
      hideLoading();
    }
  },

  async runStoichiometry(formula) {
    const resultEl = document.getElementById('stoich-result');
    resultEl.innerHTML = '<span style="color:var(--text-muted)">Calculando…</span>';
    try {
      const data = await chemistryAPI.stoichiometry(formula);

      const rows = data.composition.map(c => `
        <tr>
          <td>${c.element} × ${c.count}</td>
          <td>${c.atomic_mass.toFixed(3)} u</td>
          <td>${c.mass_percent.toFixed(2)}%</td>
        </tr>
      `).join('');

      resultEl.innerHTML = `
        <div style="font-weight:700; color:var(--accent-primary); margin-bottom:8px;">
          M = ${data.molar_mass_g_mol.toFixed(3)} g/mol
        </div>
        <table class="results-table" aria-label="Composição elementar">
          <thead><tr><th>Elemento</th><th>Massa Atômica</th><th>% Massa</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;

      this.visualizeStoichiometry(data);
    } catch (e) {
      console.error(e);
      const msg = e?.errors?.formula?.[0] || e?.message || 'Fórmula inválida.';
      resultEl.innerHTML = `<span style="color:var(--accent-danger)">${msg}</span>`;
    }
  },

  // Renders the parsed formula's atoms as a "composition cloud" in the
  // shared 3D viewer — no bond topology is known for an arbitrary formula
  // (that would require real structural input, out of scope), so atoms are
  // spread apart by pure repulsion (bonds=[]) rather than drawn connected.
  visualizeStoichiometry(data) {
    const atoms = [];
    data.composition.forEach(c => {
      const listEntry = this.elementsBySymbol[c.element];
      const color = getElementDisplayColor(c.element, listEntry?.category);
      const radius = getElementDisplayRadius(null); // generic radius — this is a schematic cloud, not a scale model
      for (let i = 0; i < c.count; i++) {
        atoms.push({ element: c.element, mass: c.atomic_mass, color, radius, x: 0, y: 0, z: 0 });
      }
    });
    if (!atoms.length) return;

    relaxAtomPositions(atoms, []);
    ThreeAtom.buildMolecule(atoms, []);

    document.getElementById('workbench-title').textContent = `${chemT('chem-wb-stoich-title', '🧮 Nuvem de Composição:')} ${data.formula}`;
    document.getElementById('workbench-desc').textContent =
      chemT('chem-wb-stoich-desc', 'Elementos na proporção da fórmula — sem topologia de ligação real (posições apenas ilustrativas)');
    document.getElementById('workbench-status').textContent = `M = ${data.molar_mass_g_mol.toFixed(2)} g/mol`;
    document.getElementById('element-value').textContent = data.formula;
    document.getElementById('number-value').textContent = 'Estq.';

    document.getElementById('kpi-lbl-1').textContent = chemT('chem-kpi-formula', 'Fórmula');
    document.getElementById('prop-symbol').textContent = data.formula;
    document.getElementById('prop-name').textContent = `${atoms.length} ${chemT('chem-word-atoms', 'átomos')}`;

    document.getElementById('kpi-lbl-2').textContent = chemT('chem-kpi-distinct', 'Elementos Distintos');
    document.getElementById('prop-z').textContent = String(data.composition.length);
    document.getElementById('kpi-unit-2').textContent = chemT('chem-unit-species', 'espécies');

    document.getElementById('kpi-lbl-3').textContent = chemT('chem-kpi-molar', 'Massa Molar');
    document.getElementById('prop-mass').textContent = data.molar_mass_g_mol.toFixed(3);
    document.getElementById('kpi-unit-3').textContent = 'g/mol (u)';

    document.getElementById('table-title').textContent = chemT('chem-tbl-stoich', '📋 Composição Elementar (Estequiometria)');
    document.getElementById('results-table-body').innerHTML = data.composition.map(c => `
      <tr><td>${c.element} (× ${c.count})</td><td>${(c.atomic_mass * c.count).toFixed(3)} u — ${c.mass_percent.toFixed(2)}%</td></tr>
    `).join('') + `<tr class="results-table__highlight"><td>${chemT('chem-row-molar-total', 'Massa Molar Total')}</td><td>${data.molar_mass_g_mol.toFixed(4)} g/mol</td></tr>`;

    window.FloatingPanel?.markUpdated('results');
  },

  updateSimulatorUI(data, mode) {
    if (mode === 'bond') {
      document.getElementById('element-value').textContent = data.name;
      document.getElementById('number-value').textContent = 'Fórm.';
      document.getElementById('workbench-status').textContent = data.formula;

      // KPIs
      document.getElementById('kpi-lbl-1').textContent = chemT('chem-kpi-formula', 'Fórmula');
      document.getElementById('prop-symbol').textContent = data.formula;
      document.getElementById('prop-name').textContent = data.name;

      document.getElementById('kpi-lbl-2').textContent = chemT('chem-kpi-bondtype', 'Tipo de Ligação');
      document.getElementById('prop-z').textContent = data.bond_type;
      document.getElementById('kpi-unit-2').textContent = chemT('chem-unit-interaction', 'interação atômica');

      document.getElementById('kpi-lbl-3').textContent = chemT('chem-kpi-molmass', 'Massa Molecular');
      document.getElementById('prop-mass').textContent = data.mass.toFixed(3);
      document.getElementById('kpi-unit-3').textContent = 'g/mol (u)';

      document.getElementById('table-title').textContent = chemT('chem-tbl-bond', '📋 Relatório de Ligação Química');

      document.getElementById('results-table-body').innerHTML = `
        <tr><td>${chemT('chem-row-compound', 'Nome do Composto')}</td><td>${data.name}</td></tr>
        <tr><td>${chemT('chem-row-formula', 'Fórmula Estequiométrica')}</td><td><strong>${data.formula}</strong></td></tr>
        <tr><td>${chemT('chem-row-avgmass', 'Massa Molar Média')}</td><td>${data.mass.toFixed(4)} u</td></tr>
        <tr><td>${chemT('chem-row-bondtype-strong', 'Tipo de Ligação Forte')}</td><td style="color:var(--accent-primary); font-weight:600;">${data.bond_type}</td></tr>
        <tr><td>${chemT('chem-row-strong', 'Ligações Fortes (Intra)')}</td><td>${data.strong_bonds}</td></tr>
        <tr><td>${chemT('chem-row-weak', 'Ligações Fracas (Inter)')}</td><td>${data.weak_bonds}</td></tr>
        <tr class="results-table__highlight"><td>${chemT('chem-row-nox', 'Eletrovalência (Nox)')}</td><td>${data.electrovalency}</td></tr>
      `;

    } else if (mode === 'reaction') {
      document.getElementById('element-value').textContent = data.title;
      document.getElementById('number-value').textContent = 'Reac.';
      document.getElementById('workbench-status').textContent = data.product_formula;

      // KPIs
      document.getElementById('kpi-lbl-1').textContent = chemT('chem-kpi-product', 'Produto Molar');
      document.getElementById('prop-symbol').textContent = data.product_formula;
      document.getElementById('prop-name').textContent = data.product_name;

      document.getElementById('kpi-lbl-2').textContent = chemT('chem-kpi-byproduct', 'Subproduto');
      document.getElementById('prop-z').textContent = data.byproduct_formula;
      document.getElementById('kpi-unit-2').textContent = data.byproduct_name;

      document.getElementById('kpi-lbl-3').textContent = chemT('chem-kpi-prodmass', 'Massa do Produto Principal');
      document.getElementById('prop-mass').textContent = data.product_mass.toFixed(3);
      document.getElementById('kpi-unit-3').textContent = 'g/mol (u)';

      document.getElementById('table-title').textContent = chemT('chem-tbl-reaction', '📋 Relatório de Reação Estequiométrica');

      document.getElementById('results-table-body').innerHTML = `
        <tr><td>${chemT('chem-row-equation', 'Equação Balanceada')}</td><td><code style="color:var(--accent-info);">${data.equation}</code></td></tr>
        <tr><td>${chemT('chem-row-reactants', 'Reagentes Alimentados')}</td><td>${data.reactants}</td></tr>
        <tr><td>${chemT('chem-row-product', 'Produto Principal')}</td><td><strong>${data.product_name}</strong> (${data.product_mass.toFixed(3)} u)</td></tr>
        <tr><td>${chemT('chem-row-byproduct', 'Subproduto Obtido')}</td><td><strong>${data.byproduct_name}</strong> (${data.byproduct_mass.toFixed(3)} u)</td></tr>
        <tr><td>${chemT('chem-row-prod-bonds', 'Ligações no Produto')}</td><td>${data.product_strong}</td></tr>
        <tr><td>${chemT('chem-row-byprod-bonds', 'Ligações no Subproduto')}</td><td>${data.byproduct_strong}</td></tr>
        <tr><td>${chemT('chem-row-nox', 'Eletrovalência (Nox)')}</td><td>${data.product_electrovalency}</td></tr>
      `;
    }
  },

  removeCustomAtom(idx) {
    customAtoms.splice(idx, 1);
    customBonds = customBonds
      .filter(b => b.atom1Index !== idx && b.atom2Index !== idx)
      .map(b => ({
        atom1Index: b.atom1Index > idx ? b.atom1Index - 1 : b.atom1Index,
        atom2Index: b.atom2Index > idx ? b.atom2Index - 1 : b.atom2Index,
        order: b.order
      }));
  },

  runCustomSimulation() {
    showLoading('Simulando forças atômicas tridimensionais…');
    try {
      this._runCustomSimulation();
    } catch (e) {
      console.error(e);
      showToast('Falha ao simular a molécula. Verifique os átomos na bancada.', 'error');
    } finally {
      hideLoading();
    }
  },

  _runCustomSimulation() {
    relaxAtomPositions(customAtoms, customBonds);
    ThreeAtom.buildMolecule(customAtoms, customBonds);

    if (document.getElementById('periodic-panel')?.classList.contains('is-open')) {
      window.FloatingPanel?.close('periodic');
    }
    window.FloatingPanel?.markUpdated('results');

    // Formula & Counts
    const counts = {};
    customAtoms.forEach(a => { counts[a.element] = (counts[a.element] || 0) + 1; });
    const formula = this.getHillFormula(customAtoms);
    const empirical = IUPACNomenclature.getEmpiricalFormula(counts);
    const totalMass = customAtoms.reduce((sum, a) => sum + a.mass, 0);

    // Known Molecule lookup or generated systematic nomenclature
    const known = IUPACNomenclature.knownMolecules[formula];
    const compName = known ? known.name : IUPACNomenclature.generateSystematicName(customAtoms, counts, customBonds);
    const iupacName = known ? known.iupac : IUPACNomenclature.generateSystematicName(customAtoms, counts, customBonds);

    // Advanced Feasibility & Geometry Analysis
    const analysis = BondFeasibilityAnalyzer.analyze(customAtoms, customBonds);

    let bondTypesText = "Nenhuma ligação";
    if (analysis && analysis.bondAnalysis.length > 0) {
      const countsByType = {};
      analysis.bondAnalysis.forEach(b => {
        countsByType[b.classification] = (countsByType[b.classification] || 0) + 1;
      });
      bondTypesText = Object.entries(countsByType).map(([k, v]) => `${v}x ${k}`).join(', ');
    }

    const orderNames = { 1: 'Simples', 2: 'Dupla', 3: 'Tríplice' };
    const bondsDescription = customBonds.map(b => {
      const a1 = customAtoms[b.atom1Index];
      const a2 = customAtoms[b.atom2Index];
      return `${a1.element}-${a2.element} (${orderNames[b.order]})`;
    }).join(', ') || 'Nenhuma';

    // Warnings on valence
    const warnings = [];
    customAtoms.forEach((atom, idx) => {
      const bondCount = bondCountFor(idx, customBonds);
      const limit = valenceLimitFor(atom.element);
      if (bondCount > limit) {
        warnings.push(`⚠️ Alerta: Átomo <strong>${atom.element}#${idx}</strong> possui ${bondCount} ligações (máx recomendado: ${limit})!`);
      }
    });

    let warningHtml = "";
    if (warnings.length > 0) {
      warningHtml = `
        <tr style="background: rgba(239, 68, 68, 0.08); border-top: 1px solid rgba(239, 68, 68, 0.25);">
          <td colspan="2" style="color: #f87171; font-size: 0.72rem; line-height: 1.4; padding: 10px 14px; white-space: normal;">
            ${warnings.join('<br>')}
          </td>
        </tr>
      `;
    }

    // Update UI elements
    document.getElementById('element-value').textContent = compName;
    document.getElementById('number-value').textContent = 'Cust.';
    document.getElementById('workbench-status').textContent = formula;

    // KPIs
    document.getElementById('kpi-lbl-1').textContent = chemT('chem-kpi-genformula', 'Fórmula Gerada');
    document.getElementById('prop-symbol').textContent = formula;
    document.getElementById('prop-name').textContent = compName;

    document.getElementById('kpi-lbl-2').textContent = chemT('chem-kpi-bondstrength', 'Geometria Molecular');
    document.getElementById('prop-z').textContent = analysis ? analysis.geometry : 'Livre';
    document.getElementById('kpi-unit-2').textContent = analysis ? `Ângulo: ${analysis.idealAngle}` : 'indefinida';

    document.getElementById('kpi-lbl-3').textContent = chemT('chem-kpi-molar', 'Massa Molar');
    document.getElementById('prop-mass').textContent = totalMass.toFixed(3);
    document.getElementById('kpi-unit-3').textContent = 'g/mol (u)';

    document.getElementById('table-title').textContent = chemT('chem-tbl-custom', '📋 Relatório de Síntese & Nomenclatura');

    document.getElementById('results-table-body').innerHTML = `
      <tr><td>${chemT('chem-row-compound', 'Nome Identificado')}</td><td><strong>${compName}</strong></td></tr>
      <tr><td>Nomenclatura IUPAC</td><td style="color:var(--accent-primary); font-weight:600;">${iupacName}</td></tr>
      <tr><td>${chemT('chem-row-hill', 'Fórmula Molecular (Hill)')}</td><td><strong>${formula}</strong></td></tr>
      <tr><td>Fórmula Mínima (Empírica)</td><td>${empirical}</td></tr>
      <tr><td>${chemT('chem-row-calcmass', 'Massa Molar Calculada')}</td><td>${totalMass.toFixed(4)} u</td></tr>
      <tr><td>${chemT('chem-row-bondcomp', 'Tipos de Ligação')}</td><td>${bondTypesText}</td></tr>
      <tr><td>Geometria VSEPR (Átomo Central: ${analysis?.centralAtom || '—'})</td><td><strong>${analysis?.geometry || '—'}</strong> (${analysis?.idealAngle || '—'}) [${analysis?.vseprCode || '—'}]</td></tr>
      <tr><td>${chemT('chem-row-connections', 'Conexões Registradas')}</td><td>${bondsDescription}</td></tr>
      <tr class="results-table__highlight"><td>${chemT('chem-row-pauling', 'Eletronegatividades (Pauling)')}</td><td>${customAtoms.map((a, i) => `${a.element}#${i} (EN=${a.electronegativity != null ? a.electronegativity.toFixed(2) : '—'})`).join(', ')}</td></tr>
      ${warningHtml}
    `;

    // Extra analysis card: Detailed Feasibility Observations
    const extraCard = document.getElementById('extra-analysis-card');
    const extraContent = document.getElementById('extra-analysis-content');
    if (extraCard && extraContent && analysis) {
      extraCard.style.display = 'block';
      let bondDetailsHtml = '';
      if (analysis.bondAnalysis.length) {
        bondDetailsHtml = `
          <div style="margin-bottom:10px;">
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">📊 Análise Físico-Química de Cada Ligação:</div>
            <table class="results-table" style="font-size:0.7rem;">
              <thead>
                <tr><th>Ligação</th><th>ΔEN</th><th>% Iônico (Pauling)</th><th>Classificação</th></tr>
              </thead>
              <tbody>
                ${analysis.bondAnalysis.map(b => `
                  <tr>
                    <td>${b.atom1}#${b.idx1} — ${b.atom2}#${b.idx2}</td>
                    <td>${b.deltaEN != null ? b.deltaEN.toFixed(2) : 'N/A'}</td>
                    <td>${b.ionicPercent != null ? b.ionicPercent.toFixed(1) + '%' : 'N/A'}</td>
                    <td><span class="regime-tag" style="font-size:0.6rem;">${b.classification}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      let obsHtml = '';
      if (analysis.observations.length) {
        obsHtml = `
          <div style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">🔍 Observações Científicas e Diagnóstico de Estabilidade:</div>
          <ul style="padding-left:16px; margin:0; display:flex; flex-direction:column; gap:6px;">
            ${analysis.observations.map(obs => `<li>${obs}</li>`).join('')}
          </ul>
        `;
      } else {
        obsHtml = `<div>✅ <strong>Configuração Estável:</strong> Sem anomalias ou tensões eletrônicas detectadas para esta estrutura.</div>`;
      }

      extraContent.innerHTML = bondDetailsHtml + obsHtml;
    }

    showToast('Simulação molecular e análise IUPAC concluídas!', 'success');
  },

  constructCustomElement(Z, N, E) {
    showLoading(`Sintetizando átomo Z=${Z}, N=${N}, E=${E}…`);
    try {
      const A = Z + N;
      const systematic = ElementBuilderEngine.getSystematicIupac(Z);
      const aufbau = ElementBuilderEngine.getAufbauConfiguration(E);
      const nuc = ElementBuilderEngine.analyzeNucleus(Z, N, E);

      const knownEl = (this.elementsCache || []).find(el => el.number === Z);
      const displayName = knownEl ? `${knownEl.name} (Isótopo A=${A})` : `${systematic.name} (Superpesado Z=${Z})`;
      const displaySymbol = knownEl ? `${knownEl.symbol}-${A}` : systematic.symbol;

      document.getElementById('element-value').textContent = displayName;
      document.getElementById('number-value').textContent = `Z=${Z}`;
      document.getElementById('workbench-status').textContent = `${displaySymbol} (A=${A})`;

      // KPI Cards
      document.getElementById('kpi-lbl-1').textContent = 'Símbolo & Nuclídeo';
      document.getElementById('prop-symbol').textContent = displaySymbol;
      document.getElementById('prop-name').textContent = displayName;

      document.getElementById('kpi-lbl-2').textContent = 'Número Atômico (Z)';
      document.getElementById('prop-z').textContent = String(Z);
      document.getElementById('kpi-unit-2').textContent = `${N} nêutrons | ${E} e⁻`;

      document.getElementById('kpi-lbl-3').textContent = 'Número de Massa (A)';
      document.getElementById('prop-mass').textContent = String(A);
      document.getElementById('kpi-unit-3').textContent = `u (Carga líquida: ${nuc.netCharge >= 0 ? '+' : ''}${nuc.netCharge})`;

      document.getElementById('table-title').textContent = '📋 Propriedades Quânticas e Nucleares';

      document.getElementById('results-table-body').innerHTML = `
        <tr><td>Nome Sistemático IUPAC</td><td><strong>${systematic.name}</strong> (${systematic.symbol})</td></tr>
        <tr><td>Número Atômico (Prótons Z)</td><td>${Z}</td></tr>
        <tr><td>Número de Nêutrons (N)</td><td>${N}</td></tr>
        <tr><td>Número de Elétrons (E)</td><td>${E} (Íon: ${nuc.netCharge >= 0 ? '+' : ''}${nuc.netCharge})</td></tr>
        <tr><td>Razão Nêutron/Próton (N/Z)</td><td><strong>${nuc.nzRatio}</strong></td></tr>
        <tr><td>Distribuição Eletrônica (Aufbau)</td><td style="font-family:var(--font-mono); font-size:0.72rem;">${aufbau.full || 'Nenhum elétron (Núcleo desnudo)'}</td></tr>
        <tr><td>Período / Bloco Quântico</td><td>Período ${aufbau.period} · Bloco [${aufbau.block.toUpperCase()}]</td></tr>
        <tr><td>Classificação de Estabilidade</td><td style="color:${nuc.stabilityClass.includes('Estável') ? 'var(--accent-success)' : 'var(--accent-warning)'}; font-weight:600;">${nuc.stabilityClass}</td></tr>
        <tr><td>Modo de Decaimento Provável</td><td>${nuc.decayMode}</td></tr>
        <tr class="results-table__highlight"><td>Meia-Vida Estimada</td><td>${nuc.halfLife}</td></tr>
      `;

      const extraCard = document.getElementById('extra-analysis-card');
      const extraContent = document.getElementById('extra-analysis-content');
      if (extraCard && extraContent) {
        extraCard.style.display = 'block';
        extraContent.innerHTML = `
          <div style="margin-bottom:8px; font-weight:600; color:var(--text-primary);">⚛️ Análise de Estrutura Nuclear &amp; Teoria:</div>
          <p>• <strong>Núcleo Duplamente Mágico:</strong> ${nuc.isDoublyMagic ? '🌟 Sim! Tanto prótons quanto nêutrons completam camadas fechadas.' : (nuc.isMagicZ || nuc.isMagicN ? 'Camada fechada parcial (Z ou N mágico).' : 'Não possui número mágico fechado.')}</p>
          <p style="margin-top:6px;">• <strong>${nuc.islandProximity}</strong></p>
          <p style="margin-top:6px;">• <strong>Nomenclatura Sistemática IUPAC:</strong> Baseada nos dígitos numéricos latinos/gregos oficiais. Cada algarismo de Z (${String(Z).split('').join(', ')}) traduz-se no prefixo sistemático.</p>
        `;
      }

      // Render 3D Bohr Atom
      ThreeAtom.buildAtom(Z, aufbau.full, E, N);
      window.FloatingPanel?.markUpdated('results');
      showToast(`Átomo ${displayName} construído com sucesso!`, 'success');
    } catch (e) {
      console.error(e);
      showToast('Erro ao sintetizar o elemento.', 'error');
    } finally {
      hideLoading();
    }
  },

  getHillFormula(atoms) {
    const counts = {};
    atoms.forEach(a => { counts[a.element] = (counts[a.element] || 0) + 1; });
    let formula = "";
    if (counts["C"]) {
      formula += "C" + (counts["C"] > 1 ? counts["C"] : "");
      delete counts["C"];
      if (counts["H"]) {
        formula += "H" + (counts["H"] > 1 ? counts["H"] : "");
        delete counts["H"];
      }
    }
    const keys = Object.keys(counts).sort();
    keys.forEach(k => { formula += k + (counts[k] > 1 ? counts[k] : ""); });
    return formula || "Molécula";
  }
};

// =================================================================
// 3. THREE.JS ATOM & MOLECULE RENDERER
// =================================================================
const ThreeAtom = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  nucleus: null,
  electronGroup: null,
  moleculeGroup: null,
  shells: [],
  targetCameraPos: null,
  // Filled in by init(). Constructing a THREE.Vector3 at module-evaluation time
  // would throw before the `typeof THREE === 'undefined'` guard below could
  // run, taking the periodic table and the whole page down with the viewport.
  targetLookAt: null,
  transitioning: false,
  autoOrbit: false,
  currentMode: 'atom', // 'atom' or 'molecule'
  loop: null,
  camSliders: null, // cached in init(); renderFrame() syncs these every frame

  init() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas || typeof THREE === 'undefined') return;

    this.targetLookAt = new THREE.Vector3(0, 0, 0);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050b18);

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    this.camera.position.set(0, 3, 6);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // updateStyle=false: let the stylesheet own the canvas box. The default
    // (true) writes width/height in px onto the canvas, overriding the CSS and
    // freezing the viewport at its first-load size, because onResize() then
    // measures the pixel value it just pinned.
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    if (typeof THREE.OrbitControls !== 'undefined') {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 1;
      this.controls.maxDistance = 15;
    }

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const pointLight = new THREE.PointLight(0xffffff, 1.0);
    pointLight.position.set(5, 5, 5);
    this.scene.add(pointLight);

    const orbitCheckbox = document.getElementById('auto-orbit');
    orbitCheckbox?.addEventListener('change', (e) => {
      this.autoOrbit = e.target.checked;
      if (this.autoOrbit) {
        this.transitioning = false;
        this.targetCameraPos = null;
      }
    });

    const triggerPreset = (x, y, z) => {
      this.targetCameraPos = new THREE.Vector3(x, y, z);
      this.transitioning = true;
      this.autoOrbit = false;
      if (orbitCheckbox) orbitCheckbox.checked = false;
    };

    document.getElementById('btn-view-iso')?.addEventListener('click', () => triggerPreset(3.5, 3.0, 4.0));
    document.getElementById('btn-view-side')?.addEventListener('click', () => triggerPreset(0, 0, 6));
    document.getElementById('btn-view-top')?.addEventListener('click', () => triggerPreset(0, 6.0, 0.01));
    document.getElementById('btn-view-inlet')?.addEventListener('click', () => triggerPreset(-6.0, 0, 0));

    // XYZ sliders. Resolved once and cached: renderFrame() syncs them from the
    // camera every frame, and re-querying six ids at 60 fps is pure waste.
    this.camSliders = {
      x: document.getElementById('cam-slider-x'),
      y: document.getElementById('cam-slider-y'),
      z: document.getElementById('cam-slider-z'),
      valX: document.getElementById('cam-val-x'),
      valY: document.getElementById('cam-val-y'),
      valZ: document.getElementById('cam-val-z'),
    };

    // Dragging a slider is a manual camera move: it cancels auto-orbit and any
    // in-flight preset transition, matching the other four pages. The sync in
    // renderFrame() skips whichever slider has focus so it cannot fight the
    // user mid-drag.
    const onSliderInput = () => {
      const { x, y, z } = this.camSliders;
      if (!x || !y || !z) return;
      this.autoOrbit = false;
      this.transitioning = false;
      this.targetCameraPos = null;
      if (orbitCheckbox) orbitCheckbox.checked = false;
      this.camera.position.set(
        parseFloat(x.value), parseFloat(y.value), parseFloat(z.value),
      );
      this.camera.lookAt(0, 0, 0);
      if (this.controls) this.controls.target.set(0, 0, 0);
    };
    [this.camSliders.x, this.camSliders.y, this.camSliders.z].forEach(
      slider => slider?.addEventListener('input', onSliderInput),
    );

    // Hover tooltip: raycast against the molecule's atom spheres (only
    // meaningful in molecule mode — a single Bohr atom has nothing discrete
    // to label individually) and show element data already in memory, no
    // extra API call needed.
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerleave', () => window.ThreeTooltip?.hide());

    // Dynamic anim loop
    // Owns its rAF handle so the loop can be stopped, and parks itself while
    // the tab is hidden.
    this.loop = createAnimationLoop(() => this.renderFrame());
    this.loop.start();

    window.addEventListener('resize', () => this.onResize());
  },

  onPointerMove(e) {
    if (this.currentMode !== 'molecule' || !this.moleculeAtoms?.length) {
      window.ThreeTooltip?.hide();
      return;
    }
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this.moleculeAtoms.map(a => a.mesh);
    const hits = this.raycaster.intersectObjects(meshes);

    if (hits.length > 0) {
      const atom = this.moleculeAtoms.find(a => a.mesh === hits[0].object);
      if (atom) {
        const el = DashboardManager.elementsBySymbol?.[atom.element];
        const html = `<strong>${el?.name || atom.element}</strong> (${atom.element})<br>`
          + (el ? `Z = ${el.number} &middot; ${el.mass?.toFixed(2)} u` : '');
        window.ThreeTooltip?.show(html, e.clientX, e.clientY);
        return;
      }
    }
    window.ThreeTooltip?.hide();
  },

  // Removing a group from the scene stops it being rendered, but its
  // geometries/materials/textures stay allocated on the GPU until
  // explicitly disposed. Without this, every element/molecule switch
  // (buildAtom/buildMolecule always create fresh geometries — one orbit
  // ring + material per electron, one cylinder per bond, etc.) leaks GPU
  // memory, and a session that browses many elements eventually stalls
  // or freezes the WebGL context.
  //
  // This was the only correct disposal in the codebase; it now lives in
  // modules/shared/three-utils.js so the other four scenes use it too, with
  // texture disposal added (material.dispose() does not reach textures).
  clear() {
    if (this.nucleus) { this.scene.remove(this.nucleus); disposeObject3D(this.nucleus); }
    if (this.electronGroup) { this.scene.remove(this.electronGroup); disposeObject3D(this.electronGroup); }
    if (this.moleculeGroup) { this.scene.remove(this.moleculeGroup); disposeObject3D(this.moleculeGroup); }

    this.nucleus = null;
    this.electronGroup = null;
    this.moleculeGroup = null;
    this.shells = [];
    this.moleculeAtoms = [];
    this.moleculeBonds = [];
  },

  /**
   * Converts an electron configuration string (e.g. "[Ar] 3d6 4s2") into
   * electron counts per principal shell n: {1: 2, 2: 8, 3: 8, 4: 2, ...}.
   * Expands noble-gas-core shorthand first. Returns null if unparseable.
   */
  parseShellCounts(configStr) {
    if (!configStr) return null;
    const NOBLE_GAS_CORES = {
      He: '1s2',
      Ne: '1s2 2s2 2p6',
      Ar: '1s2 2s2 2p6 3s2 3p6',
      Kr: '1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6',
      Xe: '1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6 4d10 5s2 5p6',
      Rn: '1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6 4d10 5s2 5p6 4f14 5d10 6s2 6p6',
    };
    let expanded = configStr.trim();
    const coreMatch = expanded.match(/^\[(\w+)\]\s*/);
    let prefix = '';
    if (coreMatch) {
      prefix = (NOBLE_GAS_CORES[coreMatch[1]] || '') + ' ';
      expanded = expanded.slice(coreMatch[0].length);
    }
    const shellCounts = {};
    let matchedAny = false;
    (prefix + expanded).trim().split(/\s+/).forEach(token => {
      const m = token.match(/^(\d+)[spdfg](\d+)$/);
      if (!m) return;
      matchedAny = true;
      const n = parseInt(m[1], 10);
      shellCounts[n] = (shellCounts[n] || 0) + parseInt(m[2], 10);
    });
    return matchedAny ? shellCounts : null;
  },

  buildAtom(Z, electronConfig, numElectrons = null, numNeutrons = null) {
    this.clear();
    this.currentMode = 'atom';

    this.nucleus = new THREE.Group();
    this.electronGroup = new THREE.Group();
    this.scene.add(this.nucleus);
    this.scene.add(this.electronGroup);

    // 1. Nucleus Cluster (Protons & Neutrons)
    const nProtons = Math.max(1, Z || 1);
    const nNeutrons = numNeutrons != null ? numNeutrons : Math.round(nProtons * 1.2);
    const numPToDraw = Math.min(nProtons, 22);
    const numNToDraw = Math.min(nNeutrons, 22);
    const totalParticles = numPToDraw + numNToDraw;

    const protonGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const protonMat = new THREE.MeshPhongMaterial({ color: 0xef4444, shininess: 85 });
    const neutronGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const neutronMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, shininess: 85 });

    for (let i = 0; i < totalParticles; i++) {
      const isProton = i < numPToDraw;
      const sphere = new THREE.Mesh(isProton ? protonGeo : neutronGeo, isProton ? protonMat : neutronMat);
      
      const r = 0.22 * Math.pow(Math.random(), 1/3);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      
      sphere.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
      this.nucleus.add(sphere);
    }

    // 2. Electron Concentric Shells
    const parsedShells = this.parseShellCounts(electronConfig);
    let shellSizes;
    if (parsedShells) {
      const keys = Object.keys(parsedShells).map(Number);
      const maxN = keys.length ? Math.max(...keys) : 0;
      shellSizes = [];
      for (let n = 1; n <= maxN; n++) shellSizes.push(parsedShells[n] || 0);
    } else {
      shellSizes = [2, 8, 18, 32, 18, 8, 2];
    }
    let remainingElectrons = numElectrons != null ? numElectrons : Z;
    const baseRadius = 0.6;
    const radiusStep = 0.35;

    const electronGeo = new THREE.SphereGeometry(0.045, 16, 16);
    const electronMat = new THREE.MeshPhongMaterial({ color: 0x8b5cf6, emissive: 0x5a1a9f, shininess: 100 });

    for (let s = 0; s < shellSizes.length; s++) {
      if (remainingElectrons <= 0) break;
      const electronsInShell = Math.min(remainingElectrons, shellSizes[s]);
      remainingElectrons -= electronsInShell;

      const radius = baseRadius + s * radiusStep;
      const shellElectrons = [];
      
      for (let e = 0; e < electronsInShell; e++) {
        // Unique inclinations per electron to form a 3D spherical cloud
        const tiltX = (Math.random() - 0.5) * Math.PI * 0.7;
        const tiltY = (Math.random() - 0.5) * Math.PI * 0.7;
        const tiltZ = (Math.random() - 0.5) * Math.PI * 0.7;

        // Draw individual orbit ring
        const segments = 64;
        const orbitGeo = new THREE.BufferGeometry();
        const points = [];
        for (let i = 0; i <= segments; i++) {
          const theta = (i / segments) * Math.PI * 2;
          points.push(radius * Math.cos(theta), 0, radius * Math.sin(theta));
        }
        orbitGeo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        const orbitMat = new THREE.LineBasicMaterial({ 
          color: 0x8b5cf6, 
          transparent: true, 
          opacity: 0.12 
        });
        const orbit = new THREE.Line(orbitGeo, orbitMat);
        orbit.rotation.set(tiltX, tiltY, tiltZ);
        this.electronGroup.add(orbit);

        const electron = new THREE.Mesh(electronGeo, electronMat);
        this.electronGroup.add(electron);
        
        shellElectrons.push({
          mesh: electron,
          angle: (e / electronsInShell) * Math.PI * 2,
          radius: radius,
          tiltX: tiltX,
          tiltY: tiltY,
          tiltZ: tiltZ,
          speed: 2.0 / (s + 1)
        });
      }
      this.shells.push(shellElectrons);
    }
  },

  buildMolecule(atoms, bonds) {
    this.clear();
    this.currentMode = 'molecule';

    this.moleculeGroup = new THREE.Group();
    this.scene.add(this.moleculeGroup);

    if (!atoms || atoms.length === 0) return;

    this.moleculeAtoms = [];
    this.moleculeBonds = [];

    // 1. Draw atoms spheres
    atoms.forEach(atom => {
      const geo = new THREE.SphereGeometry(atom.radius * 1.5, 32, 32);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(atom.color),
        emissive: new THREE.Color(atom.color).multiplyScalar(0.12),
        shininess: 95
      });
      const mesh = new THREE.Mesh(geo, mat);
      const bx = atom.x * 2.0;
      const by = atom.y * 2.0;
      const bz = atom.z * 2.0;
      mesh.position.set(bx, by, bz);
      this.moleculeGroup.add(mesh);
      
      this.moleculeAtoms.push({
        mesh: mesh,
        element: atom.element,
        baseX: bx,
        baseY: by,
        baseZ: bz,
        phase: Math.random() * Math.PI * 2
      });
    });

    const drawStick = (idx1, idx2, offsetVec) => {
      const a1 = this.moleculeAtoms[idx1];
      const a2 = this.moleculeAtoms[idx2];
      if (!a1 || !a2) return;
      const p1 = a1.mesh.position;
      const p2 = a2.mesh.position;

      const start = p1.clone();
      const end = p2.clone();
      if (offsetVec) {
        start.add(offsetVec);
        end.add(offsetVec);
      }
      const direction = new THREE.Vector3().subVectors(end, start);
      const length = direction.length();

      const geom = new THREE.CylinderGeometry(0.04, 0.04, length, 16);
      // CylinderGeometry is built along local +Y; translate so it spans
      // from the origin to +Y*length, then align that +Y axis directly
      // with the real bond direction via a quaternion (avoids the -Z
      // convention of Object3D.lookAt, which previously left the stick
      // pointing away from the target atom instead of towards it).
      geom.translate(0, length / 2, 0);

      const mat = new THREE.MeshPhongMaterial({ color: 0x94a3b8, shininess: 60 });
      const cylinder = new THREE.Mesh(geom, mat);

      cylinder.position.copy(start);
      cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());

      this.moleculeGroup.add(cylinder);

      this.moleculeBonds.push({
        mesh: cylinder,
        atom1: a1,
        atom2: a2,
        initialLength: length,
        offsetVec: offsetVec
      });
    };

    // 2. Draw bonds (explicit connection maps or fallback proximity)
    if (bonds && bonds.length > 0) {
      bonds.forEach(bond => {
        const a1 = this.moleculeAtoms[bond.atom1Index];
        const a2 = this.moleculeAtoms[bond.atom2Index];
        if (!a1 || !a2) return;
        const p1 = a1.mesh.position;
        const p2 = a2.mesh.position;
        const order = parseInt(bond.order) || 1;

        if (order === 1) {
          drawStick(bond.atom1Index, bond.atom2Index, null);
        } else if (order === 2) {
          const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
          const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const perp = new THREE.Vector3().crossVectors(dir, ref).normalize().multiplyScalar(0.08);

          drawStick(bond.atom1Index, bond.atom2Index, perp);
          drawStick(bond.atom1Index, bond.atom2Index, perp.clone().negate());
        } else if (order === 3) {
          const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
          const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const perp = new THREE.Vector3().crossVectors(dir, ref).normalize().multiplyScalar(0.1);

          drawStick(bond.atom1Index, bond.atom2Index, null);
          drawStick(bond.atom1Index, bond.atom2Index, perp);
          drawStick(bond.atom1Index, bond.atom2Index, perp.clone().negate());
        }
      });
    } else {
      const maxBondDist = 2.9;
      for (let i = 0; i < this.moleculeAtoms.length; i++) {
        for (let j = i + 1; j < this.moleculeAtoms.length; j++) {
          const a1 = this.moleculeAtoms[i];
          const a2 = this.moleculeAtoms[j];
          const p1 = a1.mesh.position;
          const p2 = a2.mesh.position;
          const dist = p1.distanceTo(p2);

          if (dist < maxBondDist) {
            drawStick(i, j, null);
          }
        }
      }
    }
  },

  renderFrame() {
    if (!this.renderer) return;

    if (this.autoOrbit) {
      const time = Date.now() * 0.0004;
      const radius = 6.0;
      this.camera.position.x = radius * Math.cos(time);
      this.camera.position.z = radius * Math.sin(time);
      this.camera.position.y = 3.0 + 1.0 * Math.sin(time * 0.5);
      this.camera.lookAt(0, 0, 0);
    }

    if (this.controls) this.controls.update();

    // Orbit camera Preset lerping
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

    // Animation specific to mode
    if (this.currentMode === 'atom') {
      const time = Date.now() * 0.001;

      if (this.nucleus) {
        this.nucleus.rotation.y += 0.005;
        this.nucleus.rotation.x += 0.002;
      }

      this.shells.forEach(shell => {
        shell.forEach(e => {
          const currentAngle = e.angle + e.speed * time;
          const localX = e.radius * Math.cos(currentAngle);
          const localZ = e.radius * Math.sin(currentAngle);
          
          const pos = new THREE.Vector3(localX, 0, localZ);
          pos.applyAxisAngle(new THREE.Vector3(1, 0, 0), e.tiltX);
          pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), e.tiltY);
          pos.applyAxisAngle(new THREE.Vector3(0, 0, 1), e.tiltZ);
          
          e.mesh.position.copy(pos);
        });
      });
    } else if (this.currentMode === 'molecule' && this.moleculeGroup) {
      // Rotate the molecule slowly in space
      this.moleculeGroup.rotation.y += 0.006;
      this.moleculeGroup.rotation.x += 0.002;

      // Micro-thermal vibrations
      const t = Date.now() * 0.015;
      if (this.moleculeAtoms) {
        this.moleculeAtoms.forEach(atom => {
          const amp = 0.02;
          const dx = amp * Math.sin(t + atom.phase);
          const dy = amp * Math.cos(t * 1.3 + atom.phase);
          const dz = amp * Math.sin(t * 0.8 + atom.phase);
          atom.mesh.position.set(atom.baseX + dx, atom.baseY + dy, atom.baseZ + dz);
        });
      }

      // Update connection cylinders
      if (this.moleculeBonds) {
        this.moleculeBonds.forEach(bond => {
          const p1 = bond.atom1.mesh.position;
          const p2 = bond.atom2.mesh.position;

          const start = p1.clone();
          const end = p2.clone();
          if (bond.offsetVec) {
            start.add(bond.offsetVec);
            end.add(bond.offsetVec);
          }

          const direction = new THREE.Vector3().subVectors(end, start);
          const length = direction.length();

          bond.mesh.position.copy(start);
          // Same quaternion-based alignment as the initial drawStick() build
          // (geometry's long axis is local +Y), and scale along Y to match.
          bond.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());

          const scaleY = length / bond.initialLength;
          bond.mesh.scale.set(1, scaleY, 1);
        });
      }
    }

    // Sync the sliders from the camera (cached in init — see camSliders).
    const cam = this.camSliders;
    if (cam?.x && cam.y && cam.z) {
      if (document.activeElement !== cam.x) {
        cam.x.value = this.camera.position.x;
        if (cam.valX) cam.valX.textContent = this.camera.position.x.toFixed(2);
      }
      if (document.activeElement !== cam.y) {
        cam.y.value = this.camera.position.y;
        if (cam.valY) cam.valY.textContent = this.camera.position.y.toFixed(2);
      }
      if (document.activeElement !== cam.z) {
        cam.z.value = this.camera.position.z;
        if (cam.valZ) cam.valZ.textContent = this.camera.position.z.toFixed(2);
      }
    }

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  },

  onResize() {
    resizeRendererToCanvas(
      this.renderer,
      this.camera,
      document.getElementById('three-canvas'),
    );
  }
};

// Bridge to the i18n block that stays inline in the template. That block has to
// remain inline to register its DOMContentLoaded listener before base.html's
// translatePage, but it re-renders the JS-built headers and re-runs setTab on a
// language change — both of which live here now. This is the one deliberate
// seam between the two scripts; nothing else crosses it.
window.DashboardManager = DashboardManager;

document.addEventListener('DOMContentLoaded', async () => {
  // DashboardManager.init() is async — it awaits the periodic table fetch.
  // Awaiting it here is what makes the retranslate() below meaningful: the
  // table's 118 element tiles are built inside that await, so a separately
  // registered retranslate listener used to run while the grid was still empty.
  await DashboardManager.init();
  ThreeAtom.init();
  MoleculeBuilder.init();

  // Re-apply translations once the controllers above have built their DOM. The
  // template's inline i18n block already merged this page's dictionary and ran
  // translatePage, but it did so before this module executed, so anything
  // rendered by init() still carries its default-language text.
  retranslate();
});
