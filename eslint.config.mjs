/**
 * eslint.config.mjs
 * ==================
 * Flat config (ESLint 9). The project had no config file at all, so
 * `npm run lint` failed outright — and its `--ext .js` flag was removed in
 * ESLint 9 anyway.
 *
 * This exists mainly as a correctness net for the page controllers that moved
 * out of the Django templates and into frontend/src/pages/. Inside a template
 * every symbol shared the one global scope, so nothing was ever "undefined".
 * As ES modules they have real scope, and `no-undef` is what catches a
 * reference that used to resolve to a global and no longer does.
 *
 * Globals declared below are the ones base.html installs on window at runtime
 * (translation engine, floating panels, export helpers, MathJax from CDN).
 * They are genuinely global and intentionally not imported.
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['frontend/dist/**', 'node_modules/**', '**/vendor/**'],
  },
  js.configs.recommended,
  {
    files: ['frontend/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,

        // Installed on window by base.html's inline script
        TRANSLATIONS: 'readonly',
        translatePage: 'readonly',
        FloatingPanel: 'readonly',
        exportUtils: 'readonly',   // base.html installs window.exportUtils (lower-case e)
        ThreeTooltip: 'readonly',

        // MathJax is loaded from a CDN in base.html's <head>
        MathJax: 'readonly',

        // Vendored libraries loaded as classic <script> tags by the page
        // templates. Deliberately not npm imports — see vite.config.js.
        THREE: 'readonly',
        Plotly: 'readonly',

        // Server-rendered context injected by app_physics/index.html
        PHYSICS_ACTIVE_TAB_CONTEXT: 'readonly',
      },
    },
    rules: {
      // The point of this config: catch references that silently resolved to a
      // template-scope global before the port.
      'no-undef': 'error',

      // Ported code keeps its original shape; these would be pure noise.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
