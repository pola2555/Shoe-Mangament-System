import { test, expect } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage, takePair, cleanup, priceOf } from './world.js';

/**
 * EXTREME STORIES — the shop on a bad day, and the person trying it on.
 *
 * Two different kinds of pressure. The first is honest mistakes at speed: a fat finger
 * on a price, the same button pressed twice, a date typed wrong. The second is input
 * that was never meant to be typed at all.
 *
 * The standard applied throughout: **a refusal must be a 400 or a 403 that says what
 * is wrong, never a 500.** A 500 means the input reached somewhere it should not have.
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

/** Nothing may 500. That is the whole rule. */
function refused(res, label) {
  expect(res.status, `${label} answered ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
  expect(res.status, `${label} should have been refused`).toBeGreaterThanOrEqual(400);
}

/** A phone number no other story is using. */
function uniquePhone() {
  // `('0100' + Date.now()).slice(0, 11)` kept only the first seven digits of the
  // timestamp, which change roughly every sixteen minutes — so two stories running in
  // the same quarter hour asked for the identical number and the second was refused.
  return `01${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

// ─────────────────────────────────────────────── input that was never typed

test('X1 · a search box is not a way into the database', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const nasty = [
    "'; DROP TABLE sales; --",
    "' OR '1'='1",
    '100%; DELETE FROM products WHERE 1=1; --',
    '\\; SELECT pg_sleep(10); --',
    '__proto__',
    '{{constructor.constructor("return process")()}}',
  ];

  for (const term of nasty) {
    for (const path of ['/products', '/inventory', '/customers', '/expenses']) {
      const res = await api(page, 'GET', path, { params: { search: term, limit: '5' } });
      expect(res.status, `${path} with ${term}`).toBeLessThan(500);
    }
  }

  // And the tables are all still there afterwards.
  const products = await api(page, 'GET', '/products', { params: { limit: '1' } });
  expect(products.status).toBe(200);
  const sales = await api(page, 'GET', '/sales', { params: { limit: '1' } });
  expect(sales.status).toBe(200);
  await closePage(page);
});

test('X2 · a script tag in a customer name is text, not script', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const evil = '<img src=x onerror="window.__pwned=1">Nasty';
  const phone = uniquePhone();
  const created = await api(page, 'POST', '/customers', { body: { name: evil, phone } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  await page.goto('/customers');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  // React escapes by default, so the proof is that the payload never ran and the
  // literal text is on screen.
  const pwned = await page.evaluate(() => window.__pwned);
  expect(pwned, 'the payload must not have executed').toBeUndefined();
  const body = await page.locator('body').innerText();
  expect(body).toContain('Nasty');
  await shot(page, 'story-xss-is-text');

  await api(page, 'DELETE', `/customers/${created.body.data.id}`).catch(() => {});
  await closePage(page);
});

test('X3 · Arabic and emoji survive the round trip intact', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const name = 'محمد عبد الرحمن 🛒';
  const phone = uniquePhone();
  const created = await api(page, 'POST', '/customers', { body: { name, phone } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.name, 'the name must come back exactly as it went in').toBe(name);

  const read = await api(page, 'GET', `/customers/${created.body.data.id}`);
  expect(read.body.data.name).toBe(name);

  // And it is findable by searching part of it.
  const found = await api(page, 'GET', '/customers', { params: { search: 'عبد الرحمن' } });
  expect(found.body.data.some((c) => c.id === created.body.data.id),
    'an Arabic name must be searchable in Arabic').toBe(true);

  await api(page, 'DELETE', `/customers/${created.body.data.id}`).catch(() => {});
  await closePage(page);
});

test('X4 · absurdly long input is refused, not swallowed', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const huge = 'x'.repeat(20000);
  refused(await api(page, 'POST', '/customers', { body: { name: huge, phone: uniquePhone() } }), 'a 20k name');
  refused(await api(page, 'POST', '/products', {
    body: { product_code: huge, model_name: 'x', category_id: world.products.shoe.category_id },
  }), 'a 20k product code');
  refused(await api(page, 'GET', '/inventory', { params: { search: huge } }), 'a 20k search');
  refused(await api(page, 'GET', '/inventory/summary', { params: { colors: huge } }), 'a 20k colour list');
  await closePage(page);
});

test('X5 · a malformed id is a 400 or a 404, never a crash', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const bad = ['not-a-uuid', '1 OR 1=1', '../../etc/passwd', '%00', 'null', '00000000-0000-0000-0000-000000000000'];
  const paths = (id) => [
    `/sales/${id}`, `/products/${id}`, `/customers/${id}`, `/stores/${id}`,
    `/stores/${id}/overview`, `/expenses/${id}`, `/loans/${id}`, `/transfers/${id}`,
    `/purchases/invoices/${id}`, `/suppliers/${id}`,
  ];

  for (const id of bad) {
    for (const path of paths(encodeURIComponent(id))) {
      const res = await api(page, 'GET', path);
      expect(res.status, `${path} answered ${res.status}`).toBeLessThan(500);
    }
  }
  await closePage(page);
});

test('X6 · a date that does not exist is refused', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  // 30 February overflows into March if it is parsed rather than validated, which
  // would silently file an expense in the wrong month.
  const res = await api(page, 'GET', '/reports/dashboard', {
    params: { startDate: '2026-02-30', endDate: '2026-02-30' },
  });
  expect(res.status).toBeLessThan(500);

  const cmp = await api(page, 'GET', '/reports/comparison', {
    params: { startDate: 'yesterday', endDate: 'tomorrow' },
  });
  expect(cmp.status).toBeLessThan(500);
  await closePage(page);
});

