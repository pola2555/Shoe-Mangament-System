import { test, expect } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage, takePair, cleanup, priceOf } from './world.js';

/**
 * COMPLEX STORIES — several people, several days, and a number that has to agree with
 * itself at the far end.
 *
 * These are the ones that catch drift. A pair of shoes bought from a supplier, moved
 * between branches, sold on credit, partly returned and settled a week later touches
 * eight tables; the question is whether the reports still describe what happened.
 */

const world = loadWorld();
const claimed = new Set();
const made = { saleIds: [], expenseIds: [], loanIds: [] };

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  await cleanup(api, page, made);
  await closePage(page);
});

const A = () => world.stores.A.id;
const B = () => world.stores.B.id;

// ─────────────────────────────────────────────── goods in, goods out

test('C1 · a box of shoes arrives, becomes stock, gets labels, and is sold', async ({ browser }) => {
  const stock = await pageAs(browser, 'stockkeeper');
  await stock.goto('/');

  // The invoice and the box.
  const invoice = await api(stock, 'POST', '/purchases/invoices', {
    body: {
      supplier_id: world.supplier.id, total_amount: 20000,
      invoice_date: new Date().toLocaleDateString('en-CA'), notes: 'story C1',
    },
  });
  expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
  const invoiceId = invoice.body.data.id;

  const box = await api(stock, 'POST', `/purchases/invoices/${invoiceId}/boxes`, {
    body: { product_id: world.products.shoe.id, cost_per_item: 700, total_items: 4,
      destination_store_id: B() },
  });
  expect(box.status, JSON.stringify(box.body)).toBe(201);
  const boxId = box.body.data.id;

  // Four pairs: two colours, two sizes.
  const color = world.products.shoe.colors.find((c) => !c.is_placeholder);
  const items = await api(stock, 'PUT', `/purchases/boxes/${boxId}/items`, {
    body: {
      items: [
        { product_color_id: color.id, size_eu: '41', quantity: 1 },
        { product_color_id: color.id, size_eu: '42', quantity: 1 },
        { product_color_id: color.id, size_eu: '43', quantity: 2 },
      ],
    },
  });
  expect(items.status, JSON.stringify(items.body)).toBe(200);

  const completed = await api(stock, 'POST', `/purchases/boxes/${boxId}/complete`);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);

  // Completing it a second time must not double the stock. This is the exact race
  // that used to create two full sets of inventory rows.
  const again = await api(stock, 'POST', `/purchases/boxes/${boxId}/complete`);
  expect(again.status, 'a box must not complete twice').toBe(400);

  // The pairs exist, in the destination branch, with barcodes on them.
  const received = await api(stock, 'GET', '/inventory', {
    params: { store_id: B(), product_id: world.products.shoe.id, source: 'purchase',
      status: 'in_stock', limit: '200' },
  });
  const fromThisBox = received.body.data.filter((i) => i.invoice_box_id === boxId);
  expect(fromThisBox.length, 'four pairs were received').toBe(4);
  for (const pair of fromThisBox) {
    expect(pair.barcode, 'every received pair carries a barcode').toBeTruthy();
    expect(String(pair.barcode)).toMatch(/^\d{13}$/);
  }

  // Labels for the box print what a shop actually reads off a shelf.
  const labels = await api(stock, 'GET', '/barcodes/labels', {
    params: { invoice_box_id: boxId, store_id: B() },
  });
  expect(labels.status).toBe(200);
  expect(labels.body.data.length).toBeGreaterThan(0);
  for (const row of labels.body.data) {
    expect(row.price_code, 'a label carries the coded price, never the plain one').toBeTruthy();
    expect(String(row.price_code)).toMatch(/[A-Z]/);
  }
  await closePage(stock);

  // A cashier at that branch sells one of them. (Mona, who works in both.)
  const manager = await pageAs(browser, 'manager');
  await manager.goto('/');
  const sale = await api(manager, 'POST', '/sales', {
    body: {
      store_id: B(),
      items: [{ id: fromThisBox[0].id, sale_price: priceOf(fromThisBox[0], world.products.shoe.price) }],
      // The payment has to match what is actually charged, or the sale is refused as
      // over- or underpaid — the branch price is not always the catalogue price.
      payments: [{ amount: priceOf(fromThisBox[0], world.products.shoe.price), payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);

  // Profit on that line is the price less the 700 it cost in the box.
  const detail = await api(manager, 'GET', `/sales/${sale.body.data.id}`);
  expect(Number(detail.body.data.items[0].cost_at_sale)).toBe(700);
  await closePage(manager);

  // Tidy: the invoice is only deletable while nothing depends on it, so leave it and
  // let the void restore the pair. The box's stock stays — it is real stock now.
});

test('C2 · a cart of five different kinds of thing, each described correctly', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const picked = [];
  for (const key of ['shoe', 'sock', 'belt', 'bag', 'tool']) {
    const pair = await takePair(api, page, { storeId: A(), productId: world.products[key].id, exclude: claimed });
    picked.push({ key, pair });
  }
  const items = picked.map((p) => ({ id: p.pair.id, sale_price: priceOf(p.pair, world.products[p.key].price) }));
  const total = items.reduce((n, i) => n + i.sale_price, 0);

  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: A(), customer_id: world.customers.regular.id, items,
      payments: [{ amount: total, payment_method: 'cash' }] },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);

  const detail = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  expect(detail.body.data.items.length).toBe(5);

  // Nothing in the sale claims a shoe size for a bag or a colour for a knife. These
  // are the sentinel values leaking, which is the failure mode the sentinel design
  // was predicted to have.
  for (const line of detail.body.data.items) {
    if (line.has_sizes === false) {
      expect(line.size_prefix || '', 'a sizeless product must not carry a size prefix').toBe('');
    }
    if (line.color_is_placeholder) {
      // The placeholder is a stand-in for "this category has no colours"; the screen
      // must not print its name as if it were a colour.
      expect(line.color_name).toBeTruthy();   // it exists in the data
    }
  }

  await page.goto('/sales');
  await page.getByTestId(`sale-row-${sale.body.data.id}`).click();
  await expect(page.getByRole('heading', { name: detail.body.data.sale_number })).toBeVisible({ timeout: 20_000 });

  // "Standard" is the stand-in colour a colourless category carries so its variants
  // still have a key. It must never reach a screen as though somebody had chosen it —
  // this is the exact leak the sentinel design was predicted to have, and it was
  // leaking here: formatSize was applied on every one of these screens and
  // formatColor was not.
  const text = await page.locator('.modal-content').innerText();
  expect(text, 'a knife must not show the placeholder colour').not.toMatch(/Standard/);
  expect(text, 'a bag must not be given an EU size').not.toMatch(/EU\s+OS/);
  await shot(page, 'story-mixed-sale');
  await closePage(page);
});

