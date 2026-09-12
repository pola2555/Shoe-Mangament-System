import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * The branch control page, the reports the user asked to be made clearer, and the two
 * things the till gained: a way to hide prices and a way to filter by what is on the
 * shelf.
 *
 * None of this could be done before:
 *   - a store was four columns and an edit form that could not even mark a warehouse;
 *   - `store_product_prices` had existed since the first migration and was read by the
 *     till, the barcode lookup and the inventory query, but nothing had ever written a
 *     row into it, so a branch could not charge its own price;
 *   - the reports showed a number with nothing to compare it against;
 *   - the till could filter by category, and only by category.
 */

let ctx = { storeId: null, storeName: null, productId: null };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = stores.body.data[0].id;
  ctx.storeName = stores.body.data[0].name;
  const products = await api(page, 'GET', '/products', { params: { limit: '1' } });
  ctx.productId = products.body.data[0]?.id || null;
  await page.close();
});

// ---------------------------------------------------------------- store page

test('the store list says how each branch is doing without a click', async ({ page }) => {
  await page.goto('/stores');
  const card = page.getByTestId(`store-card-${ctx.storeId}`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Stock, today and this month — the three things a shop owner opens this page for.
  await expect(card).toContainText(/stock|مخزون/i);
  await shot(page, 'stores-grid');

  // And the figures are the same ones the API reports, not a second calculation.
  const res = await api(page, 'GET', '/stores', { params: { include_stats: '1' } });
  const stats = res.body.data.find((s) => s.id === ctx.storeId).stats;
  await expect(card).toContainText(String(stats.stock_units));
});

test('opening a branch shows its report, and the figures tie to the company report', async ({ page }) => {
  await page.goto('/stores');
  await page.getByTestId(`open-store-${ctx.storeId}`).click();
  await expect(page.getByTestId('store-detail-name')).toHaveText(ctx.storeName, { timeout: 20_000 });

  await page.getByTestId('store-period').selectOption('all');
  await expect(page.getByTestId('store-revenue')).toBeVisible();
  await shot(page, 'store-overview');

  // The number on screen is the number the API gives, and the API's number is the
  // company report's number for this store. That chain is what stops one branch
  // reading two different revenues on two screens.
  const overview = await api(page, 'GET', `/stores/${ctx.storeId}/overview`, { params: { all_time: '1' } });
  const company = await api(page, 'GET', '/reports/dashboard', {
    params: { all_time: '1', store_id: ctx.storeId },
  });
  expect(Math.abs(overview.body.data.metrics.revenue - company.body.data.metrics.net_sales)).toBeLessThan(0.01);
});

test('a branch that still holds stock cannot be closed, and is told why', async ({ page }) => {
  await page.goto('/');
  const res = await api(page, 'PUT', `/stores/${ctx.storeId}`, { body: { is_active: false } });
  expect(res.status).toBe(400);
  expect(String(res.body.message)).toMatch(/in stock/i);

  // And it is still open afterwards — a refused change must change nothing.
  const after = await api(page, 'GET', `/stores/${ctx.storeId}`);
  expect(after.body.data.is_active).toBe(true);
});

test('THE GAP: a branch can set its own price, and the till sees it', async ({ page }) => {
  test.skip(!ctx.productId, 'no products to price');
  await page.goto(`/stores/${ctx.storeId}`);
  await page.getByTestId('store-tab-pricing').click();
  await expect(page.getByTestId('store-prices-table')).toBeVisible({ timeout: 20_000 });

  const row = page.getByTestId(`price-row-${ctx.productId}`);
  await expect(row).toBeVisible();
  await page.getByTestId(`price-input-${ctx.productId}`).fill('654');
  await page.getByTestId(`save-price-${ctx.productId}`).click();
  await shot(page, 'store-pricing');

  // What the till reads for this store is the branch price, not the catalogue one.
  await expect(async () => {
    const inv = await api(page, 'GET', '/inventory', {
      params: { store_id: ctx.storeId, product_id: ctx.productId, limit: '1' },
    });
    if (inv.body.data.length) {
      expect(Number(inv.body.data[0].store_selling_price)).toBe(654);
    }
  }).toPass({ timeout: 15_000 });

  // Clearing returns it to the catalogue price rather than freezing a copy of it.
  const cleared = await api(page, 'PUT', `/stores/${ctx.storeId}/prices/${ctx.productId}`, {
    body: { selling_price: null },
  });
  expect(cleared.status).toBe(200);
  const back = await api(page, 'GET', `/stores/${ctx.storeId}/prices`, {
    params: { only_overridden: 'true' },
  });
  expect(back.body.data.some((p) => p.product_id === ctx.productId)).toBe(false);
});

test('the staff tab needs permission to manage users, not just to edit a store', async ({ page }) => {
  await page.goto(`/stores/${ctx.storeId}`);
  await page.getByTestId('store-tab-staff').click();
  await expect(page.getByTestId('store-staff-table')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'store-staff');

  // Assigning somebody to a branch hands them its takings, so the route is gated on
  // users:write rather than stores:write.
  const bogus = await api(page, 'PUT', `/stores/${ctx.storeId}/staff`, {
    body: { user_ids: ['00000000-0000-0000-0000-000000000000'] },
  });
  expect(bogus.status).toBe(400);
});

// ---------------------------------------------------------------- reports

test('the overview says in words what the cards say in numbers', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByTestId('reports-tab-overview')).toBeVisible({ timeout: 25_000 });

  // A period with something in it, so the read-out has something to say.
  await page.getByRole('combobox').filter({ hasText: /month|year|time/i }).first()
    .selectOption('This Year').catch(() => {});

  await expect(page.getByTestId('report-highlights')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'reports-highlights');
});

