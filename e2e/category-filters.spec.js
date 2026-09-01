import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Filtering by category, and filtering sizes that are not numbers.
 *
 * The bug this suite pins down: a size range is a numeric comparison, so a sock sized
 * "Kids" produced NULL from the cast and was excluded — silently. That range was the
 * only size filter in the app, so word sizes were both unfilterable and invisible the
 * moment anyone typed a number. The fix is a second control, and a UI that offers
 * whichever one the chosen category's size list can actually use.
 *
 * Fixed product codes: nothing here can be deleted through the API (inventory
 * references variants with RESTRICT), so a re-run reuses its own rows.
 */

const BELT_CODE = 'E2E-BELT-FILTER';
const SOCK_CODE = 'E2E-SOCK-FILTER';

let ctx = { storeId: null, storeName: null, belts: null, socks: null };

async function findOrCreateProduct(page, code, body) {
  const found = await api(page, 'GET', '/products', { params: { search: code, limit: '50' } });
  const existing = (found.body.data || []).find((p) => p.product_code === code);
  if (existing) return existing;
  const created = await api(page, 'POST', '/products', { body: { ...body, product_code: code } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data;
}

/** A product with one variant per size and one item of each in stock. */
async function stockedProduct(page, code, categoryId, name, sizes) {
  const product = await findOrCreateProduct(page, code, {
    model_name: name, category_id: categoryId, default_selling_price: 100,
  });

  const colors = await api(page, 'GET', `/products/${product.id}/colors`);
  let color = (colors.body.data || [])[0];
  if (!color) {
    const made = await api(page, 'POST', `/products/${product.id}/colors`, {
      body: { color_name: 'Filter', hex_code: '#334455' },
    });
    color = made.body.data;
  }

  const existing = await api(page, 'GET', `/products/${product.id}/variants`);
  const have = new Set((existing.body.data || []).map((v) => v.size_eu));

  for (const size of sizes) {
    if (have.has(size)) continue;
    const v = await api(page, 'POST', `/products/${product.id}/variants`, {
      body: { product_color_id: color.id, size_eu: size },
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const stock = await api(page, 'POST', '/inventory/manual', {
      body: { variant_id: v.body.data.id, store_id: ctx.storeId, cost: 10, quantity: 1 },
    });
    expect(stock.status, JSON.stringify(stock.body)).toBe(201);
  }
  return product;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');

  const stores = await api(page, 'GET', '/stores');
  const store = (stores.body.data || [])[0];
  expect(store, 'the database needs at least one store').toBeTruthy();
  ctx.storeId = store.id;
  ctx.storeName = store.name;

  const cats = await api(page, 'GET', '/product-categories');
  ctx.belts = (cats.body.data || []).find((c) => c.code === 'belts');
  ctx.socks = (cats.body.data || []).find((c) => c.code === 'socks');
  expect(ctx.belts && ctx.socks, 'the seeded categories should exist').toBeTruthy();

  // Belt lengths 80 / 90 / 100 sort 100, 80, 90 as text — the lexical bug in the open.
  // Shoe sizes are all two digits, so they cannot expose it.
  await stockedProduct(page, BELT_CODE, ctx.belts.id, 'filter belt', ['80', '90', '100']);
  // Sock sizes parse as no number at all.
  await stockedProduct(page, SOCK_CODE, ctx.socks.id, 'filter sock', ['KIDS', 'TEENS', 'ADULTS']);

  await page.close();
});

// ---------------------------------------------------------------- the API contract

test('a numeric range compares numerically, not as text', async ({ page }) => {
  await page.goto('/');
  const res = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, category_id: ctx.belts.id, size_min: '80', size_max: '95', limit: '5000' },
  });
  expect(res.status).toBe(200);
  const sizes = res.body.data.map((r) => r.size_eu).sort();
  // Compared as text, '100' >= '80' is false and '100' <= '95' is true — so a text
  // comparison returns the wrong set in both directions.
  expect(sizes).toEqual(['80', '90']);
});

