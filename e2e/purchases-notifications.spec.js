import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Receiving stock that is not a shoe, re-using what was received last time, and the
 * notification history.
 *
 * The box editor asked for an "EU" size with US/UK/CM columns whatever the product
 * was, and its generator counted whole numbers — so a sock box could not be entered at
 * all. It also asked for the same cost, count and size run every single time the same
 * product came in.
 */

const MARK = 'E2E-PN';
let ctx = { storeId: null, supplierId: null, sockProductId: null, bagProductId: null, invoiceId: null };

test.describe.configure({ mode: 'serial' });

/**
 * A product for this spec to receive stock against — reused across runs.
 *
 * It used to mint a new one every run with a timestamp in the code, and a product can
 * never be deleted (RESTRICT everywhere), so each run left two more behind. They also
 * never gain variants, because their boxes are deliberately never completed — and a
 * variant-less product sitting at the top of "newest first" broke a barcode test that
 * took whichever product came back first. Two junk rows per run is not free.
 */
async function makeProduct(page, categoryCode, name) {
  const code = `${MARK}-${categoryCode}`.slice(0, 40);
  const existing = await api(page, 'GET', '/products', { params: { search: code } });
  const found = (existing.body.data || []).find((p) => p.product_code === code);
  if (found) return found.id;

  const cats = await api(page, 'GET', '/product-categories');
  const cat = cats.body.data.find((c) => c.code === categoryCode);
  const res = await api(page, 'POST', '/products', {
    body: {
      product_code: code,
      model_name: name, category_id: cat.id, default_selling_price: 80,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (cat.has_colors) {
    await api(page, 'POST', `/products/${res.body.data.id}/colors`, { body: { color_name: 'Plain' } });
  }
  return res.body.data.id;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = stores.body.data[0].id;
  const suppliers = await api(page, 'GET', '/suppliers');
  ctx.supplierId = suppliers.body.data[0]?.id;

  ctx.sockProductId = await makeProduct(page, 'socks', 'flow socks');
  ctx.bagProductId = await makeProduct(page, 'bags', 'flow bag');

  if (ctx.supplierId) {
    const inv = await api(page, 'POST', '/purchases/invoices', {
      body: {
        supplier_id: ctx.supplierId, total_amount: 100000,
        invoice_date: '2026-09-01', notes: `${MARK} flow`,
      },
    });
    if (inv.status === 201) ctx.invoiceId = inv.body.data.id;
  }
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  if (ctx.invoiceId) await api(page, 'DELETE', `/purchases/invoices/${ctx.invoiceId}`).catch(() => {});
  await page.close();
});

// ---------------------------------------------------------------- box entry

test('THE BUG: a sock box asks for sock sizes, not EU shoe sizes', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier to raise an invoice against');
  await page.goto('/');

  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.sockProductId, cost_per_item: 20, total_items: 6, destination_store_id: ctx.storeId },
  });
  expect(box.status, JSON.stringify(box.body)).toBe(201);

  await page.goto(`/purchases/${ctx.invoiceId}`);
  await page.getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();

  const picker = page.getByTestId('size-run-picker');
  await expect(picker).toBeVisible({ timeout: 20_000 });

  // A word-based size list gets chips, never a from/to range: "38 to 45" cannot
  // express Kids, Teens and Adults.
  await expect(picker.getByTestId('run-chips')).toBeVisible();
  await expect(picker.getByTestId('run-start')).toHaveCount(0);
  await expect(picker.getByTestId('run-chips')).toContainText(/kids/i);

  // And no US/UK/CM columns: a sock has no US size.
  await expect(page.locator('th', { hasText: /^US$/ })).toHaveCount(0);
  await shot(page, 'box-socks');
});

test('a bag box has no size column at all', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.bagProductId, cost_per_item: 50, total_items: 4, destination_store_id: ctx.storeId },
  });
  expect(box.status).toBe(201);

  await page.goto(`/purchases/${ctx.invoiceId}`);
  const rows = page.locator('.card', { hasText: 'flow bag' });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();

  // Nothing to generate when there is nothing to size.
  await expect(page.getByTestId('size-run-picker')).toHaveCount(0);
  await shot(page, 'box-bag');
});

