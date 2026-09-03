/**
 * frontend/src/modules/shared/api.js
 * =====================================
 * Centralised Axios-based API client.
 *
 * All scientific module API calls go through this client to ensure:
 *   - Consistent CSRF header injection
 *   - Unified error handling
 *   - Base URL management
 */

import axios from 'axios';

// Read CSRF token from the meta tag set by Django's base template
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';

/**
 * Axios instance for all API calls.
 * Vite proxies /api/* to http://localhost:8000 (see vite.config.js).
 */
const apiClient = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRFToken': csrfToken,
  },
  timeout: 30_000,  // 30 seconds — complex calculations can take time
});

// Response interceptor — unwrap our {"status": "success", "data": ...} envelope
apiClient.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body?.status === 'success') {
      return body.data;
    }
    return body;
  },
  (error) => {
    const errorData = error.response?.data;
    console.error('[API Error]', errorData ?? error.message);
    return Promise.reject(errorData ?? error);
  },
);

// ----------------------------------------------------------------
// Module-specific API functions
// ----------------------------------------------------------------

// Every module exposes a `.../schema/` endpoint generated from its DRF
// serializer (see apps/core/schema.py), so a form can be built from the
// server's own constraints instead of hard-coding ranges in the template.

/** Fluids — Pipe Flow */
export const fluidsAPI = {
  /** Compute pipe flow analysis. @param {Object} params */
  async calculate(params, config) {
    return apiClient.post('/fluids/pipe-flow/calculate/', params, config);
  },
  /** Get input schema + fluid presets. */
  async getSchema() {
    return apiClient.get('/fluids/pipe-flow/schema/');
  },
};

/** Materials — Beam Deflection */
export const materialsAPI = {
  async beamDeflection(params, config) {
    return apiClient.post('/materials/beam-deflection/', params, config);
  },
  async getSchema() {
    return apiClient.get('/materials/beam-deflection/schema/');
  },
};

/** Chemistry — Elements, Bonding/Reactions, Stoichiometry */
export const chemistryAPI = {
  async getElements() {
    return apiClient.get('/chemistry/elements/');
  },
  async getElement(identifier) {
    return apiClient.get(`/chemistry/element/${identifier}/`);
  },
  async simulate(params) {
    return apiClient.post('/chemistry/simulate/', params);
  },
  async stoichiometry(formula) {
    return apiClient.post('/chemistry/stoichiometry/', { formula });
  },
  async getSchema() {
    return apiClient.get('/chemistry/simulate/schema/');
  },
  async getStoichiometrySchema() {
    return apiClient.get('/chemistry/stoichiometry/schema/');
  },
};

/** Physics — Projectile Motion and Magnetism / Motors */
export const physicsAPI = {
  async projectile(params, config) {
    return apiClient.post('/physics/projectile/calculate/', params, config);
  },
  async getProjectileSchema() {
    return apiClient.get('/physics/projectile/schema/');
  },
  async magnetism(params, config) {
    return apiClient.post('/physics/magnetism/calculate/', params, config);
  },
  async getMagnetismSchema() {
    return apiClient.get('/physics/magnetism/schema/');
  },
};

/** Tribology — Gear geometry and EHL lubrication */
export const tribologyAPI = {
  async calculate(params, config) {
    return apiClient.post('/tribology/calculate/', params, config);
  },
  async getSchema() {
    return apiClient.get('/tribology/schema/');
  },
};

export const biologyAPI = {
  analyzeDna(sequence) {
    return apiClient.post('/biology/dna/analyze/', { sequence });
  },
  getPresets() {
    return apiClient.get('/biology/dna/presets/');
  },
  getCellStructures() {
    return apiClient.get('/biology/cells/structures/');
  },
  simulateInfection(params) {
    return apiClient.post('/biology/infection/simulate/', params);
  },
};

/**
 * Serialise a rapid-fire endpoint so only the newest response is delivered.
 *
 * Every simulator form re-solves on a 350 ms debounce, so a burst of typing can
 * leave several POSTs in flight at once. Responses are not guaranteed to arrive
 * in the order they were sent, and each one overwrote the charts and the 3D
 * viewport on arrival — so a slow early request could land last and repaint the
 * page with results for parameters the user had already moved on from.
 *
 * The returned function aborts the previous call before starting a new one, and
 * rejects superseded calls with a marker this module's callers ignore.
 *
 * @param {(params: any, config: any) => Promise<any>} call
 * @returns {(params?: any) => Promise<any>}
 */
export function latestOnly(call) {
  let controller = null;
  return async (params) => {
    if (controller) controller.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      return await call(params, { signal: mine.signal });
    } finally {
      if (controller === mine) controller = null;
    }
  };
}

/** True when a rejection is just this request being superseded by a newer one. */
export function isSuperseded(err) {
  return err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError'
    || err?.name === 'AbortError';
}

/**
 * Turn a rejected API call into a sentence worth showing the user.
 *
 * The interceptor above rejects with the server's error envelope
 * (apps/core/responses.py): `{status, code, message, errors?}`, where `errors`
 * maps field name -> list of messages. Pages used to discard all of that and
 * show a fixed string like "Check input values", which told someone who got one
 * field wrong to re-check every field.
 *
 * @param {any} err — whatever the rejected promise carried
 * @param {string} fallback — used when the failure carries no server detail
 *                            (network down, timeout, CORS)
 * @returns {string}
 */
export function describeApiError(err, fallback = 'Request failed. Please try again.') {
  if (!err) return fallback;

  if (err.errors && typeof err.errors === 'object') {
    const parts = Object.entries(err.errors).map(([field, messages]) => {
      const first = Array.isArray(messages) ? messages[0] : messages;
      return `${field}: ${first}`;
    });
    if (parts.length) return parts.join(' · ');
  }

  return err.message || fallback;
}

export default apiClient;