test('word sizes can be filtered, which a range can never do', async ({ page }) => {
  await page.goto('/');
  const res = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, size_values: 'KIDS,ADULTS', limit: '5000' },
  });
  expect(res.status).toBe(200);
  expect(res.body.data.length).toBeGreaterThan(0);
  expect([...new Set(res.body.data.map((r) => r.size_eu))].sort()).toEqual(['ADULTS', 'KIDS']);
});

test('a malformed filter is a 400, not a 500 from Postgres', async ({ page }) => {
  await page.goto('/');
  const bad = await api(page, 'GET', '/inventory/summary', { params: { category_id: 'not-a-uuid' } });
  expect(bad.status).toBe(400);
  // The route validated nothing at all before, so this reached the database as a cast
  // error and surfaced to the user as a server error.
  expect(JSON.stringify(bad.body)).toMatch(/category_id/);
});

// ---------------------------------------------------------------- inventory screen

test('the inventory size control follows the category size list', async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByTestId('inventory-category')).toBeVisible({ timeout: 20_000 });

  // No category chosen: a number range, because the catalogue may hold anything.
  await expect(page.getByTestId('inventory-size-min')).toBeVisible();

  // Belts are a numeric list, so the range stays — labelled with the list's own unit.
  await page.getByTestId('inventory-category').click();
  await page.getByText('Belts', { exact: true }).click();
  await expect(page.getByTestId('inventory-size-min')).toBeVisible();
  await expect(page.getByTestId('inventory-category')).toContainText('Belts');
  await expect(page.locator('.filters-panel')).toContainText('(cm)');
  await shot(page, 'filters-belts-range');

  // Socks are words, so the range is replaced by the list's own values. Offering
  // "80 to 95" for Kids/Teens/Adults would be an input that cannot match anything.
  await page.getByTestId('inventory-category').click();
  await page.getByText('Socks', { exact: true }).click();
  await expect(page.getByTestId('inventory-size-values')).toBeVisible();
  await expect(page.getByTestId('inventory-size-min')).toHaveCount(0);
  const chips = page.getByTestId('inventory-size-values').locator('button');
  await expect(chips).toHaveCount(3);
  await expect(chips.first()).toHaveText(/kids/i);
  await shot(page, 'filters-socks-chips');
});

test('a category with no sizes offers no size filter at all', async ({ page }) => {
  await page.goto('/inventory');
  await page.getByTestId('inventory-category').click();
  await page.getByText('Bags', { exact: true }).click();
  await expect(page.getByTestId('inventory-size-none')).toBeVisible();
  await expect(page.getByTestId('inventory-size-min')).toHaveCount(0);
  await expect(page.getByTestId('inventory-size-values')).toHaveCount(0);
});

test('picking a size chip narrows the inventory list', async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByTestId('inventory-category')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('inventory-category').click();
  await page.getByText('Socks', { exact: true }).click();

  // The summary view is a collapsed tree, so the sizes themselves are not in the DOM.
  // The product row's quantity is the honest signal: three sizes, one item of each.
  const row = page.locator('.table-container table tbody tr').filter({ hasText: SOCK_CODE }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('td').nth(4)).toHaveText('3');

  await page.getByTestId('inventory-size-values').getByRole('button', { name: /kids/i }).click();
  await expect(row.locator('td').nth(4)).toHaveText('1', { timeout: 20_000 });
  await shot(page, 'filters-socks-kids-only');

  // And the Kids row is the one left standing once the tree is opened. The tree is
  // three deep — product, colour, size — so both levels have to be expanded before
  // any size label is in the DOM at all.
  await row.click();
  const table = page.locator('.table-container table');
  const colorRows = table.locator('tbody tr.color-row');
  const n = await colorRows.count();
  for (let i = 0; i < n; i++) await colorRows.nth(i).click();
  await expect(table).toContainText('Kids');
  await expect(table).not.toContainText('Teens');
  await expect(table).not.toContainText('Adults');
});

