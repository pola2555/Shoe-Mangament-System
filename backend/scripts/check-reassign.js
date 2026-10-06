/*
 * Correcting the colour or size that stock was booked under.
 *
 * This is the one operation that moves physical pairs between variants, so the whole
 * suite is about what must NOT move with them: a sold pair (its sale line photocopied
 * the cost), the pair's own cost and history, and anything belonging to another
 * product or another branch.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const inventory = require('../src/modules/inventory/inventory.service');
const products = require('../src/modules/products/products.service');
const sales = require('../src/modules/sales/sales.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const { generateUUID } = require('../src/utils/generateCodes');

let pass = 0, fail = 0;
const made = { products: [], items: [], sales: [] };

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

/** A product with two colours and stock on one size of the first. */
async function world(storeId, { sizes = ['40'], qty = 3, cost = 100 } = {}) {
  const list = await cats.listCategories({});
  const shoes = list.find((c) => c.code === 'shoes');
  const p = await products.create({
    product_code: 'ZZRA-' + Date.now() + '-' + Math.floor(pass * 13 + fail),
    model_name: 'reassign test', category_id: shoes.id,
    default_selling_price: 500, net_price: 200,
  });
  made.products.push(p.id);

  const black = await products.createColor(p.id, { color_name: 'Reassign Black' });
  const navy = await products.createColor(p.id, { color_name: 'Reassign Navy' });

  const variants = {};
  for (const size of sizes) {
    variants[size] = await products.createVariant(p.id, { product_color_id: black.id, size_eu: size });
  }

  const items = [];
  for (let i = 0; i < qty; i++) {
    const [row] = await knex('inventory_items').insert({
      id: generateUUID(), variant_id: variants[sizes[0]].id, store_id: storeId,
      cost, source: 'manual', status: 'in_stock',
      // Spaced so "oldest first" is unambiguous.
      created_at: new Date(2026, 0, 1 + i),
    }).returning('*');
    made.items.push(row.id);
    items.push(row);
  }
  return { product: p, black, navy, variants, items };
}

/** How many in-stock pairs sit on a variant at a branch. */
async function stockOf(variantId, storeId) {
  const r = await knex('inventory_items')
    .where({ variant_id: variantId, store_id: storeId, status: 'in_stock' })
    .count('id as c').first();
  return Number(r.c);
}

