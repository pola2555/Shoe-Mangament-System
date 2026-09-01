import { test, expect } from '@playwright/test';
import { api, shot, hardwareScan, humanType, scanResult } from './helpers.js';

/**
 * POS scanning, driven through the real UI.
 *
 * The hardware scanner is simulated by pressing keys a few milliseconds apart and
 * finishing with Enter — which is exactly how a USB wedge behaves, and exactly what
 * the detection heuristic keys off.
 */

let fixture = {};

// Fetched once for the file. Re-fetching per test pushed the run over the global
// 200-requests-per-minute limiter, which then failed tests for reasons unrelated to
// what they cover.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const inv = await api(page, 'GET', '/inventory', { params: { status: 'in_stock', limit: '200' } });
  expect(inv.status, `inventory fetch failed: ${JSON.stringify(inv.body)}`).toBe(200);

  const rows = (inv.body.data || []).filter((i) => i.barcode);
  expect(rows.length, 'need barcoded stock to test against').toBeGreaterThan(0);

  // 'scanning twice adds two pairs' needs two physical pairs of ONE variant in ONE
  // store, so pick that deliberately rather than taking whichever row sorts first.
  const byVariant = new Map();
  for (const r of rows) {
    const key = `${r.variant_id}|${r.store_id}`;
    byVariant.set(key, [...(byVariant.get(key) || []), r]);
  }
  const pair = [...byVariant.values()].find((g) => g.length >= 2);
  expect(pair, 'need one variant with two pairs in stock in the same store').toBeTruthy();

  fixture.item = pair[0];
  fixture.barcode = pair[0].barcode;
  fixture.storeId = pair[0].store_id;
  fixture.inStock = pair.length;
  await page.close();
});

test.beforeEach(async ({ page }) => {
  // Seed POS state the way the app itself persists it, and start from an empty cart
  // so counts in the assertions are unambiguous.
  await page.addInitScript(([store]) => {
    localStorage.setItem('pos_store', store);
    localStorage.removeItem('pos_cart');
  }, [fixture.storeId]);

  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible();

  // Wait for the POS's own initial inventory load to finish before scanning. It pulls
  // a large payload on mount, and typing during that work means the burst competes
  // with JSON parsing on the main thread. The product grid (or its empty state) only
  // appears once that request has resolved.
  await page.locator('.pos-products-grid, .pos-empty-state').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  // Passive effects, including the scanner listener, run after paint.
  await page.waitForTimeout(200);
});

test('hardware scan adds the right pair to the cart', async ({ page }) => {
  await shot(page, 'pos-before-scan');

  await hardwareScan(page, fixture.barcode);

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  const strip = await page.getByTestId('scan-ok').textContent();
  expect(strip).toContain(fixture.item.product_name);
  expect(strip).toContain(fixture.item.size_label_en || String(fixture.item.size_eu));

  // And it is really in the cart, not just announced.
  const cartItems = page.locator('.pos-cart-item');
  await expect(cartItems).toHaveCount(1);

  await shot(page, 'pos-after-hardware-scan');
});

test('scanning twice adds two pairs', async ({ page }) => {
  await hardwareScan(page, fixture.barcode);
  const first = await scanResult(page);
  expect(first.ok, `first scan failed: ${first.text}`).toBe(true);
  await expect(page.locator('.pos-cart-item')).toHaveCount(1);

  await hardwareScan(page, fixture.barcode);
  await expect(page.locator('.pos-cart-item')).toHaveCount(2);

  // The two lines must be DIFFERENT physical pairs, or the sale would try to sell one
  // item twice and fail at checkout.
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('pos_cart') || '[]').map((c) => c.id));
  expect(new Set(ids).size, 'two cart lines must be two distinct inventory items').toBe(2);

  await shot(page, 'pos-two-pairs-scanned');
});

test('typing at human speed is NOT treated as a scan', async ({ page }) => {
  // The whole heuristic rests on this: a cashier typing a number into the search box
  // must never silently add stock to the cart.
  await page.locator('.pos-search-input-wrap input').click();
  await humanType(page, fixture.barcode.slice(0, 8));

  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await expect(page.getByTestId('scan-ok')).toHaveCount(0);
  await shot(page, 'pos-human-typing-ignored');
});

test('scan while the search box has focus does not corrupt the field', async ({ page }) => {
  const search = page.locator('.pos-search-input-wrap input');
  await search.click();
  await search.fill('nike');

  await hardwareScan(page, fixture.barcode);

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  // The burst must be unwound from the input, leaving what the cashier actually typed.
  await expect(search).toHaveValue('nike');
  await shot(page, 'pos-scan-with-search-focused');
});

test('unknown barcode shows a clear error and adds nothing', async ({ page }) => {
  await hardwareScan(page, '2009999990001');

  await expect(page.getByTestId('scan-err')).toBeVisible();
  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await shot(page, 'pos-unknown-barcode');
});

test('bad check digit is rejected', async ({ page }) => {
  const bad = fixture.barcode.slice(0, 12) + ((Number(fixture.barcode[12]) + 1) % 10);
  await hardwareScan(page, bad);

  await expect(page.getByTestId('scan-err')).toBeVisible();
  const msg = await page.getByTestId('scan-err').textContent();
  expect(msg).toMatch(/check digit/i);
  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await shot(page, 'pos-bad-check-digit');
});

test('scanning out-of-stock stock reports it rather than overselling', async ({ page }) => {
  // Drain every available pair of this variant into the cart, then scan once more.
  const res = await api(page, 'GET', '/barcodes/lookup', {
    params: { code: fixture.barcode, store_id: fixture.storeId },
  });
  const total = res.body.data.available_count;

  for (let i = 0; i < total; i++) {
    await hardwareScan(page, fixture.barcode);
    await expect(page.locator('.pos-cart-item')).toHaveCount(i + 1);
  }

  await hardwareScan(page, fixture.barcode);
  await expect(page.getByTestId('scan-err')).toBeVisible();
  await expect(page.locator('.pos-cart-item')).toHaveCount(total); // unchanged
  await shot(page, 'pos-stock-exhausted');
});

test('a store is always selected, so a scan is never ambiguous', async ({ page }) => {
  // Clearing the stored store does not leave the POS in a scannable-but-storeless
  // state: it auto-selects the first store the user can access. Worth pinning down,
  // because a scan without a store would have no stock to resolve against.
  await page.addInitScript(() => {
    localStorage.removeItem('pos_store');
    localStorage.removeItem('pos_cart');
  });
  await page.goto('/pos');
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('pos-scan-button')).toBeEnabled();
  const store = await page.evaluate(() => localStorage.getItem('pos_store'));
  expect(store, 'POS must settle on a store by itself').toBeTruthy();
  await shot(page, 'pos-store-auto-selected');
});

test('camera scanner opens and reports its capability tier', async ({ page }) => {
  await page.getByTestId('pos-scan-button').click();

  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  // localhost is a secure context and Chromium is launched with a fake camera, so the
  // live-stream tier must be the one selected here.
  await expect(modal.getByText(/live camera/i)).toBeVisible({ timeout: 15_000 });
  await shot(page, 'pos-camera-scanner-open');

  await modal.getByRole('button', { name: /close/i }).click();
  await expect(modal).toBeHidden();
});
