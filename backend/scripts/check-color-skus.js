/*
 * Colours whose names begin alike, and the SKUs they generate.
 *
 * The reported failure: add "Black", then add "Black and White" — both are accepted —
 * then add size variants to them and the second colour is rejected with "a record with
 * this value already exists".
 *
 * Cause: the SKU abbreviated a colour to its first three letters, so both colours
 * wanted PRODUCTCODE-BLA-40. Two of the three copies of SKU generation had no
 * collision handling at all, so the insert hit the unique index on sku.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const products = require('../src/modules/products/products.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const purchases = require('../src/modules/purchases/purchases.service');
const { colorAbbr } = require('../src/utils/variantIdentity');

let pass = 0, fail = 0;
const made = { products: [] };

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

async function newProduct(name) {
  const list = await cats.listCategories({});
  const shoes = list.find((c) => c.code === 'shoes');
  const p = await products.create({
    product_code: (name + '-' + Date.now()).toUpperCase().slice(0, 40),
    model_name: name,
    category_id: shoes.id,
    default_selling_price: 100,
  });
  made.products.push(p.id);
  return p;
}

const skusOf = (rows) => rows.map((r) => r.sku);

(async () => {
  console.log('abbreviations:');

  await check('a colour name abbreviates from the word that actually varies', () => {
    const cases = [
      ['Black', 'BLA'],
      ['Black and White', 'BWH'],
      ['Red Wine', 'RWI'],
      ['Light Blue', 'LBL'],
      ['Light Green', 'LGR'],
      ['  Navy  Blue ', 'NBL'],
      ['', 'STD'],
    ];
    for (const [name, want] of cases) {
      const got = colorAbbr(name);
      if (got !== want) throw new Error(`"${name}" -> ${got}, expected ${want}`);
    }
    // Single-word colours must keep the shape a catalogue already has.
    if (colorAbbr('White') !== 'WHI') throw new Error('single-word abbreviation changed');
    return cases.length + ' names';
  });

  console.log('');
  console.log('THE BUG: two colours whose names start the same way:');

  await check('both colours can be added', async () => {
    const p = await newProduct('sku collision');
    await products.createColor(p.id, { color_name: 'Black', hex_code: '#000000' });
    await products.createColor(p.id, { color_name: 'Black and White', hex_code: '#888888' });
    const colors = await products.listColors(p.id);
    if (colors.length !== 2) throw new Error('expected 2 colours, got ' + colors.length);
    return colors.map((c) => c.color_name).join(' + ');
  });

  await check('size variants can be added to BOTH, one colour at a time', async () => {
    const p = await newProduct('one at a time');
    const black = await products.createColor(p.id, { color_name: 'Black', hex_code: '#000000' });
    const bw = await products.createColor(p.id, { color_name: 'Black and White', hex_code: '#888888' });

    for (const size of ['40', '41']) {
      await products.createVariant(p.id, { product_color_id: black.id, size_eu: size });
    }
    // This is the call that used to throw "a record with this value already exists".
    for (const size of ['40', '41']) {
      await products.createVariant(p.id, { product_color_id: bw.id, size_eu: size });
    }

    const rows = await products.listVariants(p.id);
    if (rows.length !== 4) throw new Error('expected 4 variants, got ' + rows.length);
    if (new Set(skusOf(rows)).size !== 4) throw new Error('duplicate SKUs: ' + skusOf(rows).join(', '));
    if (new Set(rows.map((r) => r.barcode)).size !== 4) throw new Error('duplicate barcodes');
    return skusOf(rows).sort().join('  ');
  });

  await check('and through the colour x size matrix, in one call', async () => {
    const p = await newProduct('matrix');
    const black = await products.createColor(p.id, { color_name: 'Black', hex_code: '#000000' });
    const bw = await products.createColor(p.id, { color_name: 'Black and White', hex_code: '#888888' });

    // Both colours in a single transaction: the SKU for the second is decided while
    // the first colour's rows are only visible inside that transaction.
    const created = await products.bulkCreateVariants(p.id, null, null, {
      color_ids: [black.id, bw.id],
      size_values: ['40', '41', '42'],
    });
    if (created.length !== 6) throw new Error('expected 6 variants, got ' + created.length);
    if (new Set(skusOf(created)).size !== 6) throw new Error('duplicate SKUs: ' + skusOf(created).join(', '));
    return skusOf(created).sort().join('  ');
  });

  await check('three colours sharing a first letter all coexist', async () => {
    const p = await newProduct('three b');
    const ids = [];
    for (const name of ['Black', 'Blue', 'Black and White']) {
      ids.push((await products.createColor(p.id, { color_name: name })).id);
    }
    const created = await products.bulkCreateVariants(p.id, null, null, {
      color_ids: ids, size_values: ['40'],
    });
    if (created.length !== 3) throw new Error('expected 3, got ' + created.length);
    if (new Set(skusOf(created)).size !== 3) throw new Error('duplicate SKUs: ' + skusOf(created).join(', '));
    return skusOf(created).sort().join('  ');
  });

  await check('Arabic colours sharing their first letter also work', async () => {
    const p = await newProduct('arabic');
    const ids = [];
    // Almost every Arabic colour name begins with the same letter.
    for (const name of ['اسود', 'ابيض', 'اسود وابيض']) {
      ids.push((await products.createColor(p.id, { color_name: name })).id);
    }
    const created = await products.bulkCreateVariants(p.id, null, null, {
      color_ids: ids, size_values: ['40'],
    });
    if (created.length !== 3) throw new Error('expected 3, got ' + created.length);
    if (new Set(skusOf(created)).size !== 3) throw new Error('duplicate SKUs: ' + skusOf(created).join(', '));
    return created.length + ' distinct SKUs';
  });

  await check('a renamed colour still cannot collide — the suffix is the backstop', async () => {
    const p = await newProduct('renamed');
    const a = await products.createColor(p.id, { color_name: 'Black' });
    const b = await products.createColor(p.id, { color_name: 'Blazer' });
    // 'Black' and 'Blazer' are both one word starting BLA, so the abbreviation alone
    // cannot separate them. The numeric suffix must.
    if (colorAbbr('Black') !== colorAbbr('Blazer')) throw new Error('test premise broken');
    for (const c of [a, b]) await products.createVariant(p.id, { product_color_id: c.id, size_eu: '40' });
    const rows = await products.listVariants(p.id);
    if (new Set(skusOf(rows)).size !== 2) throw new Error('duplicate SKUs: ' + skusOf(rows).join(', '));
    return skusOf(rows).sort().join('  ');
  });

  await check('receiving stock uses the same rule, so a box cannot collide either', async () => {
    const p = await newProduct('receiving');
    const black = await products.createColor(p.id, { color_name: 'Black' });
    const bw = await products.createColor(p.id, { color_name: 'Black and White' });
    // purchases.completeBox generates SKUs through the same shared helper. Assert that
    // directly rather than staging a whole invoice: the point is that there is one rule.
    const { generateSku } = require('../src/utils/variantIdentity');
    const skus = await knex.transaction(async (trx) => ([
      await generateSku(trx, p, black, '40'),
      await generateSku(trx, p, bw, '40'),
    ]));
    if (skus[0] === skus[1]) throw new Error('same SKU for two colours: ' + skus[0]);
    return skus.join('  ');
  });

  // ---------------------------------------------------------------- cleanup
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
    for (const id of made.products) {
      await knex('product_variants').where('product_id', id).del();
      await knex('product_colors').where('product_id', id).del();
      await knex('products').where('id', id).del();
    }
  } catch { /* best effort */ }
  await knex.destroy();
  process.exit(1);
});
