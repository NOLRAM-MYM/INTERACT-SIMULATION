// =============================================================================
// vite.config.js — Vite Build Configuration for Scientific Dashboard
// =============================================================================
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  // Root of frontend source files
  root: path.resolve(__dirname, 'frontend/src'),

  // No public/ directory in this project — every asset is either bundled or
  // served by Django from apps/*/static/. Pointing publicDir at a path that
  // does not exist makes Vite warn on each build.
  publicDir: false,

  // @vitejs/plugin-legacy was removed deliberately. It ran Babel + core-js over
  // every dependency — including plotly.js-dist (~3.5 MB) — to emit a second
  // nomodule bundle, which exhausted Node's 2 GB heap and made the build fail
  // outright. It also bought nothing: its own config said `not IE 11`, and
  // every remaining browser in this project's browserslist target has
  // supported ES modules since 2018. A WebGL + Plotly dashboard cannot run on
  // the pre-module browsers the plugin exists to serve.
  plugins: [],

  resolve: {
    alias: {
      // Convenient import alias: '@/modules/...' → 'frontend/src/modules/...'
      '@': path.resolve(__dirname, 'frontend/src'),
    },
  },

  build: {
    // Output goes into frontend/dist, which settings.base lists in
    // STATICFILES_DIRS — so `collectstatic` copies it into STATIC_ROOT.
    outDir: path.resolve(__dirname, 'frontend/dist'),
    emptyOutDir: true,

    // Generate a manifest.json so Django can reference hashed filenames
    manifest: true,

    rollupOptions: {
      input: {
        // One entry point per dashboard page
        main:      path.resolve(__dirname, 'frontend/src/main.js'),
        fluids:    path.resolve(__dirname, 'frontend/src/pages/fluids.js'),
        materials: path.resolve(__dirname, 'frontend/src/pages/materials.js'),
        chemistry: path.resolve(__dirname, 'frontend/src/pages/chemistry.js'),
        tribology: path.resolve(__dirname, 'frontend/src/pages/tribology.js'),
        physics:   path.resolve(__dirname, 'frontend/src/pages/physics.js'),
      },
      output: {
        // Clean, readable chunk names
        chunkFileNames: 'js/[name]-[hash].js',
        entryFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',

        // No manualChunks is configured: three and plotly are never imported,
        // so there is nothing heavy to split out. The pages read both from the
        // globals installed by the vendored <script> tags in the templates —
        // the vendored three is r128 (2021) and is not interchangeable with the
        // 0.166 npm resolves to. The bundles therefore hold application code
        // and axios only.
      },
    },

    // esbuild rather than terser: terser minifying plotly twice (modern +
    // legacy bundle) needs >2 GB of heap and killed the build. esbuild is an
    // order of magnitude leaner and the only terser option set here
    // (drop_console: false) was already the default behaviour.
    minify: 'esbuild',

    chunkSizeWarningLimit: 4000,

    // Source maps for debugging
    sourcemap: process.env.NODE_ENV !== 'production',
  },

  server: {
    // Vite dev server port — Django runs on 8000, Vite on 5173
    port: 5173,
    strictPort: true,

    // Proxy API calls to Django backend during development
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
      '/static': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },

  css: {
    // Enable PostCSS (autoprefixer configured in postcss.config.js)
    postcss: path.resolve(__dirname, 'postcss.config.js'),
  },
});
