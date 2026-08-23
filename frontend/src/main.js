/**
 * frontend/src/main.js
 * ======================
 * Vite entry point — global utilities published on window.
 * Page-specific logic lives in frontend/src/pages/*.js
 *
 * styles/dashboard.css is deliberately NOT imported. base.html carries the
 * complete stylesheet for the app (reset, design tokens, and every component
 * including the sidebar), and dashboard.css is an older duplicate of the same
 * design system whose token values had drifted (--sidebar-width 240px vs the
 * 250px base.html uses, --bg-base #0a0e1a vs #060814). Injecting it on every
 * page — which no page had ever loaded before — changed the layout. base.html
 * is the single source of truth for styling; this entry only ships behaviour.
 */

// Global utilities available on window (for Django template usage)
import { showToast, showLoading, hideLoading } from './modules/shared/utils.js';

window.showToast   = showToast;
window.showLoading = showLoading;
window.hideLoading = hideLoading;

console.log('[SciDash] Frontend bundle loaded.');
