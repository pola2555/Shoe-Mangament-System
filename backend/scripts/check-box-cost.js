/*
 * A box is bought as a box.
 *
 * "Twelve pairs, 1000 EGP" used to be enterable only as 83.33 a pair, and 83.33 x 12
 * is 999.96. Four piastres that were really spent appeared on no invoice total, no
 * supplier balance and no stock valuation. Boxes that divide evenly hid it.
 *
 * So the box price is now the figure of record, the unit cost is derived from it, and
 * the pairs are costed by SPREADING that price to the piastre. The suite is mostly
 * about one promise: whatever the box cost, the pairs it created add back up to it.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const purchases = require('../src/modules/purchases/purchases.service');
const products = require('../src/modules/products/products.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const { splitEvenly } = require('../src/utils/splitMoney');

let pass = 0; let fail = 0;
const made = { invoices: [], products: [] };

function check(name, fn) {
  try {
    const r = fn();
    console.log('  ok   ' + name + (r === undefined ? '' : '  ' + r));
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    fail += 1;
  }
}

async function checkAsync(name, fn) {
  try {
    const r = await fn();
    console.log('  ok   ' + name + (r === undefined ? '' : '  ' + r));
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    fail += 1;
  }
}

const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;

(async () => {
  console.log('');
  console.log('dividing money without losing any of it:');

  check('twelve pairs out of 1000 add back up to 1000', () => {
    const parts = splitEvenly(1000, 12);
    if (parts.length !== 12) throw new Error('wrong count');
    if (sum(parts) !== 1000) throw new Error('they sum to ' + sum(parts));
    // The shape the comment promises: eight at 83.33, four at 83.34.
    const hi = parts.filter((p) => p === 83.34).length;
    const lo = parts.filter((p) => p === 83.33).length;
    if (hi !== 4 || lo !== 8) throw new Error(`got ${lo} x 83.33 and ${hi} x 83.34`);
    return '8 x 83.33 + 4 x 83.34 = 1000.00';
  });

  check('a third of ten still adds back up', () => {
    const parts = splitEvenly(10, 3);
    if (sum(parts) !== 10) throw new Error('they sum to ' + sum(parts));
    return parts.join(' + ');
  });

  check('an exact division is left alone', () => {
    const parts = splitEvenly(600, 12);
    if (!parts.every((p) => p === 50)) throw new Error('it disturbed an exact division');
    return 'all 50.00';
  });

  check('one pair gets the whole box', () => {
    const parts = splitEvenly(137.77, 1);
    if (parts.length !== 1 || parts[0] !== 137.77) throw new Error(parts.join(','));
    return '137.77';
  });

  check('a price that is already float noise still balances', () => {
    // 0.1 + 0.2 arrives as 0.30000000000000004; truncating that shifts a piastre.
    const parts = splitEvenly(0.1 + 0.2, 3);
    if (sum(parts) !== 0.3) throw new Error('they sum to ' + sum(parts));
    return '0.10 x 3';
  });

  check('every division from 1 to 60 pairs balances', () => {
    // The guarantee has to hold for every box size, not the two that were tried.
    const totals = [1000, 999.99, 0.01, 1, 7.77, 123.45, 50000];
    for (const total of totals) {
      for (let n = 1; n <= 60; n += 1) {
        const parts = splitEvenly(total, n);
        if (parts.length !== n) throw new Error(`${total}/${n}: wrong count`);
        if (sum(parts) !== Math.round(total * 100) / 100) {
          throw new Error(`${total} across ${n} summed to ${sum(parts)}`);
        }
      }
    }
    return `${totals.length} totals x 60 box sizes, all exact`;
  });

  check('a nonsense number of parts is refused, not guessed at', () => {
    for (const bad of [0, -1, 2.5, 'x', null]) {
      let threw = false;
      try { splitEvenly(100, bad); } catch { threw = true; }
      if (!threw) throw new Error('it accepted parts=' + String(bad));
    }
    return 'zero, negative, fractional and non-numeric all refused';
  });

  console.log('');
  console.log('a box records what was paid for it:');

  const store = await knex('stores').first('id');
  const supplier = await knex('suppliers').first('id');
  const user = await knex('users').first('id');
  if (!store || !supplier || !user) {
    console.log('  (no store/supplier/user in this database — skipping the live checks)');
  } else {
    const list = await cats.listCategories({});
    const shoes = list.find((c) => c.code === 'shoes');

    /** An invoice with headroom, and a product to put in a box. */
    async function world(total = 100000) {
      const p = await products.create({
        product_code: 'ZZBC-' + Date.now() + '-' + (pass + fail),
        model_name: 'box cost test',
        category_id: shoes.id,
        default_selling_price: 500,
      });
      made.products.push(p.id);
      const inv = await purchases.createInvoice({
        supplier_id: supplier.id,
        total_amount: total,
        invoice_date: new Date(),
        boxes: [],
      }, user.id);
      made.invoices.push(inv.id);
      return { product: p, invoice: inv };
    }

    await checkAsync('the box price is stored as typed, and the unit cost derived', async () => {
      const w = await world();
      const box = await purchases.addBox(w.invoice.id, {
        product_id: w.product.id,
        box_cost: 1000,
        total_items: 12,
        destination_store_id: store.id,
      });
      if (Number(box.box_cost) !== 1000) throw new Error('box_cost is ' + box.box_cost);
      // Four places, so 83.3333 is not immediately rounded into a lie.
      if (Math.abs(Number(box.cost_per_item) - 83.3333) > 0.00005) {
        throw new Error('cost_per_item is ' + box.cost_per_item);
      }
      return `1000 / 12 = ${box.cost_per_item}`;
    });

    await checkAsync('the pairs a box creates add back up to what it cost', async () => {
      const w = await world();
      const box = await purchases.addBox(w.invoice.id, {
        product_id: w.product.id,
        box_cost: 1000,
        total_items: 12,
        destination_store_id: store.id,
      });
      const colour = await products.createColor(w.product.id, { color_name: 'Box Cost Black' });
      await purchases.setBoxItems(box.id, [
        { product_color_id: colour.id, size_eu: '40', quantity: 5 },
        { product_color_id: colour.id, size_eu: '41', quantity: 7 },
      ]);
      await purchases.completeBox(box.id);

      const pairs = await knex('inventory_items').where('invoice_box_id', box.id);
      if (pairs.length !== 12) throw new Error('created ' + pairs.length + ' pairs');
      const total = sum(pairs.map((r) => Number(r.cost)));
      // THE WHOLE POINT. Twelve times a rounded 83.33 would be 999.96.
      if (total !== 1000) throw new Error('the pairs are worth ' + total + ', not 1000');
      const distinct = [...new Set(pairs.map((r) => Number(r.cost)))].sort();
      return `12 pairs worth exactly 1000.00 (${distinct.join(' / ')})`;
    });

    await checkAsync('an invoice counts the box price, not items x rounded unit cost', async () => {
      const w = await world();
      await purchases.addBox(w.invoice.id, {
        product_id: w.product.id, box_cost: 1000, total_items: 12, destination_store_id: store.id,
      });
      const boxes = await knex('purchase_invoice_boxes').where('invoice_id', w.invoice.id);
      const totalFromBoxCost = sum(boxes.map((b) => Number(b.box_cost)));
      // The old shape stored the unit cost at TWO places, so that is what it must be
      // compared against — comparing with today's four-place column would hide the
      // very gap this is demonstrating.
      const totalTheOldWay = sum(boxes.map((b) => {
        const unit2dp = Math.round(Number(b.cost_per_item) * 100) / 100;
        return Math.round(Number(b.total_items) * unit2dp * 100) / 100;
      }));
      if (totalFromBoxCost !== 1000) throw new Error('box total is ' + totalFromBoxCost);
      if (totalTheOldWay >= 1000) {
        throw new Error('the old arithmetic was supposed to fall short, got ' + totalTheOldWay);
      }
      return `box price 1000.00; the old arithmetic gives ${totalTheOldWay}`;
    });

    await checkAsync('changing only the quantity restates the unit cost', async () => {
      const w = await world();
      const box = await purchases.addBox(w.invoice.id, {
        product_id: w.product.id, box_cost: 1000, total_items: 10, destination_store_id: store.id,
      });
      if (Number(box.cost_per_item) !== 100) throw new Error('setup wrong: ' + box.cost_per_item);
      const after = await purchases.updateBox(box.id, { total_items: 20 });
      // The box still cost 1000; twenty pairs out of it is 50 each. Leaving the unit
      // cost at 100 would have the box claiming 2000.
      if (Number(after.box_cost) !== 1000) throw new Error('box_cost moved to ' + after.box_cost);
      if (Number(after.cost_per_item) !== 50) throw new Error('cost_per_item is ' + after.cost_per_item);
      return '1000 across 20 = 50.00 each';
    });

    await checkAsync('a box still priced the old way is read the old way', async () => {
      // Rows that predate box_cost must keep describing exactly the money they did.
      const w = await world();
      const box = await purchases.addBox(w.invoice.id, {
        product_id: w.product.id, cost_per_item: 83.33, total_items: 12, destination_store_id: store.id,
      });
      await knex('purchase_invoice_boxes').where('id', box.id).update({ box_cost: null });
      const legacy = await knex('purchase_invoice_boxes').where('id', box.id).first();
      const colour = await products.createColor(w.product.id, { color_name: 'Legacy Black' });
      await purchases.setBoxItems(box.id, [{ product_color_id: colour.id, size_eu: '40', quantity: 12 }]);
      await purchases.completeBox(box.id);
      const pairs = await knex('inventory_items').where('invoice_box_id', box.id);
      const total = sum(pairs.map((r) => Number(r.cost)));
      // 12 x 83.33 — what that box always said, not silently promoted to 1000.
      if (total !== 999.96) throw new Error('a legacy box was restated to ' + total);
      if (legacy.box_cost !== null) throw new Error('setup failed');
      return '12 x 83.33 = 999.96, unchanged';
    });

    await checkAsync('a box over the invoice total is still refused', async () => {
      const w = await world(500);
      let msg = null;
      try {
        await purchases.addBox(w.invoice.id, {
          product_id: w.product.id, box_cost: 900, total_items: 10, destination_store_id: store.id,
        });
      } catch (e) { msg = e.message; }
      if (!msg) throw new Error('it let a 900 box onto a 500 invoice');
      if (!/exceed/i.test(msg)) throw new Error('unhelpful: ' + msg);
      return msg.slice(0, 55) + '...';
    });
  }

  // ---------------------------------------------------------------- cleanup
  for (const id of made.invoices) {
    const boxes = await knex('purchase_invoice_boxes').where('invoice_id', id).select('id');
    const boxIds = boxes.map((b) => b.id);
    if (boxIds.length) {
      await knex('inventory_items').whereIn('invoice_box_id', boxIds).del();
      await knex('box_items').whereIn('invoice_box_id', boxIds).del();
      await knex('purchase_invoice_boxes').whereIn('id', boxIds).del();
    }
    await knex('supplier_payment_allocations').where('invoice_id', id).del().catch(() => {});
    await knex('purchase_invoices').where('id', id).del();
  }
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