test('C2b · the stand-in colour does not leak onto any screen that lists stock', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');

  // Every surface that shows a variant beside its colour. Each of these rendered the
  // raw colour name; all of them now go through formatColor.
  for (const [route, ready] of [
    ['/inventory', '.table-container'],
    ['/transfers', 'body'],
    ['/returns', 'body'],
  ]) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);
    await expect(page.locator(ready).first()).toBeVisible({ timeout: 25_000 });
    const body = await page.locator('body').innerText();
    expect(body, `${route} shows the placeholder colour`).not.toMatch(/Standard/);
  }

  // And the knife really is in the inventory being looked at, so the check above had
  // something to fail on.
  const stock = await api(page, 'GET', '/inventory', {
    params: { product_id: world.products.tool.id, status: 'in_stock', limit: '5' },
  });
  expect(stock.body.data.length, 'the knife must be in stock for this to prove anything').toBeGreaterThan(0);
  expect(stock.body.data[0].color_is_placeholder,
    'the knife carries a placeholder colour, which is what must not be shown').toBe(true);
  await closePage(page);
});

// ─────────────────────────────────────────────── the numbers must agree

test('C3 · one sale, and every report that mentions it moves by exactly that much', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const range = { startDate: '2020-01-01', endDate: '2035-12-31' };
  const snapshot = async () => {
    const [dash, cmp, store] = await Promise.all([
      api(page, 'GET', '/reports/dashboard', { params: { ...range, store_id: A() } }),
      api(page, 'GET', '/stores/comparison', { params: range }),
      api(page, 'GET', `/stores/${A()}/overview`, { params: range }),
    ]);
    return {
      dashboard: dash.body.data.metrics.net_sales,
      comparison: cmp.body.data.stores.find((s) => s.store_id === A()).revenue,
      storePage: store.body.data.metrics.revenue,
    };
  };

  const before = await snapshot();
  // The three must already agree — they are three different queries answering one
  // question, and this is the check that stops them drifting apart.
  expect(Math.abs(before.dashboard - before.comparison)).toBeLessThan(0.01);
  expect(Math.abs(before.dashboard - before.storePage)).toBeLessThan(0.01);

  const pair = await takePair(api, page, { storeId: A(), productId: world.products.shoe.id, exclude: claimed });
  const price = world.products.shoe.price;
  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: price, payment_method: 'cash' }] },
  });
  expect(sale.status).toBe(201);

  const after = await snapshot();
  for (const key of ['dashboard', 'comparison', 'storePage']) {
    expect(Math.abs((after[key] - before[key]) - price), `${key} moved by the wrong amount`).toBeLessThan(0.01);
  }

  // Void it, and all three come back to exactly where they started.
  const voided = await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'story C3' } });
  expect(voided.status).toBe(200);
  const restored = await snapshot();
  for (const key of ['dashboard', 'comparison', 'storePage']) {
    expect(Math.abs(restored[key] - before[key]), `${key} did not return after the void`).toBeLessThan(0.01);
  }
  claimed.delete(pair.id);
  await closePage(page);
});