(async () => {
  const store = await knex('stores').first('id', 'name');
  const user = await knex('users').first('id');
  const admin = { id: user.id, role_name: 'admin', permissions: { all_stores: true } };

  console.log('THE GAP: stock booked under the wrong colour could only be written off.');
  console.log('');
  console.log('moving stock to the right colour:');

  await check('every pair moves, keeping its id, cost and history', async () => {
    const w = await world(store.id);
    const before = w.items.map((i) => i.id).sort().join(',');

    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id,
      product_color_id: w.navy.id,
    });
    if (res.moved !== 3) throw new Error(`expected 3 moved, got ${res.moved}`);
    if (!res.created_variant) throw new Error('Navy 40 did not exist, so it should have been created');

    if (await stockOf(w.variants['40'].id, store.id) !== 0) throw new Error('the old variant still holds stock');
    if (await stockOf(res.to.variant_id, store.id) !== 3) throw new Error('the new variant did not receive them');

    // The SAME rows — not written off and re-created, which would lose the cost.
    const now = await knex('inventory_items').whereIn('id', w.items.map((i) => i.id));
    if (now.map((r) => r.id).sort().join(',') !== before) throw new Error('the rows were replaced, not moved');
    if (!now.every((r) => Number(r.cost) === 100)) throw new Error('cost did not survive the move');
    return `3 pairs, cost 100 intact, new variant ${res.to.sku}`;
  });

  await check('the new variant gets a real SKU and a barcode', async () => {
    const w = await world(store.id, { qty: 1 });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    const v = await knex('product_variants').where('id', res.to.variant_id).first();
    if (!v.sku) throw new Error('no SKU');
    if (!v.barcode || String(v.barcode).length !== 13) throw new Error('no valid barcode: ' + v.barcode);
    if (v.product_id !== w.product.id) throw new Error('the variant landed on another product');
    return `${v.sku} / ${v.barcode}`;
  });

  await check('an existing variant is reused rather than duplicated', async () => {
    const w = await world(store.id, { qty: 2 });
    // Navy 40 already exists this time.
    const navy40 = await products.createVariant(w.product.id, {
      product_color_id: w.navy.id, size_eu: '40',
    });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    if (res.created_variant) throw new Error('it created a second Navy 40');
    if (res.to.variant_id !== navy40.id) throw new Error('it did not reuse the existing variant');
    const dupes = await knex('product_variants')
      .where({ product_id: w.product.id, product_color_id: w.navy.id, size_eu: '40' });
    if (dupes.length !== 1) throw new Error(`${dupes.length} Navy 40 variants exist`);
  });

  await check('the size can be corrected, on its own', async () => {
    const w = await world(store.id, { qty: 2 });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, size_eu: '41',
    });
    if (res.to.size_eu !== '41') throw new Error('size not changed: ' + res.to.size_eu);
    if (res.to.product_color_id !== w.black.id) throw new Error('the colour changed when it should not have');
    return 'Black 40 -> Black 41';
  });

  await check('colour and size can be corrected together', async () => {
    const w = await world(store.id, { qty: 2 });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id,
      product_color_id: w.navy.id, size_eu: '42',
    });
    if (res.to.size_eu !== '42') throw new Error('size wrong');
    if (res.to.product_color_id !== w.navy.id) throw new Error('colour wrong');
    return 'Black 40 -> Navy 42';
  });

  await check('moving only some takes the OLDEST, and leaves the rest', async () => {
    const w = await world(store.id, { qty: 3 });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id,
      product_color_id: w.navy.id, quantity: 2,
    });
    if (res.moved !== 2) throw new Error(`moved ${res.moved}`);
    if (await stockOf(w.variants['40'].id, store.id) !== 1) throw new Error('wrong number left behind');

    // The two oldest went; the newest stayed.
    const moved = await knex('inventory_items')
      .where({ variant_id: res.to.variant_id }).orderBy('created_at');
    const stayed = await knex('inventory_items')
      .where({ variant_id: w.variants['40'].id, status: 'in_stock' }).first();
    if (new Date(stayed.created_at) <= new Date(moved[moved.length - 1].created_at)) {
      throw new Error('it moved the newest pairs, not the oldest');
    }
    return '2 oldest moved, newest stayed';
  });

  console.log('');
  console.log('what must never move:');

  await check('a SOLD pair is left exactly where it is', async () => {
    const w = await world(store.id, { qty: 2 });
    const sale = await sales.create({
      store_id: store.id,
      items: [{ id: w.items[0].id, sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);

    // Only the one still in stock may move.
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    if (res.moved !== 1) throw new Error(`moved ${res.moved}, should have been 1`);

    const sold = await knex('inventory_items').where('id', w.items[0].id).first();
    if (sold.variant_id !== w.variants['40'].id) {
      throw new Error('the sold pair was moved — its sale line now describes something else');
    }
    if (sold.status !== 'sold') throw new Error('the sold pair changed status');
    return 'the sold pair stayed on the old variant';
  });

  await check('a damaged pair is left alone too', async () => {
    const w = await world(store.id, { qty: 2 });
    await knex('inventory_items').where('id', w.items[0].id).update({ status: 'damaged' });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    if (res.moved !== 1) throw new Error(`moved ${res.moved}`);
    const dmg = await knex('inventory_items').where('id', w.items[0].id).first();
    if (dmg.variant_id !== w.variants['40'].id) throw new Error('a damaged pair was moved');
  });

  await check('another branch\'s pairs are untouched', async () => {
    const other = await knex('stores').whereNot('id', store.id).first('id');
    if (!other) return 'only one branch — skipped';
    const w = await world(store.id, { qty: 2 });
    const [elsewhere] = await knex('inventory_items').insert({
      id: generateUUID(), variant_id: w.variants['40'].id, store_id: other.id,
      cost: 100, source: 'manual', status: 'in_stock',
    }).returning('*');
    made.items.push(elsewhere.id);

    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    if (res.moved !== 2) throw new Error(`moved ${res.moved}, should have been this branch's 2 only`);
    const far = await knex('inventory_items').where('id', elsewhere.id).first();
    if (far.variant_id !== w.variants['40'].id) throw new Error('it reached into another branch');
    return 'the other branch kept its pair';
  });

  await check('a colour from a different product is refused', async () => {
    const w = await world(store.id, { qty: 1 });
    const other = await world(store.id, { qty: 1 });
    let msg = null;
    try {
      await inventory.reassign({
        variant_id: w.variants['40'].id, store_id: store.id,
        product_color_id: other.navy.id,   // belongs to a different product
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('stock was moved onto another product');
    if (await stockOf(w.variants['40'].id, store.id) !== 1) throw new Error('stock moved anyway');
    return msg;
  });

  console.log('');
  console.log('refusing what makes no sense:');

  await check('changing nothing is refused, with a reason', async () => {
    const w = await world(store.id, { qty: 1 });
    let msg = null;
    try {
      await inventory.reassign({
        variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.black.id,
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('a no-op was accepted');
    if (!/already has|nothing to change/i.test(msg)) throw new Error('unhelpful message: ' + msg);
  });

  await check('asking for more pairs than exist names how many there are', async () => {
    const w = await world(store.id, { qty: 2 });
    let msg = null;
    try {
      await inventory.reassign({
        variant_id: w.variants['40'].id, store_id: store.id,
        product_color_id: w.navy.id, quantity: 5,
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('it moved more than exist');
    if (!/\b2\b/.test(msg)) throw new Error('the message does not say how many there are: ' + msg);
    if (await stockOf(w.variants['40'].id, store.id) !== 2) throw new Error('it moved some anyway');
    return msg;
  });

  await check('a variant with nothing in stock here is refused', async () => {
    const w = await world(store.id, { qty: 1 });
    await knex('inventory_items').where('id', w.items[0].id).update({ status: 'damaged' });
    let msg = null;
    try {
      await inventory.reassign({
        variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('it moved a pair that was not in stock');
  });

  await check('an unknown variant is a 404', async () => {
    let status = null;
    try {
      await inventory.reassign({
        variant_id: generateUUID(), store_id: store.id, size_eu: '41',
      });
    } catch (e) { status = e.statusCode || e.status; }
    if (status !== 404) throw new Error('expected 404, got ' + status);
  });

  console.log('');
  console.log('what the screen is told:');

  await check('the response carries the new barcode, so labels can be reprinted', async () => {
    const w = await world(store.id, { qty: 4 });
    const res = await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    if (!res.to.barcode) throw new Error('no barcode to print');
    if (res.labels_to_reprint !== 4) throw new Error(`expected 4 labels owed, got ${res.labels_to_reprint}`);
    if (!res.to.color_name) throw new Error('the new colour is not named');
    return `${res.labels_to_reprint} labels owed for ${res.to.color_name}`;
  });

  await check('the summary regroups the stock under its new colour', async () => {
    const w = await world(store.id, { qty: 2 });
    await inventory.reassign({
      variant_id: w.variants['40'].id, store_id: store.id, product_color_id: w.navy.id,
    });
    const rows = await inventory.summary({ store_id: store.id, search: w.product.product_code });
    const mine = rows.filter((r) => r.product_id === w.product.id);
    if (!mine.length) throw new Error('the product vanished from the summary');
    if (mine.some((r) => r.color_name === 'Reassign Black')) {
      throw new Error('it still shows under the old colour');
    }
    if (!mine.some((r) => r.color_name === 'Reassign Navy')) {
      throw new Error('it does not show under the new colour');
    }
    // The id the screen needs to prefill the picker.
    if (!mine[0].product_color_id) throw new Error('the summary does not return product_color_id');
    return 'listed under Reassign Navy';
  });

  // ---------------------------------------------------------------- cleanup
  for (const id of made.sales) {
    await knex('sale_payments').where('sale_id', id).del();
    await knex('sale_items').where('sale_id', id).del();
    await knex('sales').where('id', id).del();
  }
  await knex('inventory_items').whereIn('id', made.items).del();
  for (const id of made.products) {
    await knex('inventory_items').whereIn('variant_id',
      knex('product_variants').select('id').where('product_id', id)).del();
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
  await knex.destroy();
  process.exit(1);
});
