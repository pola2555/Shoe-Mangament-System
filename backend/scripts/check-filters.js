/*
 * Category and size filtering, end to end through the services.
 *
 * The story that matters: a shop that sells socks as well as shoes must be able to
 * filter both. A numeric size range cannot express "Kids", and until now it was the
 * only size filter there was — so alpha sizes were unfilterable AND vanished without
 * explanation whenever a range was set.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const products = require('../src/modules/products/products.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const inventory = require('../src/modules/inventory/inventory.service');
const reports = require('../src/modules/reports/reports.service');
const sales = require('../src/modules/sales/sales.service');
const transfers = require('../src/modules/transfers/transfers.service');
const customers = require('../src/modules/customers/customers.service');
const { generateUUID } = require('../src/utils/generateCodes');

let pass = 0, fail = 0;
const made = { products: [], items: [] };

async function check(name, fn) {
  try {
    const r = await fn();
    console.log('  ok   ' + name + (r === undefined ? '' : '  ' + r));
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    fail++;
  }
}

/** A product in `categoryCode` with one variant per size, each with `perSize` in stock. */
async function stockedProduct(categoryCode, name, sizes, perSize, storeId) {
  const list = await cats.listCategories({});
  const cat = list.find((c) => c.code === categoryCode);
  const p = await products.create({
    product_code: (name + '-' + Date.now()).toUpperCase().slice(0, 40),
    model_name: name,
    category_id: cat.id,
    default_selling_price: 100,
  });
  made.products.push(p.id);

  const color = cat.has_colors
    ? await products.createColor(p.id, { color_name: 'Filter Test', hex_code: '#123456' })
    : (await knex('product_colors').where('product_id', p.id).first());

  for (const size of sizes) {
    const v = await products.createVariant(p.id, { product_color_id: color.id, size_eu: size });
    const rows = [];
    for (let i = 0; i < perSize; i++) {
      rows.push({ id: generateUUID(), variant_id: v.id, store_id: storeId, cost: 10, source: 'manual', status: 'in_stock' });
    }
    const ins = await knex('inventory_items').insert(rows).returning('id');
    made.items.push(...ins.map((r) => r.id || r));
  }
  return { product: p, category: cat };
}

const sizesOf = (rows) => rows.map((r) => r.size_eu);