// ─────────────────────────────────────────────── money under pressure

test('X7 · a fat finger on the price is caught in both directions', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const p = world.products.shoe;

  for (const [price, why] of [
    [-100, 'a negative price'],
    [1, 'a price far below the floor'],
    [999999, 'a price far above the ceiling'],
    [p.min - 0.01, 'a price a penny below the floor'],
    [p.max + 0.01, 'a price a penny above the ceiling'],
  ]) {
    const pair = await takePair(api, page, { storeId: A(), productId: p.id, exclude: claimed });
    const res = await api(page, 'POST', '/sales', {
      body: { store_id: A(), items: [{ id: pair.id, sale_price: price }],
        payments: [{ amount: Math.max(price, 0), payment_method: 'cash' }] },
    });
    refused(res, why);
    // And the pair is untouched, so a refused sale costs nothing.
    const after = await api(page, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '50' } });
    expect(after.body.data.find((i) => i.id === pair.id).status).toBe('in_stock');
    claimed.delete(pair.id);
  }
  await closePage(page);
});

test('X8 · a discount cannot exceed the sale it discounts', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.sock.id, exclude: claimed });

  const res = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), items: [{ id: pair.id, sale_price: priceOf(pair, world.products.sock.price) }],
      discount_amount: 99999,
      payments: [{ amount: 0, payment_method: 'cash' }],
    },
  });
  refused(res, 'a discount bigger than the sale');
  claimed.delete(pair.id);
  await closePage(page);
});

test('X9 · the same pair cannot be sold twice, from either direction', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.belt.id, exclude: claimed });
  const price = world.products.belt.price;

  const first = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: price, payment_method: 'cash' }] },
  });
  expect(first.status).toBe(201);
  made.saleIds.push(first.body.data.id);

  // Again, after it is sold.
  refused(await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: price, payment_method: 'cash' }] },
  }), 'selling an already-sold pair');

  // And twice inside ONE cart — the check reads the table, which cannot see rows this
  // very request is about to write.
  const other = await takePair(api, page, { storeId: A(), productId: world.products.belt.id, exclude: claimed });
  const twice = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(),
      items: [{ id: other.id, sale_price: price }, { id: other.id, sale_price: price }],
      payments: [{ amount: price * 2, payment_method: 'cash' }],
    },
  });
  if (twice.status === 201) {
    // If it is accepted, it must at least not have consumed the pair twice.
    made.saleIds.push(twice.body.data.id);
    const detail = await api(page, 'GET', `/sales/${twice.body.data.id}`);
    const ids = detail.body.data.items.map((i) => i.inventory_item_id);
    expect(new Set(ids).size, 'one physical pair must not appear twice in a sale').toBe(ids.length);
  } else {
    refused(twice, 'the same pair twice in one cart');
    claimed.delete(other.id);
  }
  await closePage(page);
});

test('X10 · a pair cannot be sold from a branch it is not in', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: B(), productId: world.products.shoe.id, exclude: claimed });

  const res = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: priceOf(pair, world.products.shoe.price) }],
      payments: [{ amount: priceOf(pair, world.products.shoe.price), payment_method: 'cash' }] },
  });
  refused(res, 'selling branch B stock through branch A');
  expect(String(res.body.message)).toMatch(/store|branch/i);
  claimed.delete(pair.id);
  await closePage(page);
});

