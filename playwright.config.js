// =============================================================================
// playwright.config.js — browser smoke tests (e2e/)
// =============================================================================
// Runs against Django's dev server, which serves the built Vite bundles, so
// `npm run build` must have run first. Uses the installed Google Chrome
// (channel: 'chrome') rather than a Playwright-downloaded browser; GitHub's
// ubuntu runners ship it.
//
//   npm run test:e2e
//
// E2E_SERVER_CMD overrides the server command, e.g. on Windows with a venv:
//   E2E_SERVER_CMD=".venv/Scripts/python.exe manage.py runserver 127.0.0.1:8000 --noreload"
import { defineConfig } from '@playwright/test';

const PORT = process.env.E2E_PORT || '8000';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: process.env.E2E_SERVER_CMD || `python manage.py runserver 127.0.0.1:${PORT} --noreload`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
