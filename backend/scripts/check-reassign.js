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

  console.log('');
  console.log('removing stock that was never really there:');

  await check('pairs are really deleted, not flagged', async () => {
    const w = await world(store.id, { qty: 3 });
    const res = await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 2,
      reason: 'typed the quantity twice',
    });
    if (res.removed !== 2) throw new Error(`removed ${res.removed}`);
    if (await stockOf(w.variants['40'].id, store.id) !== 1) throw new Error('wrong number left');

    // Gone from the table entirely. A flag would have to be excluded from every query
    // that counts stock, which is the trap voiding a sale already taught.
    const left = await knex('inventory_items').whereIn('id', w.items.map((i) => i.id));
    if (left.length !== 1) throw new Error(`${left.length} rows remain, expected 1`);
    return `2 deleted, worth ${res.removed_value}`;
  });

  await check('it takes the NEWEST, the opposite of a correction', async () => {
    // A removal undoes an entry just made; a correction relabels pairs that have been
    // on the shelf. Different intents, deliberately different ends of the queue.
    const w = await world(store.id, { qty: 3 });
    await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 1,
      reason: 'entered by mistake',
    });
    const left = await knex('inventory_items')
      .where({ variant_id: w.variants['40'].id, status: 'in_stock' }).orderBy('created_at');
    const goneId = w.items[w.items.length - 1].id;      // the newest
    if (left.some((r) => r.id === goneId)) throw new Error('it removed an older pair');
    if (left.length !== 2) throw new Error(`${left.length} left`);
    return 'newest removed, older two kept';
  });

  await check('the value removed is reported, for the log', async () => {
    const w = await world(store.id, { qty: 2, cost: 250 });
    const res = await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 2, reason: 'duplicate entry',
    });
    if (res.removed_value !== 500) throw new Error(`expected 500, got ${res.removed_value}`);
    return '2 x 250 = 500 off the stock valuation';
  });

  await check('a pair from a VOIDED sale is refused, in words', async () => {
    // The case that actually turns up. Voiding returns the pair to stock and keeps the
    // sale line as the record of what happened, so the pair is in stock AND still
    // referenced. Postgres would refuse it as a constraint violation; this has to read
    // as a sentence instead.
    const w = await world(store.id, { qty: 1 });
    const sale = await sales.create({
      store_id: store.id,
      items: [{ id: w.items[0].id, sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);
    await sales.voidSale(sale.id, { reason: 'test' }, admin);

    if (await stockOf(w.variants['40'].id, store.id) !== 1) throw new Error('the void did not restore it');

    let msg = null;
    try {
      await inventory.removeStock({
        variant_id: w.variants['40'].id, store_id: store.id, quantity: 1, reason: 'oops',
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('a pair with a sale behind it was deleted');
    if (/constraint|violates|foreign key/i.test(msg)) {
      throw new Error('it leaked a database error: ' + msg);
    }
    if (!/history/i.test(msg)) throw new Error('the message does not explain why: ' + msg);
    if (await stockOf(w.variants['40'].id, store.id) !== 1) throw new Error('it deleted it anyway');
    return msg.slice(0, 60) + '...';
  });

  await check('a sold pair is left where it is', async () => {
    const w = await world(store.id, { qty: 2 });
    const sale = await sales.create({
      store_id: store.id,
      items: [{ id: w.items[0].id, sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);
    // Only the unsold pair is a candidate at all, so this removes one and the sale is
    // untouched rather than the whole request being refused.
    const res = await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 1, reason: 'mis-entry',
    });
    if (res.removed !== 1) throw new Error(`removed ${res.removed}`);
    const sold = await knex('inventory_items').where('id', w.items[0].id).first();
    if (!sold) throw new Error('the SOLD pair was deleted');
    if (sold.status !== 'sold') throw new Error('the sold pair changed');
  });

  await check('asking for more than exist names how many there are', async () => {
    const w = await world(store.id, { qty: 2 });
    let msg = null;
    try {
      await inventory.removeStock({
        variant_id: w.variants['40'].id, store_id: store.id, quantity: 9, reason: 'x',
      });
    } catch (e) { msg = e.message; }
    if (!msg) throw new Error('it removed more than exist');
    if (!/\b2\b/.test(msg)) throw new Error('does not say how many: ' + msg);
    if (await stockOf(w.variants['40'].id, store.id) !== 2) throw new Error('it removed some anyway');
  });

  await check('another branch is never touched', async () => {
    const other = await knex('stores').whereNot('id', store.id).first('id');
    if (!other) return 'only one branch — skipped';
    const w = await world(store.id, { qty: 1 });
    const [elsewhere] = await knex('inventory_items').insert({
      id: generateUUID(), variant_id: w.variants['40'].id, store_id: other.id,
      cost: 100, source: 'manual', status: 'in_stock',
    }).returning('*');
    made.items.push(elsewhere.id);

    await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 1, reason: 'mis-entry',
    });
    const far = await knex('inventory_items').where('id', elsewhere.id).first();
    if (!far) throw new Error('it deleted a pair belonging to another branch');
    return 'the other branch kept its pair';
  });

  await check('invoiced pairs are counted, and the invoice itself stands', async () => {
    const w = await world(store.id, { qty: 2 });
    const box = await knex('purchase_invoice_boxes').first('id');
    if (!box) return 'no purchase box in this database — skipped';
    // The newest pair is the one that will be taken.
    await knex('inventory_items').where('id', w.items[1].id).update({ invoice_box_id: box.id });

    const res = await inventory.removeStock({
      variant_id: w.variants['40'].id, store_id: store.id, quantity: 1, reason: 'over-received',
    });
    if (res.from_purchase !== 1) throw new Error(`from_purchase was ${res.from_purchase}`);
    const stillThere = await knex('purchase_invoice_boxes').where('id', box.id).first();
    if (!stillThere) throw new Error('it deleted the invoice box');
    return 'flagged as invoiced stock; the invoice stands';
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