// ---------------------------------------------------------------- suggestions

test('the last box of a product is offered back', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const suggestion = await api(page, 'GET', '/purchases/boxes/suggestion', {
    params: { product_id: ctx.sockProductId },
  });
  expect(suggestion.status).toBe(200);
  expect(suggestion.body.data, 'a product with a box should have a suggestion').toBeTruthy();
  expect(parseFloat(suggestion.body.data.cost_per_item)).toBe(20);
  expect(suggestion.body.data.total_items).toBe(6);

  const none = await api(page, 'GET', '/purchases/boxes/suggestion', {
    params: { product_id: '00000000-0000-0000-0000-000000000000' },
  });
  expect(none.status).toBe(200);
  expect(none.body.data).toBeNull();
});

test('a box can be duplicated, items and all, without inventing stock', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const boxes = await api(page, 'GET', `/purchases/invoices/${ctx.invoiceId}`);
  const original = boxes.body.data.boxes.find((b) => b.product_id === ctx.sockProductId);
  expect(original).toBeTruthy();

  const copy = await api(page, 'POST', `/purchases/boxes/${original.id}/duplicate`);
  expect(copy.status, JSON.stringify(copy.body)).toBe(201);
  expect(copy.body.data.detail_status).not.toBe('complete');
  expect(parseFloat(copy.body.data.cost_per_item)).toBe(parseFloat(original.cost_per_item));
  expect(copy.body.data.total_items).toBe(original.total_items);

  await api(page, 'DELETE', `/purchases/boxes/${copy.body.data.id}`);
});

// ---------------------------------------------------------------- notifications

test('the bell can be cleared without losing the history', async ({ page }) => {
  await page.goto('/');

  const before = await api(page, 'GET', '/notifications/history', { params: { limit: '5' } });
  expect(before.status).toBe(200);
  expect(before.body).toHaveProperty('pagination');

  const cleared = await api(page, 'POST', '/notifications/clear');
  expect(cleared.status).toBe(200);

  const unread = await api(page, 'GET', '/notifications');
  expect(unread.body.data.length).toBe(0);

  // Clearing archives; it does not delete. Anything that was there is still findable.
  const after = await api(page, 'GET', '/notifications/history', { params: { limit: '100' } });
  expect(after.body.pagination.total).toBeGreaterThanOrEqual(before.body.pagination.total);
});

test('history filters by date, and deleting needs a range', async ({ page }) => {
  await page.goto('/');

  const future = await api(page, 'GET', '/notifications/history', { params: { from: '2099-01-01' } });
  expect(future.body.pagination.total).toBe(0);

  // The only call that loses anything refuses to run without being told what to lose.
  const unbounded = await api(page, 'DELETE', '/notifications');
  expect(unbounded.status).toBe(400);
  expect(JSON.stringify(unbounded.body)).toMatch(/date range/i);
});

test('the notifications panel shows history with date filters', async ({ page }) => {
  await page.goto('/');
  await page.locator('.sidebar__bell').click();
  await expect(page.getByTestId('notif-tab-history')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('notif-tab-history').click();
  await expect(page.getByTestId('notif-from')).toBeVisible();
  await expect(page.getByTestId('notif-to')).toBeVisible();
  await expect(page.getByTestId('notif-delete-range')).toBeDisabled();
  await shot(page, 'notifications-history');
});

// ---------------------------------------------------------------- sidebar

test('sidebar groups collapse, persist, and reopen on the active page', async ({ page }) => {
  await page.goto('/');
  const group = page.getByTestId('sidebar-group-sidebar.purchases_finance');
  await expect(group).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('link', { name: /suppliers/i })).toBeVisible();
  await group.click();
  await expect(page.getByRole('link', { name: /suppliers/i })).toHaveCount(0);

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: /suppliers/i })).toHaveCount(0);
  await shot(page, 'sidebar-collapsed-group');

  // But a collapsed group can never hide the page you are actually on.
  await page.goto('/expenses');
  await expect(page.getByRole('link', { name: /expenses/i })).toBeVisible({ timeout: 15_000 });
});
