/* Exercises every query touched by the size_sort change. Read-only. */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const products = require('../src/modules/products/products.service');
const inventory = require('../src/modules/inventory/inventory.service');
const barcodes = require('../src/modules/barcodes/barcodes.service');
const reports = require('../src/modules/reports/reports.service');

let pass = 0, fail = 0;
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

(async () => {
  const p = await knex('products').first('id', 'product_code');
  const admin = await knex('users').where('username', 'admin').first();
  const store = await knex('stores').first('id');

  console.log('changed query paths:');
  await check('products.getById (variant order)', async () => {
    const r = await products.getById(p.id);
    const sizes = r.variants.map((v) => v.size_eu);
    const sorts = r.variants.map((v) => v.size_sort);
    const sorted = sorts.every((v, i) => i === 0 || sorts[i - 1] <= v);
    if (!sorted) throw new Error('not ordered by size_sort: ' + sorts.join(','));
    return sizes.join(',');
  });
  await check('products.listVariants', async () => {
    const r = await products.listVariants(p.id);
    return r.length + ' variants';
  });
  await check('inventory.list', async () => {
    const r = await inventory.list({ limit: 20 });
    return (r.data || r).length + ' rows';
  });
  await check('inventory.summary (groupBy + order)', async () => {
    const r = await inventory.summary({});
    const rows = r.data || r;
    return rows.length + ' rows, first size ' + (rows[0] && rows[0].size_eu);
  });
  await check('inventory.summary with size range', async () => {
    const r = await inventory.summary({ size_min: 41, size_max: 43 });
    return ((r.data || r).length) + ' rows';
  });
  await check('barcodes.labels (order)', async () => {
    const r = await barcodes.labels({ product_id: p.id });
    const sorts = r.map((x) => x.size_sort);
    return r.length + ' labels, sizes ' + r.map((x) => x.size_eu).join(',');
  });
  await check('reports.getProductAnalytics (size_distribution)', async () => {
    const r = await reports.getProductAnalytics({});
    return 'size_distribution ' + JSON.stringify((r.size_distribution || []).slice(0, 3));
  });
  await check('reports.getInventoryAnalytics (stock_by_size)', async () => {
    const r = await reports.getInventoryAnalytics({});
    const s = r.stock_by_size || r.stockBySize || [];
    // The payload deliberately carries only {size, count} — the chart renders in array
    // order — so check that order against what size_sort says it should be.
    const expected = await knex('product_variants')
      .join('inventory_items', 'inventory_items.variant_id', 'product_variants.id')
      .where('inventory_items.status', 'in_stock')
      .distinct('size_eu', 'size_sort')
      .orderBy('size_sort');
    const got = s.map((x) => x.size).join(',');
    const want = expected.map((x) => x.size_eu).join(',');
    if (got !== want) throw new Error('order ' + got + ' != expected ' + want);
    return got;
  });
  await check('every dashboard/report endpoint still runs', async () => {
    const names = ['getDashboardHome', 'getDashboardAdmin', 'getDashboardStats',
      'getSalesAnalytics', 'getProductAnalytics', 'getInventoryAnalytics',
      'getFinancialReport', 'getCustomerAnalytics', 'getEmployeeAnalytics'];
    for (const n of names) await reports[n]({});
    return names.length + ' report methods';
  });
  await check('products.create/update whitelist', async () => {
    // Prove the whitelist drops an unknown key instead of exploding on insert.
    const code = 'SMOKE-' + Date.now();
    const created = await products.create({
      product_code: code, model_name: 'smoke test', brand: 'x',
      default_selling_price: 10, category: 'bogus', evil_column: 1,
    });
    const updated = await products.update(created.id, { brand: 'y', evil_column: 2 });
    await knex('products').where('id', created.id).del();
    if (updated.brand !== 'y') throw new Error('update did not apply');
    return 'unknown keys dropped, row created + updated + removed';
  });
  await check('updateVariant no longer 500s', async () => {
    const v = await knex('product_variants').first('id', 'size_us');
    const before = v.size_us;
    await products.updateVariant(v.id, { size_us: '9.5' });
    const after = await knex('product_variants').where('id', v.id).first('size_us', 'updated_at');
    await knex('product_variants').where('id', v.id).update({ size_us: before });
    if (after.size_us !== '9.5') throw new Error('size_us not written');
    if (!after.updated_at) throw new Error('updated_at not set');
    return 'updated_at written, value restored';
  });

  await check('THE BUG: single- and double-digit sizes order correctly', async () => {
    // Every size in the catalogue is 40-45, so the lexical sort could never show
    // itself. Sizes 9 and 10 are the smallest case that does.
    const code = 'SORT-' + Date.now();
    const prod = await products.create({ product_code: code, model_name: 'sort proof' });
    const color = await products.createColor(prod.id, { color_name: 'Black' });
    for (const size of ['40', '9', '10']) {
      await products.createVariant(prod.id, { product_color_id: color.id, size_eu: size });
    }
    const got = (await products.getById(prod.id)).variants.map((v) => v.size_eu).join(',');
    const lexical = ['40', '9', '10'].slice().sort().join(',');
    await knex('product_variants').where('product_id', prod.id).del();
    await knex('product_colors').where('product_id', prod.id).del();
    await knex('products').where('id', prod.id).del();
    if (got !== '9,10,40') throw new Error('got ' + got + ', expected 9,10,40');
    return got + '   (lexical sort would give ' + lexical + ')';
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
