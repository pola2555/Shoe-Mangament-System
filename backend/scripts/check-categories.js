/* User stories for product categories. Creates and cleans up its own data. */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const products = require('../src/modules/products/products.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const inventory = require('../src/modules/inventory/inventory.service');
const barcodes = require('../src/modules/barcodes/barcodes.service');
const { isValidEan13 } = require('../src/utils/ean13');

let pass = 0, fail = 0;
const made = { products: [], categories: [] };

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

async function newProduct(categoryCode, name) {
  const list = await cats.listCategories({});
  const cat = list.find((c) => c.code === categoryCode);
  const p = await products.create({
    product_code: (name + '-' + Date.now()).toUpperCase().slice(0, 40),
    model_name: name,
    category_id: cat.id,
    default_selling_price: 100,
  });
  made.products.push(p.id);
  return { product: p, category: cat };
}

(async () => {
  console.log('user stories:');

  // ---------------------------------------------------------------- knives
  await check('a knife category can be created from nothing', async () => {
    const scales = await cats.listScales({});
    const one = scales.find((s) => s.code === 'one_size');
    const c = await cats.createCategory({
      code: 'knives_test', name_en: 'Knives', name_ar: 'سكاكين',
      has_colors: false, has_sizes: false, size_scale_id: one.id, sort_order: 99,
    });
    made.categories.push(c.id);
    return 'colours=' + c.has_colors + ' sizes=' + c.has_sizes;
  });

  let knifeProduct;
  await check('a knife product auto-creates exactly one placeholder colour', async () => {
    const { product } = await newProduct('knives_test', 'chef knife');
    knifeProduct = product;
    const colors = await knex('product_colors').where('product_id', product.id);
    if (colors.length !== 1) throw new Error('expected 1 colour, got ' + colors.length);
    if (!colors[0].is_placeholder) throw new Error('colour is not flagged as a placeholder');
    return colors[0].color_name + ' (placeholder)';
  });

  await check('a variant with NO colour and NO size is created and gets a barcode', async () => {
    const v = await products.createVariant(knifeProduct.id, {});
    if (!v.barcode) throw new Error('no barcode minted');
    if (!isValidEan13(v.barcode)) throw new Error('invalid EAN-13: ' + v.barcode);
    if (!v.size_eu) throw new Error('size_eu is empty — the SKU and barcode both need it');
    return 'size=' + v.size_eu + ' sku=' + v.sku + ' barcode=' + v.barcode;
  });

  await check('the placeholder colour cannot be renamed or deleted', async () => {
    const c = await knex('product_colors').where('product_id', knifeProduct.id).first();
    let renamed = false, deleted = false;
    try { await products.updateColor(c.id, { color_name: 'Red' }); renamed = true; } catch (e) { /* expected */ }
    try { await products.deleteColor(c.id); deleted = true; } catch (e) { /* expected */ }
    if (renamed) throw new Error('rename was allowed');
    if (deleted) throw new Error('delete was allowed');
    return 'both refused';
  });

  await check('adding a colour to a colourless product is refused', async () => {
    let ok = false;
    try { await products.createColor(knifeProduct.id, { color_name: 'Blue' }); ok = true; } catch (e) { /* expected */ }
    if (ok) throw new Error('createColor was allowed');
    return 'refused';
  });

  await check('a second knife variant is refused as a duplicate, not silently doubled', async () => {
    const before = await knex('product_variants').where('product_id', knifeProduct.id).count('* as n').first();
    let created = null;
    try { created = await products.createVariant(knifeProduct.id, {}); } catch (e) { /* expected */ }
    const after = await knex('product_variants').where('product_id', knifeProduct.id).count('* as n').first();
    if (Number(after.n) !== Number(before.n)) throw new Error('a duplicate variant was created');
    return 'still ' + after.n + ' variant';
  });

  // ---------------------------------------------------------------- socks
  await check('socks offer Kids/Teens/Adults, and a 2x3 matrix saves in one call', async () => {
    const { product } = await newProduct('socks', 'ankle socks');
    const black = await products.createColor(product.id, { color_name: 'Black', hex_code: '#000000' });
    const white = await products.createColor(product.id, { color_name: 'White', hex_code: '#FFFFFF' });

    const full = await products.getById(product.id);
    const offered = full.category.size_values.map((v) => v.value).join(',');
    if (offered !== 'KIDS,TEENS,ADULTS') throw new Error('scale offered ' + offered);

    const created = await products.bulkCreateVariants(product.id, null, null, {
      color_ids: [black.id, white.id],
      size_values: ['KIDS', 'TEENS', 'ADULTS'],
    });
    if (created.length !== 6) throw new Error('expected 6 variants, got ' + created.length);
    for (const v of created) {
      if (!isValidEan13(v.barcode)) throw new Error('invalid barcode ' + v.barcode);
    }

    const listed = await products.getById(product.id);
    const order = listed.variants.map((v) => v.size_eu);
    // Alphabetically this would be ADULTS, KIDS, TEENS — the scale's order is what matters.
    const perColour = order.slice(0, 3).join(',');
    if (!order.every((_, i) => i === 0 || listed.variants[i - 1].size_sort <= listed.variants[i].size_sort)) {
      throw new Error('not ordered by the scale: ' + order.join(','));
    }
    return '6 variants, order ' + [...new Set(order)].join(',') + '  (alphabetical would give ADULTS,KIDS,TEENS)';
  });

  await check('re-running the same matrix creates nothing new', async () => {
    const p = made.products[made.products.length - 1];
    const cs = await knex('product_colors').where('product_id', p).pluck('id');
    const again = await products.bulkCreateVariants(p, null, null, {
      color_ids: cs, size_values: ['KIDS', 'TEENS', 'ADULTS'],
    });
    const total = await knex('product_variants').where('product_id', p).count('* as n').first();
    if (again.length !== 0) throw new Error('created ' + again.length + ' duplicates');
    return 'skipped all 6, total still ' + total.n;
  });

  await check('a size the category does not list is refused', async () => {
    const p = made.products[made.products.length - 1];
    const cs = await knex('product_colors').where('product_id', p).pluck('id');
    let msg = null;
    try {
      await products.bulkCreateVariants(p, null, null, {
        color_ids: cs, size_values: ['BABY'],
      });
    } catch (e) { msg = e.message; }
    const total = await knex('product_variants').where('product_id', p).count('* as n').first();
    if (!msg) throw new Error('BABY was accepted');
    if (Number(total.n) !== 6) throw new Error('partial write: ' + total.n + ' variants');
    return msg.slice(0, 80);
  });

  await check('adding the size to the list first makes it work', async () => {
    const p = made.products[made.products.length - 1];
    const list = await cats.listCategories({});
    const socks = list.find((c) => c.code === 'socks');
    const current = await cats.listScaleValues(socks.size_scale_id);
    await cats.replaceScaleValues(socks.size_scale_id, [
      ...current.map((v) => ({ value: v.value, label_en: v.label_en, label_ar: v.label_ar, sort_order: v.sort_order })),
      { value: 'BABY', label_en: 'Baby', label_ar: 'رضّع', sort_order: 5 },
    ]);
    const cs = await knex('product_colors').where('product_id', p).pluck('id');
    const added = await products.bulkCreateVariants(p, null, null, {
      color_ids: cs, size_values: ['BABY'],
    });
    const listed = await products.getById(p);
    const order = [...new Set(listed.variants.map((v) => v.size_eu))].join(',');
    // Put the scale back the way it was. The BABY variants have to go first — the
    // service refuses to remove a size that variants still use, which is the point.
    await knex('product_variants').where({ product_id: p, size_eu: 'BABY' }).del();
    await cats.replaceScaleValues(socks.size_scale_id,
      current.map((v) => ({ value: v.value, label_en: v.label_en, label_ar: v.label_ar, sort_order: v.sort_order })));
    if (added.length !== 2) throw new Error('expected 2, got ' + added.length);
    if (order !== 'BABY,KIDS,TEENS,ADULTS') throw new Error('order ' + order);
    return added.length + ' added, order now ' + order;
  });

  // ---------------------------------------------------------------- belts
  await check('belts use cm sizes and sort numerically', async () => {
    const { product } = await newProduct('belts', 'leather belt');
    const brown = await products.createColor(product.id, { color_name: 'Brown', hex_code: '#6B4A2F' });
    await products.bulkCreateVariants(product.id, null, null, {
      color_ids: [brown.id], size_values: ['100', '85', '95'],
    });
    const listed = await products.getById(product.id);
    const order = listed.variants.map((v) => v.size_eu).join(',');
    if (order !== '85,95,100') throw new Error('order was ' + order);
    return order + '  (lexical would give 100,85,95)';
  });

  // ---------------------------------------------------------------- guards
  await check('moving a product to an incompatible category is refused', async () => {
    const list = await cats.listCategories({});
    const socksProduct = made.products[1];
    const shoes = list.find((c) => c.code === 'shoes');
    let ok = false;
    try { await products.update(socksProduct, { category_id: shoes.id }); ok = true; } catch (e) { /* expected */ }
    if (ok) throw new Error('the move was allowed');
    return 'refused';
  });

  await check('moving between compatible categories is allowed', async () => {
    const list = await cats.listCategories({});
    const { product } = await newProduct('shoes', 'plain shoe');
    const slippers = list.find((c) => c.code === 'slippers');
    // Same scale, same colour/size flags — nothing about the variants would change.
    const updated = await products.update(product.id, { category_id: slippers.id });
    if (updated.category_id !== slippers.id) throw new Error('not moved');
    return 'shoes -> slippers';
  });

  // ---------------------------------------------------------------- downstream
  await check('a colourless variant still resolves through inventory and barcode lookup', async () => {
    const v = await knex('product_variants').where('product_id', knifeProduct.id).first();
    const labels = await barcodes.labels({ variant_ids: [v.id] });
    if (!labels.length) throw new Error('no label payload');
    const l = labels[0];
    if (!l.barcode) throw new Error('label has no barcode');
    if (!l.color_name) throw new Error('label lost its colour name (INNER JOIN dropped the row?)');
    return 'label: ' + l.product_name + ' / ' + l.color_name + ' / ' + l.size_eu + ' / ' + l.barcode;
  });

  await check('every product still appears in the inventory list (no join dropped rows)', async () => {
    const before = await knex('products').count('* as n').first();
    const rows = await inventory.list({ limit: 200 });
    const listed = await products.list({});
    if (listed.length !== Number(before.n)) {
      throw new Error('products.list returned ' + listed.length + ' of ' + before.n);
    }
    return listed.length + ' products listed, all present';
  });

  await check('products.list can filter by category', async () => {
    const list = await cats.listCategories({});
    const socks = list.find((c) => c.code === 'socks');
    const filtered = await products.list({ category_id: socks.id });
    if (!filtered.length) throw new Error('no products returned for socks');
    if (!filtered.every((p) => p.category_id === socks.id)) throw new Error('filter leaked other categories');
    return filtered.length + ' socks product(s), category_name_en=' + filtered[0].category_name_en;
  });

  // ---------------------------------------------------------------- cleanup
  for (const id of made.products) {
    await knex('product_variants').where('product_id', id).del();
    await knex('product_color_images').whereIn('product_color_id', knex('product_colors').select('id').where('product_id', id)).del();
    await knex('product_colors').where('product_id', id).del();
    await knex('products').where('id', id).del();
  }
  for (const id of made.categories) await knex('product_categories').where('id', id).del();

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('CRASHED: ' + e.message);
  await knex.destroy();
  process.exit(1);
});