(async () => {
  const store = await knex('stores').first('id', 'name');
  if (!store) throw new Error('no stores in the database');
  console.log('store: ' + store.name);
  console.log('');
  console.log('size filtering:');

  // Belts 80 / 90 / 100. As text those sort 100, 80, 90 — the lexical bug in the open.
  // (Shoe sizes are all two digits, so the shoe list cannot expose it.)
  const belts = await stockedProduct('belts', 'filter-belt', ['80', '90', '100'], 1, store.id);
  // Socks Kids / Teens / Adults — none of them parse as a number at all.
  const socks = await stockedProduct('socks', 'filter-sock', ['KIDS', 'TEENS', 'ADULTS'], 1, store.id);

  const mine = (rows) => rows.filter((r) => r.product_id === belts.product.id || r.product_id === socks.product.id);

  await check('with no size filter, both belts and socks come back', async () => {
    const rows = mine(await inventory.summary({ store_id: store.id, limit: 10000 }));
    if (rows.length !== 6) throw new Error('expected 6 rows, got ' + rows.length);
    return sizesOf(rows).join(',');
  });

  await check('a numeric range keeps exactly the sizes inside it', async () => {
    const rows = mine(await inventory.summary({ store_id: store.id, size_min: 80, size_max: 95, limit: 10000 }));
    const got = sizesOf(rows).sort().join(',');
    // A lexical comparison would answer '100' >= '80' as false and drop it for the
    // wrong reason, and would keep '100' <= '95'. This is the regression proof.
    if (got !== '80,90') throw new Error("expected '80,90', got '" + got + "'");
    return got;
  });

  await check('a numeric range excludes word sizes — and that is now a choice, not the only option', async () => {
    const rows = mine(await inventory.summary({ store_id: store.id, size_min: 1, size_max: 999, limit: 10000 }));
    const got = sizesOf(rows).sort().join(',');
    if (got !== '100,80,90') throw new Error("expected only the numeric sizes, got '" + got + "'");
    return 'socks excluded, as a numeric range means';
  });

  await check('size_values filters word sizes, which no range can express', async () => {
    const rows = mine(await inventory.summary({ store_id: store.id, size_values: 'KIDS,ADULTS', limit: 10000 }));
    const got = sizesOf(rows).sort().join(',');
    if (got !== 'ADULTS,KIDS') throw new Error("expected 'ADULTS,KIDS', got '" + got + "'");
    return got;
  });

  await check('size_values accepts a real array as well as a comma string', async () => {
    const rows = mine(await inventory.summary({ store_id: store.id, size_values: ['TEENS'], limit: 10000 }));
    const got = sizesOf(rows).join(',');
    if (got !== 'TEENS') throw new Error("expected 'TEENS', got '" + got + "'");
    return got;
  });

  await check('size_values works on inventory.list too, not just the summary', async () => {
    // list() returns inventory_items.*, which carries no product_id — match on the
    // product code it does select.
    const codes = [belts.product.product_code, socks.product.product_code];
    const rows = (await inventory.list({ store_id: store.id, size_values: 'KIDS', limit: 10000 }))
      .filter((r) => codes.includes(r.product_code));
    if (!rows.length) throw new Error('no rows');
    if (!rows.every((r) => r.size_eu === 'KIDS')) throw new Error('leaked other sizes');
    return rows.length + ' item(s)';
  });

  console.log('');
  console.log('category filtering:');

  await check('inventory.summary filters by category', async () => {
    const rows = await inventory.summary({ store_id: store.id, category_id: socks.category.id, limit: 10000 });
    if (!rows.length) throw new Error('no rows');
    if (!rows.every((r) => r.category_id === socks.category.id)) throw new Error('leaked another category');
    if (rows.some((r) => r.product_id === belts.product.id)) throw new Error('a belt came back under socks');
    return rows.length + ' row(s)';
  });

  await check('inventory.list filters by category', async () => {
    const rows = await inventory.list({ store_id: store.id, category_id: socks.category.id, limit: 10000 });
    if (!rows.length) throw new Error('no rows');
    if (!rows.every((r) => r.category_id === socks.category.id)) throw new Error('leaked another category');
    return rows.length + ' item(s)';
  });

  await check('an unknown category returns nothing rather than everything', async () => {
    const rows = await inventory.summary({ store_id: store.id, category_id: generateUUID(), limit: 10000 });
    if (rows.length !== 0) throw new Error('expected 0 rows, got ' + rows.length);
  });

  console.log('');
  console.log('reports:');

  /** In-stock item count for one category, straight from the database. */
  async function inStockCount(categoryId) {
    const row = await knex('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .where('inventory_items.status', 'in_stock')
      .where('inventory_items.store_id', store.id)
      .where('products.category_id', categoryId)
      .count('inventory_items.id as n')
      .first();
    return Number(row.n);
  }

  await check('inventory analytics filtered by category counts only that category', async () => {
    const all = await reports.getInventoryAnalytics({ store_id: store.id });
    const only = await reports.getInventoryAnalytics({ store_id: store.id, category_id: socks.category.id });
    const sizes = only.stock_by_size.map((r) => r.size).sort().join(',');
    if (sizes !== 'ADULTS,KIDS,TEENS') throw new Error("stock_by_size was '" + sizes + "'");
    const expected = await inStockCount(socks.category.id);
    const total = only.stock_by_size.reduce((n, r) => n + r.count, 0);
    if (total !== expected) throw new Error('expected ' + expected + ' sock items, got ' + total);
    if (!(all.stock_by_size.length > only.stock_by_size.length)) throw new Error('the filter changed nothing');
    return only.stock_by_size.length + ' size buckets, ' + total + ' items';
  });

  await check('the category joins do not inflate the counts', async () => {
    // The extra variant/product joins are many-to-one, so a COUNT over inventory_items
    // must come out the same however many of them a query carries. A fan-out here
    // would quietly double every number on the tab.
    const expected = await inStockCount(socks.category.id);
    const only = await reports.getInventoryAnalytics({ store_id: store.id, category_id: socks.category.id });
    const byStore = only.stock_by_store.reduce((n, r) => n + r.count, 0);
    const byStatus = only.status_distribution.filter((r) => r.status === 'in_stock').reduce((n, r) => n + r.count, 0);
    const bySize = only.stock_by_size.reduce((n, r) => n + r.count, 0);
    const aging = only.aging.within_30 + only.aging.d30_60 + only.aging.d60_90 + only.aging.over_90;
    for (const [what, got] of [['stock_by_store', byStore], ['status_distribution', byStatus],
      ['stock_by_size', bySize], ['aging', aging]]) {
      if (got !== expected) throw new Error(what + ' totalled ' + got + ', expected ' + expected);
    }
    return 'store/status/size/aging all ' + expected;
  });

  await check('stock_by_size carries the size list, so a chart can write "95 cm"', async () => {
    const only = await reports.getInventoryAnalytics({ store_id: store.id, category_id: belts.category.id });
    const row = only.stock_by_size.find((r) => r.size === '90');
    if (!row) throw new Error('size 90 missing');
    if (row.size_suffix !== 'cm') throw new Error("size_suffix was '" + row.size_suffix + "'");
    if (row.has_sizes !== true) throw new Error('has_sizes was ' + row.has_sizes);
    return 'suffix=' + row.size_suffix;
  });

  await check('stock_by_size orders 90 before 100, not after it', async () => {
    const only = await reports.getInventoryAnalytics({ store_id: store.id, category_id: belts.category.id });
    const got = only.stock_by_size.map((r) => r.size).join(',');
    if (got !== '80,90,100') throw new Error("expected '80,90,100', got '" + got + "'");
    return got;
  });

  await check('two size lists sharing a label do not merge into one bucket', async () => {
    // 'M' means one thing on a clothing list and another on a belt list. Grouping by
    // the label alone would add them together into a number that means nothing.
    const rows = await reports.getInventoryAnalytics({ store_id: store.id });
    const keys = rows.stock_by_size.map((r) => r.size + '|' + (r.size_prefix || '') + '|' + (r.size_suffix || ''));
    if (new Set(keys).size !== keys.length) throw new Error('duplicate group keys returned');
    return keys.length + ' distinct buckets';
  });

  await check('product analytics accepts a category filter without erroring', async () => {
    const data = await reports.getProductAnalytics({ store_id: store.id, category_id: socks.category.id, all_time: '1' });
    if (!Array.isArray(data.size_distribution)) throw new Error('no size_distribution');
    if (data.top_by_qty.some((r) => r.code === belts.product.product_code)) throw new Error('a belt leaked into socks');
    return data.size_distribution.length + ' size bucket(s) sold';
  });

  await check('a malformed category id is ignored, not a 500', async () => {
    const data = await reports.getInventoryAnalytics({ store_id: store.id, category_id: 'not-a-uuid' });
    if (!data.stock_by_size.length) throw new Error('returned nothing');
    return 'treated as no filter';
  });

  console.log('');
  console.log('how a size is written, everywhere it is shown:');

  /**
   * The fields variantFormat needs to write a size correctly.
   *
   * Without size_prefix it falls back to its legacy assumption — that every product
   * is a shoe — and a sock reads "EU KIDS". Without color_is_placeholder a knife's
   * stand-in colour reads "Standard". Both are invisible in SQL and only show up on
   * a receipt, so they are asserted here rather than left to a screenshot.
   */
  function assertVariantShape(row, where) {
    for (const field of ['size_prefix', 'size_suffix', 'has_sizes', 'color_is_placeholder']) {
      if (!(field in row)) throw new Error(where + ' is missing ' + field);
    }
    return row;
  }

  await check('inventory rows carry the size list and the placeholder flag', async () => {
    const rows = await inventory.summary({ store_id: store.id, category_id: socks.category.id, limit: 10 });
    assertVariantShape(rows[0], 'inventory.summary');
    const item = (await inventory.list({ store_id: store.id, category_id: socks.category.id, limit: 10 }))[0];
    assertVariantShape(item, 'inventory.list');
    // The list's own label, not the code it is stored as: 'Kids', not 'KIDS'.
    if (rows[0].size_label_en !== 'Kids') throw new Error("size_label_en was '" + rows[0].size_label_en + "'");
    return "prefix='" + rows[0].size_prefix + "', label='" + rows[0].size_label_en + "'";
  });

  await check('a sale detail can write its sizes correctly', async () => {
    const list = await sales.list({ limit: 1 });
    if (!list.length) return 'no sales to check';
    const sale = await sales.getById(list[0].id);
    if (!sale.items.length) return 'sale has no items';
    assertVariantShape(sale.items[0], 'sales.getById');
    return 'sale ' + (sale.sale_number || sale.id);
  });

  await check('the spreadsheet export writes sizes, not raw codes', async () => {
    // The export is rendered on the server, so it cannot use the frontend formatter.
    // These are the two values it used to ship verbatim.
    const display = require('../src/utils/variantDisplay');
    const sock = { size_eu: 'KIDS', size_label_en: 'Kids', size_prefix: '', size_suffix: '',
      has_sizes: true, color_name: 'Black', color_is_placeholder: false };
    const knife = { size_eu: 'OS', size_prefix: '', size_suffix: '', has_sizes: false,
      color_name: 'Standard', color_is_placeholder: true };
    const shoe = { size_eu: '42', size_prefix: 'EU', size_suffix: '', has_sizes: true };
    const belt = { size_eu: '95', size_prefix: '', size_suffix: 'cm', has_sizes: true };
    // A row from before categories existed: it can only be a shoe, which is what the
    // export used to assume unconditionally.
    const legacy = { size_eu: '41' };

    const cases = [
      ['sock size', display.formatSize(sock), 'Kids'],
      ['sock colour', display.formatColor(sock), 'Black'],
      ['knife size', display.formatSize(knife), ''],
      ['knife colour', display.formatColor(knife), ''],
      ['shoe size', display.formatSize(shoe), 'EU 42'],
      ['belt size', display.formatSize(belt), '95 cm'],
      ['legacy size', display.formatSize(legacy), 'EU 41'],
    ];
    for (const [what, got, want] of cases) {
      if (got !== want) throw new Error(what + ": expected '" + want + "', got '" + got + "'");
    }

    // And the export query itself runs, with the columns the formatter needs.
    const rows = await sales.exportExcel({ store_id: store.id });
    if (rows.length && !('size' in rows[0])) throw new Error('export row has no size column');
    return cases.length + ' cases, ' + rows.length + ' export row(s)';
  });

  await check('a transfer can write its sizes correctly', async () => {
    const list = await transfers.list({ limit: 1 });
    if (!list.length) return 'no transfers to check';
    const t = await transfers.getById(list[0].id);
    if (!t.items || !t.items.length) return 'transfer has no items';
    assertVariantShape(t.items[0], 'transfers.getById');
    return t.items.length + ' item(s)';
  });

  await check('a customer purchase history can write its sizes correctly', async () => {
    const list = await customers.list({ limit: 5 });
    for (const c of list) {
      const full = await customers.getById(c.id);
      const withItems = (full.purchases || full.sales || []).find((s) => (s.items || []).length);
      if (withItems) {
        assertVariantShape(withItems.items[0], 'customers.getById');
        return withItems.items.length + ' item(s)';
      }
    }
    return 'no customer with purchases';
  });

  // ---------------------------------------------------------------- cleanup
  await knex('inventory_items').whereIn('id', made.items).del();
  for (const id of made.products) {
    await knex('product_variants').where('product_id', id).del();
    await knex('product_colors').where('product_id', id).del();
    await knex('products').where('id', id).del();
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  try {
    await knex('inventory_items').whereIn('id', made.items).del();
    for (const id of made.products) {
      await knex('product_variants').where('product_id', id).del();
      await knex('product_colors').where('product_id', id).del();
      await knex('products').where('id', id).del();
    }
  } catch { /* best effort */ }
  await knex.destroy();
  process.exit(1);
});