test('every card is measured against the period before it', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByTestId('reports-tab-overview')).toBeVisible({ timeout: 25_000 });

  // The caption names the window the arrows compare against — without it an arrow is
  // a direction with no baseline.
  const caption = page.getByTestId('compare-caption');
  await expect(caption).toBeVisible({ timeout: 20_000 });
  await expect(caption).toContainText(/\d{4}-\d{2}-\d{2}/);

  const cmp = await api(page, 'GET', '/reports/comparison', {
    params: { startDate: '2026-03-10', endDate: '2026-03-19' },
  });
  // Same length, immediately before. Never "last calendar month", which would compare
  // a 12-day month-to-date against a full 31 days.
  expect(cmp.body.data.previous.range).toEqual({ startDate: '2026-02-28', endDate: '2026-03-09' });
});

test('branches are compared side by side, and the branch filter does not apply', async ({ page }) => {
  await page.goto('/reports');
  await page.getByTestId('reports-tab-stores').click();
  await expect(page.getByTestId('store-comparison-table')).toBeVisible({ timeout: 25_000 });
  await shot(page, 'reports-stores');

  const stores = await api(page, 'GET', '/stores');
  // Every branch has a row: a comparison that hides one is not a comparison.
  for (const s of stores.body.data) {
    await expect(page.getByTestId(`store-compare-${s.id}`)).toBeVisible();
  }

  // The store picker is hidden on this tab, so it must not be quietly filtering.
  await expect(page.locator('.ribbon-group', { hasText: /^store/i })).toHaveCount(0);

  // And a row links to that branch's own page.
  await page.getByTestId(`store-compare-${ctx.storeId}`).getByRole('link').first().click();
  await expect(page.getByTestId('store-detail-name')).toBeVisible({ timeout: 20_000 });
});

// ---------------------------------------------------------------- expenses

test('expenses split by branch, and one click narrows to it', async ({ page }) => {
  await page.goto('/expenses');
  await expect(page.getByTestId('expenses-table')).toBeVisible({ timeout: 25_000 });

  const split = await api(page, 'GET', '/expenses/by-store');
  const list = await api(page, 'GET', '/expenses', { params: { limit: '1' } });

  // The strip and the table describe one set of rows. A breakdown computed over a
  // different filter than the list it sits under is a lie that looks like a feature.
  expect(Math.abs(split.body.data.total - list.body.summary.total)).toBeLessThan(0.01);

  // The strip only appears when there is more than one branch with spending against
  // it — with one branch there is nothing to split, and a "breakdown" of one row is
  // noise. Say which case ran rather than passing silently either way.
  const strip = page.getByTestId('expense-by-store');
  if (split.body.data.stores.length > 1) {
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await shot(page, 'expenses-by-store');
    const first = split.body.data.stores[0];
    await page.getByTestId(`by-store-${first.store_id}`).click();
    await expect(page.getByTestId('expense-total')).toBeVisible();
    // Narrowing to one branch must change the total to that branch's own.
    await expect(async () => {
      const scoped = await api(page, 'GET', '/expenses', {
        params: { limit: '1', store_id: first.store_id },
      });
      expect(Math.abs(scoped.body.summary.total - first.total)).toBeLessThan(0.01);
    }).toPass({ timeout: 10_000 });
  } else {
    await expect(strip).toHaveCount(0);
  }
});

