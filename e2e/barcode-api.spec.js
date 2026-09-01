import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Contract-level checks for the barcode endpoints, driven through the browser so the
 * real auth token, the real store scoping and the real permission middleware are all
 * in play — not a bypassed service call.
 */

let ctx = {};

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const stores = await api(page, 'GET', '/stores');
  ctx.stores = stores.body.data;

  // Pick a variant that genuinely has stock, and note which store holds it.
  const inv = await api(page, 'GET', '/inventory', {
    params: { status: 'in_stock', limit: '200' },
  });
  const withBarcode = inv.body.data.filter((i) => i.barcode);
  expect(withBarcode.length, 'inventory must contain barcoded stock').toBeGreaterThan(0);

  ctx.item = withBarcode[0];
  ctx.storeId = ctx.item.store_id;
  ctx.barcode = ctx.item.barcode;
  ctx.page = page;
});

test.afterAll(async () => { await ctx.page?.close(); });

test('every in-stock variant carries a valid EAN-13', async () => {
  const inv = await api(ctx.page, 'GET', '/inventory', { params: { status: 'in_stock', limit: '500' } });
  const rows = inv.body.data;

  const check = (code) => {
    if (!/^[0-9]{13}$/.test(code)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === Number(code[12]);
  };

  const missing = rows.filter((r) => !r.barcode);
  const invalid = rows.filter((r) => r.barcode && !check(r.barcode));

  expect(missing, `variants without a barcode: ${missing.map((m) => m.sku).join(', ')}`).toHaveLength(0);
  expect(invalid, `variants with a bad check digit: ${invalid.map((m) => m.sku).join(', ')}`).toHaveLength(0);

  // One barcode must never map to two different variants.
  const bySku = new Map();
  for (const r of rows) {
    if (!bySku.has(r.barcode)) bySku.set(r.barcode, new Set());
    bySku.get(r.barcode).add(r.sku);
  }
  const collisions = [...bySku.entries()].filter(([, skus]) => skus.size > 1);
  expect(collisions, `barcode reused across variants: ${JSON.stringify(collisions)}`).toHaveLength(0);
});

test('lookup resolves a scan to a sellable pair in the right store', async () => {
  const res = await api(ctx.page, 'GET', '/barcodes/lookup', {
    params: { code: ctx.barcode, store_id: ctx.storeId },
  });
  expect(res.status).toBe(200);

  const { item, available_count } = res.body.data;
  expect(item.store_id).toBe(ctx.storeId);
  expect(item.barcode).toBe(ctx.barcode);
  expect(item.status).toBe('in_stock');
  expect(available_count).toBeGreaterThan(0);

  // Must carry everything the POS cart needs, or addToCart silently prices at 0.
  for (const field of ['id', 'sku', 'size_eu', 'color_name', 'product_name', 'default_selling_price']) {
    expect(item, `lookup payload missing ${field}`).toHaveProperty(field);
  }
});

test('rescanning the same code returns a different pair, then refuses', async () => {
  const first = await api(ctx.page, 'GET', '/barcodes/lookup', {
    params: { code: ctx.barcode, store_id: ctx.storeId },
  });
  const total = first.body.data.available_count;

  const taken = [];
  for (let i = 0; i < total; i++) {
    const r = await api(ctx.page, 'GET', '/barcodes/lookup', {
      params: { code: ctx.barcode, store_id: ctx.storeId, exclude_ids: taken.join(',') },
    });
    expect(r.status, `pair ${i + 1} of ${total} should still be available`).toBe(200);
    expect(taken, 'lookup must not hand back a pair already in the cart')
      .not.toContain(r.body.data.item.id);
    taken.push(r.body.data.item.id);
  }

  // One more than exists in stock must fail rather than oversell.
  const over = await api(ctx.page, 'GET', '/barcodes/lookup', {
    params: { code: ctx.barcode, store_id: ctx.storeId, exclude_ids: taken.join(',') },
  });
  expect(over.status).toBe(409);
  expect(over.body.message).toMatch(/already in the cart/i);
});

test('FIFO: the oldest pair is always the one offered', async () => {
  const inv = await api(ctx.page, 'GET', '/inventory', {
    params: { variant_id: ctx.item.variant_id, store_id: ctx.storeId, status: 'in_stock', limit: '200' },
  });
  const oldest = inv.body.data
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

  const res = await api(ctx.page, 'GET', '/barcodes/lookup', {
    params: { code: ctx.barcode, store_id: ctx.storeId },
  });
  expect(res.body.data.item.id).toBe(oldest.id);
});

test.describe('failure cases each give a usable message', () => {
  const cases = [
    { name: 'unknown but well-formed code', code: '2009999990001', status: [400, 404] },
    { name: 'bad check digit',              code: '2000001010823', status: [400], match: /check digit/i },
    { name: 'too short',                    code: '12345',         status: [400], match: /13|digits/i },
    { name: 'letters from a mis-set scanner', code: 'ABCDEFGHIJKLM', status: [400] },
    { name: 'empty scan',                   code: '',              status: [400] },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const res = await api(ctx.page, 'GET', '/barcodes/lookup', {
        params: { code: c.code, store_id: ctx.storeId },
      });
      expect(c.status, `got ${res.status}: ${res.body?.message}`).toContain(res.status);
      expect(res.body?.message, 'error must carry a message for the cashier').toBeTruthy();
      if (c.match) expect(res.body.message).toMatch(c.match);
    });
  }

  test('valid code with no stock in the selected store', async () => {
    // A variant stocked in exactly one store, queried against a different one.
    const inv = await api(ctx.page, 'GET', '/inventory', { params: { status: 'in_stock', limit: '500' } });
    const byVariant = new Map();
    for (const r of inv.body.data) {
      if (!byVariant.has(r.variant_id)) byVariant.set(r.variant_id, new Set());
      byVariant.get(r.variant_id).add(r.store_id);
    }
    const single = [...byVariant.entries()].find(([, s]) => s.size === 1);
    test.skip(!single || ctx.stores.length < 2, 'needs two stores and single-store stock');

    const [variantId, storeSet] = single;
    const onlyStore = [...storeSet][0];
    const otherStore = ctx.stores.find((s) => s.id !== onlyStore);
    const row = inv.body.data.find((r) => r.variant_id === variantId);

    const res = await api(ctx.page, 'GET', '/barcodes/lookup', {
      params: { code: row.barcode, store_id: otherStore.id },
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/out of stock/i);
  });
});

