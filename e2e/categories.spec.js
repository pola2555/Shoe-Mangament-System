import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Product categories, end to end through the real UI.
 *
 * The stories that matter: a shop can invent a category the code has never heard of
 * (knives), a product in it needs neither a colour nor a size, and nothing downstream
 * — labels, the POS, inventory — prints "EU OS" or a made-up colour called "Standard".
 */

const CODE = 'e2e_knives';
const KNIFE_CODE = 'E2E-KNIFE';
const SOCK_CODE = 'E2E-SOCK';
const SKU_CODE = 'E2E-COLOUR-CLASH';
let made = { productIds: [], categoryId: null };

/**
 * Find-or-create, with fixed codes.
 *
 * A product cannot be deleted through the API — inventory references variants with
 * RESTRICT — so anything this suite creates is permanent. Fixed codes mean a re-run
 * reuses the same two rows instead of leaving a fresh pair behind every time.
 */
async function findOrCreateProduct(page, code, body) {
  const found = await api(page, 'GET', '/products', { params: { search: code, limit: '50' } });
  const existing = (found.body.data || []).find((p) => p.product_code === code);
  if (existing) return existing;
  const created = await api(page, 'POST', '/products', { body: { ...body, product_code: code } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data;
}

test.describe.configure({ mode: 'serial' });

test('the catalogue setup page lists the seeded categories', async ({ page }) => {
  await page.goto('/catalog-setup');
  await expect(page.getByRole('heading', { name: /categories & sizes/i })).toBeVisible();

  for (const code of ['shoes', 'socks', 'bags', 'belts', 'tools', 'accessories']) {
    await expect(page.getByTestId(`category-${code}`)).toBeVisible();
  }

  // Socks must offer the age groups, not shoe sizes.
  await expect(page.getByTestId('category-socks')).toContainText(/age group/i);
  // A bag has no size at all.
  await expect(page.getByTestId('category-bags')).toContainText(/no sizes/i);
  // Tools have no colour.
  const tools = page.getByTestId('category-tools');
  await expect(tools).toContainText(/no sizes/i);

  await shot(page, 'cat-setup-categories');
});

test('a shop can invent a category the code never heard of', async ({ page }) => {
  await page.goto('/catalog-setup');
  // Categories cannot be deleted either, so a re-run finds it already present.
  if (await page.getByTestId(`category-${CODE}`).count()) {
    await expect(page.getByTestId(`category-${CODE}`)).toContainText(/no sizes/i);
    return;
  }
  await page.getByTestId('add-category').click();

  await page.getByTestId('cat-code').fill(CODE);
  await page.getByTestId('cat-name-en').fill('Knives');
  await page.getByTestId('cat-name-ar').fill('سكاكين');
  // Neither colours nor sizes — the case the old schema could not express at all.
  await page.getByTestId('cat-has-colors').uncheck();
  await page.getByTestId('cat-has-sizes').uncheck();
  await shot(page, 'cat-setup-new-category');
  await page.getByTestId('cat-save').click();

  await expect(page.getByTestId(`category-${CODE}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`category-${CODE}`)).toContainText(/no sizes/i);
});

test('a knife product needs neither a colour nor a size', async ({ page }) => {
  await page.goto('/');
  const cats = await api(page, 'GET', '/product-categories');
  const knives = cats.body.data.find((c) => c.code === CODE);
  expect(knives, 'the category from the previous test should exist').toBeTruthy();
  made.categoryId = knives.id;

  const product = await findOrCreateProduct(page, KNIFE_CODE, {
    model_name: 'chef knife', category_id: knives.id, default_selling_price: 250,
  });
  const code = product.product_code;
  made.productIds.push(product.id);

  await page.goto(`/products/${product.id}`);
  await page.getByRole('button', { name: /size variants/i }).click();
  await page.getByRole('button', { name: /add variants/i }).click();

  const matrix = page.getByTestId('variant-matrix');
  await expect(matrix).toBeVisible();
  // One row, one cell: no colour to choose and no size to choose.
  await expect(matrix.locator('tbody tr')).toHaveCount(1);
  const cell = matrix.locator('tbody td div[data-state]');
  await expect(cell).toHaveCount(1);
  await shot(page, 'knife-matrix');

  // On a re-run the variant is already there, which the matrix shows as 'exists'.
  if ((await cell.getAttribute('data-state')) !== 'exists') {
    await cell.click();
    await page.getByTestId('matrix-create').click();
  }

  // Scoped to the variant's own row: the matrix has a tbody too, and stays open on a
  // re-run where there is nothing new to create.
  const row = page.locator('table tbody tr').filter({ hasText: code });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  await expect(row.first()).toContainText(/2\d{12}/);
  await shot(page, 'knife-variant-created');
});

test('a knife label prints no size and no invented colour', async ({ page }) => {
  await page.goto('/');
  const id = made.productIds[0];
  const labels = await api(page, 'GET', '/barcodes/labels', { params: { product_id: id } });
  expect(labels.status).toBe(200);
  expect(labels.body.data.length).toBeGreaterThan(0);

  await page.goto(`/products/${id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await expect(modal.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  await modal.getByText(/^preview$/i).click();

  const label = modal.locator('.shoe-label').first();
  await expect(label).toBeVisible();
  const text = (await label.textContent()) || '';

  // The two failures this whole design exists to prevent.
  expect(text, 'a knife label must not claim a EU size').not.toMatch(/EU/);
  expect(text, 'a knife label must not print the placeholder colour').not.toMatch(/Standard/);
  expect(text, 'the one-size sentinel must never reach paper').not.toMatch(/\bOS\b/);

  // A viewport shot, not an element or clip one: the label lives inside a fixed
  // overlay, where element coordinates do not line up with page coordinates.
  await label.scrollIntoViewIfNeeded();
  // The dialog itself must not leak the placeholder either.
  await expect(modal).not.toContainText('Standard');
  await expect(modal).not.toContainText('Size (EU)');
  await shot(page, 'knife-label');

  // Same for the thermal printer path. Copies default to stock on hand, and this
  // knife has never been received, so ask for one explicitly first.
  await modal.getByRole('button', { name: /one each/i }).click();
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: /download tspl/i }).click();
  const stream = await (await download).createReadStream();
  let tspl = '';
  for await (const chunk of stream) tspl += chunk;
  expect(tspl).not.toMatch(/"EU /);
  expect(tspl).not.toMatch(/Standard/);
});

test('socks offer age groups, and the matrix creates a colour x size grid', async ({ page }) => {
  await page.goto('/');
  const cats = await api(page, 'GET', '/product-categories');
  const socks = cats.body.data.find((c) => c.code === 'socks');

  const product = await findOrCreateProduct(page, SOCK_CODE, {
    model_name: 'ankle socks', category_id: socks.id, default_selling_price: 60,
  });
  const productId = product.id;
  made.productIds.push(productId);

  // Colours are unique per product, so a re-run's duplicates are simply rejected.
  for (const [name, hex] of [['Black', '#000000'], ['White', '#FFFFFF']]) {
    await api(page, 'POST', `/products/${productId}/colors`, { body: { color_name: name, hex_code: hex } })
      .catch(() => {});
  }

  await page.goto(`/products/${productId}`);
  await page.getByRole('button', { name: /size variants/i }).click();
  await page.getByRole('button', { name: /add variants/i }).click();

  const matrix = page.getByTestId('variant-matrix');
  await expect(matrix).toBeVisible();
  // The columns are the category's sizes — not a number range, which is all the old
  // generator could produce.
  const headers = await matrix.locator('thead th').allTextContents();
  expect(headers.join('|')).toMatch(/Kids/i);
  expect(headers.join('|')).toMatch(/Teens/i);
  expect(headers.join('|')).toMatch(/Adults/i);
  await expect(matrix.locator('tbody tr')).toHaveCount(2);

  await shot(page, 'socks-matrix');

  await matrix.getByTestId('matrix-all').click();
  const toCreate = await matrix.locator('td div[data-state="selected"]').count();
  if (toCreate > 0) await page.getByTestId('matrix-create').click();

  // The variants table, not the matrix's own table — the matrix stays open on a re-run
  // where there is nothing left to create.
  const variantsTable = page.locator('.table-container table');
  await expect(variantsTable.locator('tbody tr')).toHaveCount(6, { timeout: 20_000 });
  // Variants list in scale order across colours, so the distinct sizes come back in
  // the list's own order. Alphabetically this would be Adults, Kids, Teens.
  const sizes = await variantsTable.locator('tbody tr td:nth-child(4)').allTextContents();
  const distinct = [...new Set(sizes.map((x) => x.trim()))];
  expect(distinct).toEqual(['Kids', 'Teens', 'Adults']);
  await shot(page, 'socks-variants');
});

test('two colours whose names start the same way can both take size variants', async ({ page }) => {
  // The reported failure, through the screens it was reported on: add "Black", then
  // "Black and White" — both accepted — then add sizes and the second colour is
  // rejected with "a record with this value already exists". Both colours abbreviated
  // to BLA in the SKU, and two of the three copies of SKU generation had no collision
  // handling at all.
  await page.goto('/');
  const cats = await api(page, 'GET', '/product-categories');
  const shoes = (cats.body.data || []).find((c) => c.code === 'shoes');

  const product = await findOrCreateProduct(page, SKU_CODE, {
    model_name: 'colour clash', category_id: shoes.id, default_selling_price: 300,
  });
  made.productIds.push(product.id);

  for (const name of ['Black', 'Black and White']) {
    await api(page, 'POST', `/products/${product.id}/colors`, { body: { color_name: name } })
      .catch(() => {});
  }

  await page.goto(`/products/${product.id}`);
  await page.getByRole('button', { name: /size variants/i }).click();
  await page.getByRole('button', { name: /add variants/i }).click();

  const matrix = page.getByTestId('variant-matrix');
  await expect(matrix).toBeVisible();
  await expect(matrix.locator('tbody tr')).toHaveCount(2);

  // Two sizes across both colours, in the one request the matrix sends.
  for (const size of ['40', '41']) {
    await matrix.getByRole('columnheader', { name: new RegExp(`^(EU )?${size}$`) }).click();
  }
  const selected = await matrix.locator('td div[data-state="selected"]').count();
  if (selected > 0) await page.getByTestId('matrix-create').click();

  const variantsTable = page.locator('.table-container table');
  await expect(variantsTable.locator('tbody tr')).toHaveCount(4, { timeout: 20_000 });

  // What used to fail: four rows, four distinct SKUs, four distinct barcodes.
  const rows = await api(page, 'GET', `/products/${product.id}/variants`);
  const skus = rows.body.data.map((v) => v.sku);
  const barcodes = rows.body.data.map((v) => v.barcode);
  expect(skus.length, 'expected four variants').toBe(4);
  expect(new Set(skus).size, `duplicate SKUs: ${skus.join(', ')}`).toBe(4);
  expect(new Set(barcodes).size, 'duplicate barcodes').toBe(4);

  // And the SKU still says which colour it is, rather than falling back to a bare
  // numeric suffix that reads the same for every colour.
  expect(skus.filter((k) => k.includes('-BLA-')).length).toBe(2);
  expect(skus.filter((k) => k.includes('-BWH-')).length).toBe(2);

  await shot(page, 'colour-clash-variants');
});

// No cleanup step: nothing here can be deleted through the API, so the suite reuses
// its own fixed rows instead of leaving new ones behind on every run.