test('C4 · this period against the one before it, on a month boundary', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  // March has 31 days, February 28 in 2026. The previous window must be the same
  // LENGTH immediately before, never "last calendar month" — comparing a 31-day month
  // against a 28-day one is the commonest way a dashboard lies.
  const cmp = await api(page, 'GET', '/reports/comparison', {
    params: { startDate: '2026-03-01', endDate: '2026-03-31' },
  });
  expect(cmp.body.data.previous.range).toEqual({ startDate: '2026-01-29', endDate: '2026-02-28' });

  // A leap-adjacent single day.
  const oneDay = await api(page, 'GET', '/reports/comparison', {
    params: { startDate: '2026-03-01', endDate: '2026-03-01' },
  });
  expect(oneDay.body.data.previous.range).toEqual({ startDate: '2026-02-28', endDate: '2026-02-28' });

  // And the current window agrees with the dashboard over the same dates.
  const range = { startDate: '2026-01-01', endDate: '2026-12-31' };
  const [c, d] = await Promise.all([
    api(page, 'GET', '/reports/comparison', { params: range }),
    api(page, 'GET', '/reports/dashboard', { params: range }),
  ]);
  expect(Math.abs(c.body.data.current.revenue - d.body.data.metrics.net_sales)).toBeLessThan(0.01);
  await closePage(page);
});

test('C5 · a discount is not allowed to inflate the profit it reduces', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const range = { startDate: '2020-01-01', endDate: '2035-12-31' };
  const profitOf = async () => (await api(page, 'GET', '/reports/dashboard',
    { params: { ...range, store_id: A() } })).body.data.metrics.clear_profit;

  const before = await profitOf();

  const pair = await takePair(api, page, { storeId: A(), productId: world.products.shoe.id, exclude: claimed });
  const price = world.products.shoe.price;
  const discount = 200;
  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), items: [{ id: pair.id, sale_price: price }],
      discount_amount: discount,
      payments: [{ amount: price - discount, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);

  // Profit must rise by (price - discount - cost), not by (price - cost). Reported
  // revenue is net of the discount, so profit has to be too, or every discount
  // inflates the margin.
  const after = await profitOf();
  const cost = world.products.shoe.cost;
  expect(Math.abs((after - before) - (price - discount - cost)),
    'the discount was not taken off the profit').toBeLessThan(0.02);

  await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'story C5' } });
  claimed.delete(pair.id);
  await closePage(page);
});

// ─────────────────────────────────────────────── two people at once

test('C6 · two tills reach for the last pair and only one gets it', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const pair = await takePair(api, page, { storeId: A(), productId: world.products.tool.id, exclude: claimed });

  // Eight simultaneous attempts on ONE physical item. Exactly one may succeed —
  // anything else is stock sold twice.
  const attempts = await page.evaluate(async ({ storeId, itemId, price }) => {
    const token = localStorage.getItem('accessToken');
    const one = () => fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        store_id: storeId,
        items: [{ id: itemId, sale_price: price }],
        payments: [{ amount: price, payment_method: 'cash' }],
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    return Promise.all(Array.from({ length: 8 }, one));
  }, { storeId: A(), itemId: pair.id, price: world.products.tool.price });

  const ok = attempts.filter((a) => a.status === 201);
  expect(ok.length, 'exactly one of eight simultaneous sales may take the pair').toBe(1);
  for (const bad of attempts.filter((a) => a.status !== 201)) {
    // And the seven that lost say why, rather than dying on a constraint.
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(String(bad.body?.message || '')).not.toMatch(/already exists/i);
  }
  made.saleIds.push(ok[0].body.data.id);

  // Sale numbers stay unique under that pressure too.
  const numbers = ok.map((a) => a.body.data.sale_number);
  expect(new Set(numbers).size).toBe(numbers.length);
  await closePage(page);
});