test('manufacturer barcode can be linked and then scanned', async () => {
  const inv = await api(ctx.page, 'GET', '/inventory', {
    params: { status: 'in_stock', limit: '200' },
  });
  const target = inv.body.data.find((i) => i.variant_id !== ctx.item.variant_id) || inv.body.data[0];
  const original = target.barcode;
  const MANUFACTURER = '5901234123457';

  try {
    const link = await api(ctx.page, 'POST', '/barcodes/link', {
      body: { variant_id: target.variant_id, barcode: MANUFACTURER },
    });
    expect(link.status).toBe(200);
    expect(link.body.data.source).toBe('manufacturer');

    // Scanning the real box barcode now resolves to our variant.
    const res = await api(ctx.page, 'GET', '/barcodes/lookup', {
      params: { code: MANUFACTURER, store_id: target.store_id },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.variant_id).toBe(target.variant_id);

    // Our own 2-prefix range must not be accepted as a manufacturer code.
    const reserved = await api(ctx.page, 'POST', '/barcodes/link', {
      body: { variant_id: target.variant_id, barcode: '2000001010822' },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.body.message).toMatch(/reserved/i);
  } finally {
    // Put the variant back exactly as it was.
    await api(ctx.page, 'DELETE', `/barcodes/${target.variant_id}`);
    await api(ctx.page, 'POST', '/barcodes/assign', { body: { variant_ids: [target.variant_id] } });
    const after = await api(ctx.page, 'GET', '/inventory', {
      params: { variant_id: target.variant_id, status: 'in_stock', limit: '5' },
    });
    expect(after.body.data[0].barcode, 'restore must reinstate the original code').toBe(original);
  }
});

test('label payloads carry a coded price and never the plain one', async () => {
  const products = await api(ctx.page, 'GET', '/products', { params: { limit: '5' } });
  const product = products.body.data[0];

  const res = await api(ctx.page, 'GET', '/barcodes/labels', {
    params: { product_id: product.id, store_id: ctx.storeId },
  });
  expect(res.status).toBe(200);
  expect(res.body.data.length).toBeGreaterThan(0);

  for (const row of res.body.data) {
    for (const f of ['barcode', 'sku', 'size_eu', 'color_name', 'product_code', 'price_code', 'stock_count']) {
      expect(row, `label row missing ${f}`).toHaveProperty(f);
    }
    if (row.price != null && row.price > 0) {
      // Reversed digits with fixed fillers -> must contain letters and must not read
      // as the plain number.
      expect(row.price_code).toMatch(/[A-Z]/);
      expect(row.price_code).not.toBe(String(Math.round(row.price)));

      const decoded = Number(row.price_code.replace(/[A-Z]/g, '').split('').reverse().join(''));
      expect(decoded, 'price code must decode back to the price').toBe(Math.round(row.price));
    }
  }
});
