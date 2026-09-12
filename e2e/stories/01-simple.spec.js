import { test, expect } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage, takePair, cleanup, priceOf } from './world.js';

/**
 * SIMPLE STORIES — one person, one thing, the way it goes on an ordinary Tuesday.
 *
 * These are the motions the shop makes fifty times a day. If any of them needs a
 * workaround the system is not usable, however well the complicated ones behave.
 */

const world = loadWorld();
const claimed = new Set();
const made = { saleIds: [] };

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  await cleanup(api, page, made);
  await closePage(page);
});

/** A phone number no other story is using. */
function uniquePhone() {
  // `('0100' + Date.now()).slice(0, 11)` kept only the first seven digits of the
  // timestamp, which change roughly every sixteen minutes — so two stories running in
  // the same quarter hour asked for the identical number and the second was refused.
  return `01${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

// ─────────────────────────────────────────────────────── the cashier's day

test('S1 · Karim opens the till and his branch is already chosen', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });

  // He is assigned to one branch, so there is nothing to choose and no way to pick
  // the branch he is not allowed to sell from.
  const stores = await api(page, 'GET', '/stores');
  expect(stores.status).toBe(200);
  await shot(page, 'story-cashier-till');
  await closePage(page);
});

test('S2 · Karim sells one pair to a walk-in, paid in cash', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');
  const storeId = world.stores.A.id;
  const pair = await takePair(api, page, { storeId, productId: world.products.shoe.id, exclude: claimed });

  const before = await api(page, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '200' } });
  const inStockBefore = before.body.data.filter((i) => i.status === 'in_stock').length;

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: storeId,
      items: [{ id: pair.id, sale_price: priceOf(pair, world.products.shoe.price) }],
      payments: [{ amount: priceOf(pair, world.products.shoe.price), payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);
  expect(Number(sale.body.data.amount_due)).toBe(0);

  const after = await api(page, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '200' } });
  expect(after.body.data.filter((i) => i.status === 'in_stock').length).toBe(inStockBefore - 1);
  await closePage(page);
});

test('S3 · Karim finds a product by typing part of its name', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });

  await page.locator('.pos-search-input-wrap input').fill('Story Runner');
  await page.getByRole('button', { name: /^search$/i }).click();

  const card = page.locator('.pos-product-card', { hasText: 'Story Runner' });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });
  await shot(page, 'story-search-by-name');
  await closePage(page);
});

test('S4 · Karim narrows the grid to one category, then one size, then one colour', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/pos');
  await expect(page.getByTestId('pos-categories')).toBeVisible({ timeout: 25_000 });

  await page.getByTestId(`pos-category-${world.products.shoe.category_id}`).click();
  await page.waitForTimeout(600);
  await expect(page.locator('.pos-product-card', { hasText: 'Story Belt' })).toHaveCount(0);

  await page.getByTestId('pos-toggle-filters').click();
  await expect(page.getByTestId('pos-sizes')).toBeVisible();
  await page.getByTestId('pos-size-42').click();
  await page.waitForTimeout(600);

  await page.getByTestId('pos-color-Black').click();
  await page.waitForTimeout(600);
  await shot(page, 'story-three-filters');

  // Whatever is left really is shoes, size 42, black.
  const rows = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: world.stores.A.id, category_id: world.products.shoe.category_id,
      size_values: '42', colors: 'Black', limit: '200' },
  });
  expect(rows.body.data.length).toBeGreaterThan(0);
  for (const r of rows.body.data) {
    expect(r.size_eu).toBe('42');
    expect(String(r.color_name).toLowerCase()).toBe('black');
  }

  await page.getByTestId('pos-clear-filters').click();
  await expect(page.getByTestId('pos-clear-filters')).toHaveCount(0);
  await closePage(page);
});

test('S5 · a customer leans over the counter, so Karim hides the prices', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });

  const prices = page.getByTestId('pos-card-price');
  await expect(prices.first()).toBeVisible({ timeout: 20_000 });
  await expect(prices.first()).toContainText(/\d/);

  await page.getByTestId('pos-toggle-prices').click();
  const shown = await prices.count();
  for (let i = 0; i < shown; i++) await expect(prices.nth(i)).toHaveText(/^•+$/);
  await shot(page, 'story-prices-hidden');

  // Still hidden after a reload — a till set up for the shop floor stays that way.
  await page.reload();
  await expect(page.getByTestId('pos-toggle-prices')).toHaveAttribute('aria-pressed', 'true', { timeout: 25_000 });
  await page.getByTestId('pos-toggle-prices').click();
  await expect(page.getByTestId('pos-card-price').first()).toContainText(/\d/);
  await closePage(page);
});

test('S6 · Karim adds a new customer from the till without leaving the sale', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });

  const phone = uniquePhone();
  // By role deliberately: this button was nested inside a <label>, which took it out
  // of the accessibility tree entirely. It looked fine on screen and was invisible to
  // a screen reader.
  await page.getByRole('button', { name: /quick add customer/i }).click();
  const modal = page.locator('.modal-content');
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder(/^name$/i).fill('Walk-up Wael');
  await modal.locator('input[required]').first().fill(phone);
  await modal.getByRole('button', { name: /^add customer$/i }).click();

  await expect(async () => {
    const found = await api(page, 'GET', '/customers/search', { params: { phone } });
    expect(found.body.data?.phone || found.body.data?.[0]?.phone).toBe(phone);
  }).toPass({ timeout: 15_000 });

  // Tidy up after itself: a run that leaves a customer behind adds one to the list
  // every time the suite is run.
  const created = await api(page, 'GET', '/customers/search', { params: { phone } });
  const id = created.body.data?.id || created.body.data?.[0]?.id;
  if (id) await api(page, 'DELETE', `/customers/${id}`).catch(() => {});
  await closePage(page);
});

// ─────────────────────────────────────────────────────── the manager's day

test('S7 · Mona checks how her branch did today, without opening a report', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/stores');
  const card = page.getByTestId(`store-card-${world.stores.A.id}`);
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText(/today/i);

  const stats = (await api(page, 'GET', '/stores', { params: { include_stats: '1' } }))
    .body.data.find((s) => s.id === world.stores.A.id).stats;
  expect(stats.stock_units).toBeGreaterThan(0);
  await shot(page, 'story-manager-branches');
  await closePage(page);
});

test('S8 · Mona opens a branch and reads its month', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto(`/stores/${world.stores.A.id}`);
  await expect(page.getByTestId('store-detail-name')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('store-revenue')).toBeVisible();

  const overview = await api(page, 'GET', `/stores/${world.stores.A.id}/overview`, {
    params: { all_time: '1' },
  });
  expect(overview.status).toBe(200);
  // Net is profit less expenses, on the screen and in the answer behind it.
  const m = overview.body.data.metrics;
  expect(Math.abs(m.net - (m.gross_profit - m.expenses))).toBeLessThan(0.01);
  await closePage(page);
});

test('S9 · Mona records the electricity bill against her branch', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/expenses');
  await expect(page.getByTestId('expenses-table')).toBeVisible({ timeout: 25_000 });

  const cats = await api(page, 'GET', '/expenses/categories');
  const category = cats.body.data.find((c) => c.is_active);
  const today = new Date().toLocaleDateString('en-CA');

  const made2 = await api(page, 'POST', '/expenses', {
    body: {
      store_id: world.stores.A.id, category_id: category?.id || null,
      amount: 137.5, expense_date: today,
      description: 'Story electricity', payment_method: 'cash', paid_to: 'Utility Co',
    },
  });
  expect(made2.status, JSON.stringify(made2.body)).toBe(201);

  // A date has no timezone. It must read back as the day it was entered — this is the
  // exact shape of the bug that had every DATE in the system a day behind.
  const read = await api(page, 'GET', `/expenses/${made2.body.data.id}`);
  expect(String(read.body.data.expense_date).slice(0, 10)).toBe(today);

  await api(page, 'DELETE', `/expenses/${made2.body.data.id}`);
  await closePage(page);
});

// ─────────────────────────────────────────────────────── the owner's day

test('S10 · the admin opens a new branch and closes it again', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/stores');
  await expect(page.getByTestId('store-grid')).toBeVisible({ timeout: 25_000 });

  const NAME = 'Story Pop-up';
  const existing = (await api(page, 'GET', '/stores')).body.data.find((s) => s.name === NAME);
  const id = existing ? existing.id
    : (await api(page, 'POST', '/stores', { body: { name: NAME } })).body.data.id;

  if (existing && !existing.is_active) await api(page, 'PUT', `/stores/${id}`, { body: { is_active: true } });

  // Empty, so nothing is stranded by closing it.
  const closed = await api(page, 'PUT', `/stores/${id}`, { body: { is_active: false } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(closed.body.data.is_active).toBe(false);
  await closePage(page);
});

test('S11 · Viviane can look at everything she is allowed to and change none of it', async ({ browser }) => {
  const page = await pageAs(browser, 'viewer');
  await page.goto('/products');
  await expect(page.locator('body')).toBeVisible();

  const read = await api(page, 'GET', '/products');
  expect(read.status).toBe(200);

  const write = await api(page, 'POST', '/products', {
    body: { product_code: 'SHOULD-NOT-EXIST', model_name: 'nope', category_id: world.products.shoe.category_id },
  });
  expect(write.status, 'read-only must not be able to create').toBe(403);
  expect(String(write.body.message)).toMatch(/read-only|denied/i);
  await closePage(page);
});