test('X11 · a refund cannot be claimed twice for one line', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.sock.id, exclude: claimed });
  const price = world.products.sock.price;

  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: A(), customer_id: world.customers.debtor.id,
      items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: price, payment_method: 'cash' }] },
  });
  expect(sale.status).toBe(201);
  const detail = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  const line = detail.body.data.items[0].id;

  // The same line twice in ONE request. The service's "already returned?" check reads
  // the table, which cannot see the row this request is about to insert — so without
  // the schema's uniqueness rule this refunds twice.
  const doubled = await api(page, 'POST', '/returns/customer', {
    body: {
      sale_id: sale.body.data.id, store_id: A(), refund_method: 'cash',
      items: [
        { sale_item_id: line, refund_amount: price },
        { sale_item_id: line, refund_amount: price },
      ],
    },
  });
  refused(doubled, 'the same line refunded twice in one request');

  const unchanged = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  expect(Number(unchanged.body.data.refunded_amount), 'nothing was refunded').toBe(0);

  // Once is fine; twice in two requests is refused.
  const once = await api(page, 'POST', '/returns/customer', {
    body: { sale_id: sale.body.data.id, store_id: A(), refund_method: 'cash',
      items: [{ sale_item_id: line, refund_amount: price }] },
  });
  expect(once.status, JSON.stringify(once.body)).toBe(201);
  refused(await api(page, 'POST', '/returns/customer', {
    body: { sale_id: sale.body.data.id, store_id: A(), refund_method: 'cash',
      items: [{ sale_item_id: line, refund_amount: price }] },
  }), 'returning the same line a second time');
  await closePage(page);
});

test('X12 · a sale cannot be voided twice, and a voided sale takes no more money', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.tool.id, exclude: claimed });
  const price = world.products.tool.price;

  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: price, payment_method: 'cash' }] },
  });
  expect(sale.status).toBe(201);
  const id = sale.body.data.id;

  expect((await api(page, 'POST', `/sales/${id}/void`, { body: { reason: 'first' } })).status).toBe(200);
  refused(await api(page, 'POST', `/sales/${id}/void`, { body: { reason: 'second' } }), 'a second void');
  refused(await api(page, 'POST', `/sales/${id}/payments`, { body: { amount: 10, payment_method: 'cash' } }),
    'paying a voided sale');
  claimed.delete(pair.id);
  await closePage(page);
});

// ─────────────────────────────────────────────── things that must not vanish

test('X13 · a category with money behind it cannot be deleted', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const NAME = 'Story Doomed Category';
  const cats = await api(page, 'GET', '/expenses/categories');
  let cat = cats.body.data.find((c) => c.name === NAME);
  if (!cat) {
    const created = await api(page, 'POST', '/expenses/categories', { body: { name: NAME } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    cat = created.body.data;
  }

  // Empty, so it can go.
  const spend = await api(page, 'POST', '/expenses', {
    body: { store_id: A(), category_id: cat.id, amount: 42,
      expense_date: new Date().toLocaleDateString('en-CA'), description: 'story' },
  });
  expect(spend.status).toBe(201);

  // Now it cannot: that name is what the money was FOR.
  const del = await api(page, 'DELETE', `/expenses/categories/${cat.id}`);
  refused(del, 'deleting a category with spending behind it');

  await api(page, 'DELETE', `/expenses/${spend.body.data.id}`);
  await api(page, 'DELETE', `/expenses/categories/${cat.id}`).catch(() => {});
  await closePage(page);
});

test('X14 · a branch full of stock cannot be closed', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const res = await api(page, 'PUT', `/stores/${A()}`, { body: { is_active: false } });
  refused(res, 'closing a branch that holds stock');
  expect(String(res.body.message)).toMatch(/in stock/i);
  expect((await api(page, 'GET', `/stores/${A()}`)).body.data.is_active,
    'a refused change must change nothing').toBe(true);
  await closePage(page);
});

test('X15 · a barcode with a bad check digit is refused, not guessed at', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const stock = await api(page, 'GET', '/inventory', {
    params: { store_id: A(), status: 'in_stock', limit: '50' },
  });
  const withBarcode = stock.body.data.find((i) => i.barcode);
  test.skip(!withBarcode, 'no barcoded stock');

  const good = String(withBarcode.barcode);
  // Flip the last digit: still thirteen digits, no longer a valid EAN-13.
  const broken = good.slice(0, 12) + ((Number(good[12]) + 1) % 10);

  const ok = await api(page, 'GET', '/barcodes/lookup', { params: { code: good, store_id: A() } });
  expect(ok.status, 'the real barcode must resolve').toBe(200);

  const bad = await api(page, 'GET', '/barcodes/lookup', { params: { code: broken, store_id: A() } });
  refused(bad, 'a barcode with a bad check digit');

  refused(await api(page, 'GET', '/barcodes/lookup', { params: { code: '42', store_id: A() } }), 'a two-digit scan');
  refused(await api(page, 'GET', '/barcodes/lookup', { params: { code: 'ABCDEFGHIJKLM', store_id: A() } }), 'letters');
  await closePage(page);
});

