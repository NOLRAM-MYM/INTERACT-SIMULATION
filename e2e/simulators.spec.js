// Browser smoke tests: every module boots cleanly, the floating panels sit
// beside the simulation instead of over it, and settings that used to be
// ignored by the views (motor canvas, pause, beam load) now reach them.
import { test, expect } from '@playwright/test';

const MODULES = ['fluids', 'materials', 'chemistry', 'physics', 'tribology', 'biology'];

test.beforeEach(async ({ context }) => {
  // Keep django-debug-toolbar (dev settings) collapsed: open, it covers the
  // results panel and swallows clicks. It reads this key on every load.
  await context.addInitScript(() => localStorage.setItem('djdt.show', 'false'));
});

/** Collect uncaught errors and console.error calls from the page. */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  // "Failed to load resource" repeats the response above without its URL.
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

for (const name of MODULES) {
  test(`${name}: boots without errors, panels beside the simulation`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(`/api/${name}/`);
    await expect(page.locator('#config-panel')).toHaveClass(/is-open/);
    await expect(page.locator('#results-panel')).toHaveClass(/is-open/);
    await expect(page.locator('#view-panel')).toHaveClass(/is-open/);
    await expect(page.locator('body')).toHaveClass(/fp-room-left/);
    await expect(page.locator('body')).toHaveClass(/fp-room-right/);

    // The simulation sits between the two panels, not under them — once the
    // page padding has finished its 250 ms transition into place.
    await expect.poll(async () => {
      const sim = await page.locator('.sim-fullscreen').boundingBox();
      const config = await page.locator('#config-panel').boundingBox();
      const results = await page.locator('#results-panel').boundingBox();
      return sim.x >= config.x + config.width && sim.x + sim.width <= results.x;
    }).toBe(true);

    expect(errors).toEqual([]);
  });
}

test('dragging a panel off its home frees its column; double-click brings it back', async ({ page }) => {
  await page.goto('/api/fluids/');
  const header = page.locator('#config-panel .floating-panel__header');
  await expect(page.locator('body')).toHaveClass(/fp-room-left/);

  const box = await header.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/fp-room-left/);

  await header.dblclick({ position: { x: 40, y: 20 } });
  await expect(page.locator('body')).toHaveClass(/fp-room-left/);
});

test('physics: the motor canvas draws after a mode switch and pause toggles', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/api/physics/magnetism/');
  await page.locator('.mode-tab-btn[data-mode="motor"]').click();
  await expect(page.locator('#motor-canvas')).toBeVisible();
  await expect(page.locator('#view-panel')).toBeHidden();   // 2D view: no camera

  // Painted pixels: switching modes used to leave the motor loop stopped.
  await expect.poll(() => page.evaluate(() => {
    const c = document.getElementById('motor-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 64) if (d[i] > 0) lit++;
    return lit;
  })).toBeGreaterThan(100);

  const pause = page.locator('#toggle-animation');
  await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'false');

  // The overloaded preset stalls instead of spinning backwards.
  await page.locator('#presets-container button', { hasText: 'Bloqueado' }).click();
  await expect(page.locator('#badge-primary-val')).toHaveText(/TRAVADO|STALLED/);
  expect(errors).toEqual([]);
});

test('materials: more load means more deflection and a lower safety factor', async ({ page }) => {
  await page.goto('/api/materials/');
  await expect(page.locator('#kpi-sf-val')).not.toHaveText('—');
  const sfBefore = parseFloat(await page.locator('#kpi-sf-val').textContent());
  const dBefore = parseFloat(await page.locator('#kpi-deflection-val').textContent());

  await page.locator('#load_kn').fill('150');
  await expect.poll(async () => parseFloat(await page.locator('#kpi-sf-val').textContent()))
    .toBeCloseTo(sfBefore / 3, 2);
  const dAfter = parseFloat(await page.locator('#kpi-deflection-val').textContent());
  expect(dAfter).toBeCloseTo(dBefore * 3, 2);

  await page.locator('.diagram-switch__btn[data-diagram="moment"]').click();
  await expect(page.locator('.diagram-switch__btn[data-diagram="moment"]')).toHaveClass(/--active/);
});

test('focus mode hides the page header and shows the HUD over the canvas', async ({ page }) => {
  await page.goto('/api/fluids/');
  await expect(page.locator('#re-value')).not.toHaveText('—');   // solved on load
  await page.locator('#focus-toggle').click();
  await expect(page.locator('.page-header')).toBeHidden();
  await expect(page.locator('.sim-hud')).toHaveClass(/is-visible/);
  await expect(page.locator('.sim-hud')).toContainText('Re');
  await page.locator('#focus-toggle').click();
  await expect(page.locator('.page-header')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('panels are bottom sheets, one at a time', async ({ page }) => {
    await page.goto('/api/materials/');
    await expect(page.locator('#config-panel')).not.toHaveClass(/is-open/);   // closed on phones
    await page.locator('#fab-config').click();
    await expect(page.locator('#config-panel')).toHaveClass(/is-open/);
    // Full width, resting on the bottom edge once the slide-in has finished.
    await expect.poll(async () => {
      const sheet = await page.locator('#config-panel').boundingBox();
      return [Math.round(sheet.width), Math.round(sheet.y + sheet.height)];
    }).toEqual([390, 844]);

    await page.locator('#fab-results').click();
    await expect(page.locator('#results-panel')).toHaveClass(/is-open/);
    await expect(page.locator('#config-panel')).not.toHaveClass(/is-open/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
