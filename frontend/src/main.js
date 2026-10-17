/**
 * frontend/src/main.js
 * ======================
 * Vite entry point loaded by base.html on every page: the application
 * stylesheet and the page shell (floating panels, sidebar, focus mode, HUD,
 * export, tooltip), plus the toast/loading helpers published on window for
 * the page controllers in frontend/src/pages/*.js.
 *
 * Importing the stylesheet here is what puts it in a <link> in <head>: the
 * {% vite_asset 'main.js' %} tag emits the entry's CSS. It used to be a
 * <style> block at the end of <body>, applied after the scripts above it had
 * already laid the page out, so the sidebar margin animated in on every load.
 */

import './styles/app.css';
import './modules/shared/floating-panel.js';
import './modules/shared/shell.js';

// Global utilities available on window (for Django template usage)
import { showToast, showLoading, hideLoading } from './modules/shared/utils.js';

window.showToast   = showToast;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