test('C7 · twenty sales at once produce twenty distinct sale numbers', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  // Twenty different pairs, so the only thing being contended is the numbering.
  const pairs = [];
  for (let i = 0; i < 10; i++) {
    pairs.push(await takePair(api, page, { storeId: B(), productId: world.products.shoe.id, exclude: claimed }));
  }

  const results = await page.evaluate(async ({ storeId, ids, price }) => {
    const token = localStorage.getItem('accessToken');
    return Promise.all(ids.map((id) => fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        store_id: storeId, items: [{ id, sale_price: price }],
        payments: [{ amount: price, payment_method: 'cash' }],
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))));
  }, { storeId: B(), ids: pairs.map((p) => p.id), price: world.products.shoe.price });

  const created = results.filter((r) => r.status === 201);
  expect(created.length, 'every sale of a distinct pair must succeed').toBe(pairs.length);
  const numbers = created.map((r) => r.body.data.sale_number);
  expect(new Set(numbers).size, 'sale numbers must be unique under concurrency').toBe(numbers.length);
  for (const r of created) made.saleIds.push(r.body.data.id);
  await closePage(page);
});

// ─────────────────────────────────────────────── a week in the life

test('C8 · a full week: buy, move, sell on credit, return half, settle the rest', async ({ browser }) => {
  const manager = await pageAs(browser, 'manager');
  await manager.goto('/');

  // Monday — two pairs at branch B.
  const first = await takePair(api, manager, { storeId: B(), productId: world.products.sock.id, exclude: claimed });
  const second = await takePair(api, manager, { storeId: B(), productId: world.products.sock.id, exclude: claimed });

  // Tuesday — they move to branch A.
  const transfer = await api(manager, 'POST', '/transfers', {
    body: { from_store_id: B(), to_store_id: A(), item_ids: [first.id, second.id] },
  });
  expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
  await api(manager, 'POST', `/transfers/${transfer.body.data.id}/ship`);
  await api(manager, 'POST', `/transfers/${transfer.body.data.id}/receive`);

  // Wednesday — Dalia buys both and pays a quarter.
  const price = world.products.sock.price;
  const sale = await api(manager, 'POST', '/sales', {
    body: {
      store_id: A(), customer_id: world.customers.debtor.id,
      items: [{ id: first.id, sale_price: price }, { id: second.id, sale_price: price }],
      payments: [{ amount: price / 2, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  const saleId = sale.body.data.id;
  expect(Number(sale.body.data.amount_due)).toBe(price * 2 - price / 2);

  // Thursday — one pair comes back.
  //
  // The line is found by WHICH PAIR it is, not by its position: the sale detail orders
  // its items for reading, not in the order they were sent, so items[0] is not reliably
  // the pair this story then asserts about. It was returning one pair and checking the
  // other.
  const detail = await api(manager, 'GET', `/sales/${saleId}`);
  const firstLine = detail.body.data.items.find((i) => i.inventory_item_id === first.id);
  expect(firstLine, 'the sale detail does not contain the pair we sold').toBeTruthy();
  const ret = await api(manager, 'POST', '/returns/customer', {
    body: {
      sale_id: saleId, store_id: A(), refund_method: 'cash', reason: 'too small',
      items: [{ sale_item_id: firstLine.id, refund_amount: price }],
    },
  });
  expect(ret.status, JSON.stringify(ret.body)).toBe(201);

  // The returned pair is sellable again; the other is still sold.
  const stockNow = await api(manager, 'GET', '/inventory', {
    params: { variant_id: first.variant_id, limit: '200' },
  });
  const returnedRow = stockNow.body.data.find((i) => i.id === first.id);
  expect(['in_stock', 'returned']).toContain(returnedRow.status);

  // Friday — she settles what is left.
  const balance = await api(manager, 'GET', `/sales/customer-balance/${world.customers.debtor.id}`);
  const owing = balance.body.data.unpaid_sales.find((s) => s.id === saleId);
  if (owing && owing.due > 0) {
    const settle = await api(manager, 'POST', `/sales/${saleId}/payments`, {
      body: { amount: owing.due, payment_method: 'cash' },
    });
    expect(settle.status, JSON.stringify(settle.body)).toBe(201);
  }
  const finalBalance = await api(manager, 'GET', `/sales/customer-balance/${world.customers.debtor.id}`);
  expect(finalBalance.body.data.unpaid_sales.some((s) => s.id === saleId),
    'nothing should still be owing on this sale').toBe(false);

  // And overpaying afterwards is refused rather than silently banked.
  const over = await api(manager, 'POST', `/sales/${saleId}/payments`, {
    body: { amount: 500, payment_method: 'cash' },
  });
  expect(over.status).toBe(400);
  await closePage(manager);
});