test('changing category clears a size filter that no longer means anything', async ({ page }) => {
  await page.goto('/inventory');
  await expect(page.getByTestId('inventory-category')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('inventory-category').click();
  await page.getByText('Belts', { exact: true }).click();
  await page.getByTestId('inventory-size-min').fill('80');

  await page.getByTestId('inventory-category').click();
  await page.getByText('Socks', { exact: true }).click();

  // '80' is not a sock size. Carried over, it would filter to nothing and read as
  // missing stock rather than as a stale filter.
  await expect(page.getByTestId('inventory-size-values')).toBeVisible();
  const row = page.locator('.table-container table tbody tr').filter({ hasText: SOCK_CODE }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('td').nth(4)).toHaveText('3');
});

// ---------------------------------------------------------------- POS

test('the POS filters products by category in one tap', async ({ page }) => {
  await page.goto('/pos');
  await expect(page.getByTestId('pos-categories')).toBeVisible({ timeout: 25_000 });

  const grid = page.locator('.pos-products-scroll');
  await expect(grid).toContainText(/filter belt/i, { timeout: 25_000 });

  await page.getByTestId(`pos-category-${ctx.socks.id}`).click();
  await expect(grid).toContainText(/filter sock/i, { timeout: 20_000 });
  await expect(grid).not.toContainText(/filter belt/i);
  await shot(page, 'filters-pos-socks');

  await page.getByTestId('pos-category-all').click();
  await expect(grid).toContainText(/filter belt/i, { timeout: 20_000 });
});

// ---------------------------------------------------------------- reports

test('reports break stock down by category, with sizes written properly', async ({ page }) => {
  await page.goto('/');
  const all = await api(page, 'GET', '/reports/inventory-analytics', { params: { store_id: ctx.storeId } });
  const socksOnly = await api(page, 'GET', '/reports/inventory-analytics', {
    params: { store_id: ctx.storeId, category_id: ctx.socks.id },
  });
  expect(socksOnly.status).toBe(200);

  const sizes = socksOnly.body.data.stock_by_size.map((r) => r.size).sort();
  expect(sizes).toEqual(['ADULTS', 'KIDS', 'TEENS']);
  expect(all.body.data.stock_by_size.length).toBeGreaterThan(socksOnly.body.data.stock_by_size.length);

  // The extra joins the category filter adds are many-to-one, so they must not
  // duplicate an inventory row and inflate a count.
  const byStore = socksOnly.body.data.stock_by_store.reduce((n, r) => n + r.count, 0);
  const bySize = socksOnly.body.data.stock_by_size.reduce((n, r) => n + r.count, 0);
  expect(byStore).toBe(bySize);

  // Belt lengths come back in numeric order and carry their unit, so the chart can
  // write "90 cm" instead of a bare number in text order.
  const beltsOnly = await api(page, 'GET', '/reports/inventory-analytics', {
    params: { store_id: ctx.storeId, category_id: ctx.belts.id },
  });
  const beltSizes = beltsOnly.body.data.stock_by_size.map((r) => r.size);
  expect(beltSizes).toEqual(['80', '90', '100']);
  expect(beltsOnly.body.data.stock_by_size[0].size_suffix).toBe('cm');
});

test('the reports ribbon offers a category only where it can be honoured', async ({ page }) => {
  await page.goto('/reports');
  const ribbon = page.locator('.dashboard-ribbon');
  await expect(ribbon).toBeVisible({ timeout: 25_000 });

  // Overview mixes sales money with stock, and a sale-level discount cannot be split
  // across categories — so no filter is offered rather than a wrong number.
  await expect(ribbon).not.toContainText('Category');

  await page.getByRole('button', { name: /inventory/i }).first().click();
  await expect(ribbon).toContainText('Category', { timeout: 20_000 });

  // react-select: type and commit. Clicking the rendered value hits its own overlaid
  // input instead, and the menu renders in a portal that the ribbon's stacking
  // context makes awkward to reach by text.
  const picker = ribbon.locator('.ribbon-group', { hasText: 'Category' });
  await picker.locator('.react-select__control').click();
  await page.keyboard.type('Belts');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('Belts');

  // The chart axis writes the unit from the belt size list.
  const chart = page.locator('.chart-card', { hasText: 'Size Distribution' });
  await expect(chart).toContainText('cm', { timeout: 20_000 });
  await shot(page, 'filters-reports-belts');
});