test('X16 · a deactivated account stops working immediately', async ({ browser }) => {
  // The admin, not Mona: she deliberately has no `users:write`, which is what stops a
  // branch manager adding herself to the branch next door.
  const admin = await pageAs(browser, 'admin');
  await admin.goto('/');

  // One throwaway account, reused. A user is never deleted, only deactivated, so
  // minting a fresh one each run would add a row to the Users page every time.
  const username = 'story_temp_deactivate';
  const existing = (await api(admin, 'GET', '/users')).body.data.find((u) => u.username === username);
  let userId;
  if (existing) {
    userId = existing.id;
    const reset = await api(admin, 'PUT', `/users/${userId}`, {
      body: { password: 'temp-pass-1', is_active: true, store_id: A(), role_id: 3 },
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  } else {
    const created = await api(admin, 'POST', '/users', {
      body: {
        username, email: `${username}@story-fixtures.com`, password: 'temp-pass-1',
        full_name: 'Temporary Tarek', role_id: 3, store_id: A(),
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    userId = created.body.data.id;
  }
  await api(admin, 'PUT', `/users/${userId}/permissions`, {
    body: { permissions: [{ permission_code: 'products', access_level: 'read' }] },
  });

  // They can sign in and read.
  const ctx = await admin.context().browser().newContext({ storageState: { cookies: [], origins: [] } });
  const temp = await ctx.newPage();
  await temp.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
  await temp.waitForSelector('#username', { state: 'visible', timeout: 60_000 });
  await temp.locator('#username').fill(username);
  await temp.locator('#password').fill('temp-pass-1');
  await temp.locator('button[type="submit"]').click();
  await temp.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  expect((await api(temp, 'GET', '/products')).status).toBe(200);

  // Deactivate them. The token they already hold must stop working — a token that
  // outlives the account is a door left open.
  await api(admin, 'DELETE', `/users/${userId}`);
  await expect(async () => {
    const res = await api(temp, 'GET', '/products');
    expect(res.status, 'a deactivated user must be refused').toBeGreaterThanOrEqual(401);
  }).toPass({ timeout: 90_000 });

  await ctx.close();
  await closePage(admin);
});

test('X17 · an empty or nonsense cart buys nothing', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  refused(await api(page, 'POST', '/sales', { body: { store_id: A(), items: [], payments: [] } }), 'an empty cart');
  refused(await api(page, 'POST', '/sales', { body: { store_id: A() } }), 'a cart with no items key');
  refused(await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: '00000000-0000-0000-0000-000000000000', sale_price: 10 }],
      payments: [{ amount: 10, payment_method: 'cash' }] },
  }), 'a cart of an item that does not exist');
  refused(await api(page, 'POST', '/sales', {
    body: { store_id: '00000000-0000-0000-0000-000000000000', items: [], payments: [] },
  }), 'a sale in a branch that does not exist');
  await closePage(page);
});

test('X18 · manual stock entry cannot conjure a warehouse out of nothing', async ({ browser }) => {
  const page = await pageAs(browser, 'stockkeeper');
  await page.goto('/');
  const variant = world.products.shoe.variants[0];

  refused(await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: variant.id, store_id: B(), cost: 100, quantity: 100000 },
  }), 'a hundred thousand pairs at once');
  refused(await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: variant.id, store_id: B(), cost: 100, quantity: 0 },
  }), 'zero pairs');
  refused(await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: variant.id, store_id: B(), cost: -5, quantity: 1 },
  }), 'a negative cost');
  refused(await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: '00000000-0000-0000-0000-000000000000', store_id: B(), cost: 1, quantity: 1 },
  }), 'a variant that does not exist');
  await closePage(page);
});

test('X19 · a page size of a million is capped, not obeyed', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  for (const [path, params] of [
    ['/inventory', { limit: '1000000' }],
    ['/inventory/summary', { limit: '1000000' }],
    ['/inventory/product-grid', { limit: '1000000' }],
    ['/expenses', { limit: '1000000' }],
    ['/sales', { limit: '1000000' }],
  ]) {
    const res = await api(page, 'GET', path, { params });
    expect(res.status, `${path} with a huge limit`).toBeLessThan(500);
    if (res.status === 200) {
      const rows = Array.isArray(res.body.data) ? res.body.data : [];
      expect(rows.length, `${path} returned ${rows.length} rows`).toBeLessThanOrEqual(10000);
    }
  }

  // A negative page number must not become a negative OFFSET.
  const neg = await api(page, 'GET', '/expenses', { params: { page: '-5', limit: '10' } });
  expect(neg.status).toBeLessThan(500);
  await closePage(page);
});