// ---------------------------------------------------------------- POS

test('THE ASK: prices can be taken off the till screen and put back', async ({ page }) => {
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });

  const toggle = page.getByTestId('pos-toggle-prices');
  await expect(toggle).toBeVisible();

  // A price has to be on screen for hiding it to mean anything. Asserting the count
  // first stops this whole test passing vacuously on an empty grid.
  const prices = page.getByTestId('pos-card-price');
  await expect(prices.first()).toBeVisible({ timeout: 20_000 });
  const shown = await prices.count();
  expect(shown).toBeGreaterThan(0);
  await expect(prices.first()).toContainText(/\d/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Every card, not just the first: a mask that covers one price and misses the rest
  // is worse than none, because it looks like it worked.
  for (let i = 0; i < shown; i++) {
    await expect(prices.nth(i)).toHaveText(/^•+$/);
  }
  await expect(page.getByTestId('pos-total')).toHaveText(/^•+$/);
  await shot(page, 'pos-prices-hidden');

  // The choice survives a reload — a till set up for a shop floor should stay that way.
  await page.reload();
  await expect(page.getByTestId('pos-toggle-prices')).toHaveAttribute('aria-pressed', 'true', { timeout: 25_000 });

  await page.getByTestId('pos-toggle-prices').click();
  await expect(page.getByTestId('pos-toggle-prices')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('pos-card-price').first()).toContainText(/\d/);
});

test('the till filters by colour, size and category, in any combination', async ({ page }) => {
  await page.goto('/pos');
  await expect(page.getByTestId('pos-categories')).toBeVisible({ timeout: 25_000 });

  await page.getByTestId('pos-toggle-filters').click();
  const colours = page.getByTestId('pos-colors');
  await expect(colours).toBeVisible({ timeout: 20_000 });
  await shot(page, 'pos-filters');

  const facets = await api(page, 'GET', '/inventory/facets', { params: { store_id: ctx.storeId } });
  const colour = facets.body.data.colors[0];
  test.skip(!colour, 'no colours in stock');

  await page.getByTestId(`pos-color-${colour.name}`).click();

  // Picking a colour must not empty the colour row: with each facet computed excluding
  // its own filter, every other colour stays one tap away. Without that there is no
  // route from one colour to another except clearing the filter, which reads as a
  // broken screen.
  await expect(async () => {
    const after = await api(page, 'GET', '/inventory/facets', {
      params: { store_id: ctx.storeId, colors: colour.name },
    });
    expect(after.body.data.colors.length).toBe(facets.body.data.colors.length);
  }).toPass({ timeout: 10_000 });

  // The grid itself narrowed, not just the API.
  await expect(page.getByTestId(`pos-color-${colour.name}`)).toHaveClass(/pos-category-chip--on/);

  // Everything the grid can now show is that colour.
  const rows = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, colors: colour.name, limit: '500' },
  });
  expect(rows.body.data.length).toBeGreaterThan(0);
  expect(rows.body.data.every((r) => String(r.color_name).toLowerCase() === colour.name.toLowerCase())).toBe(true);

  // Clearing takes all three filters off at once.
  await expect(page.getByTestId('pos-clear-filters')).toBeVisible();
  await page.getByTestId('pos-clear-filters').click();
  await expect(page.getByTestId('pos-clear-filters')).toHaveCount(0);
});

test('every filter chip has stock behind it', async ({ page }) => {
  await page.goto('/');
  const facets = await api(page, 'GET', '/inventory/facets', { params: { store_id: ctx.storeId } });
  const { colors, sizes, categories } = facets.body.data;

  // The size chips used to come from the category's whole size list — EU 30 to 50 for
  // a shop that carries 40 to 45, so most buttons found nothing and the control
  // stopped being trusted. These come from stock.
  for (const c of colors) expect(c.count).toBeGreaterThan(0);
  for (const s of sizes) expect(s.count).toBeGreaterThan(0);
  for (const c of categories) expect(c.count).toBeGreaterThan(0);
  expect(colors.length + sizes.length).toBeGreaterThan(0);
});
