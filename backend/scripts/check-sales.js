/*
 * Voiding a sale, selling on credit, and box suggestions.
 *
 * The load-bearing test is "every figure returns". A void has to be excluded from ~40
 * queries across reports, customers and sales; adding the predicate to each by hand is
 * exactly the kind of change where one gets missed. So rather than checking the
 * predicate is present, this snapshots every reported figure, voids a sale, and asserts
 * each one goes back to what it was. A query that still counts the void fails here.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const sales = require('../src/modules/sales/sales.service');
const reports = require('../src/modules/reports/reports.service');
const purchases = require('../src/modules/purchases/purchases.service');
const products = require('../src/modules/products/products.service');
const cats = require('../src/modules/product-categories/product-categories.service');
const notifications = require('../src/modules/notifications/notifications.service');
const { generateUUID } = require('../src/utils/generateCodes');

let pass = 0, fail = 0;
const made = { sales: [], items: [], products: [], customers: [], notifications: [], invoices: [] };

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

const ADMIN = (id) => ({ id, role_name: 'admin', permissions: { all_stores: true } });

/** Stock we can sell: a product, a colour, three variants, one pair of each. */
async function stockUp(storeId, sizes, opts = {}) {
  const list = await cats.listCategories({});
  const shoes = list.find((c) => c.code === 'shoes');
  const p = await products.create({
    product_code: 'ZZSALE-' + Date.now(), model_name: 'void test',
    category_id: shoes.id, default_selling_price: 500, net_price: 200,
    // The search checks need a product nobody could match by accident.
    ...(opts.product || {}),
  });
  made.products.push(p.id);
  const color = await products.createColor(p.id, { color_name: opts.colour || 'Void Test' });

  const items = [];
  for (const size of sizes) {
    const v = await products.createVariant(p.id, { product_color_id: color.id, size_eu: size });
    const [row] = await knex('inventory_items').insert({
      id: generateUUID(), variant_id: v.id, store_id: storeId,
      cost: 200, source: 'manual', status: 'in_stock',
    }).returning('*');
    made.items.push(row.id);
    items.push(row);
  }
  return { product: p, color, items };
}

/** Every number a report puts on the screen, flattened for comparison. */
async function snapshot(storeId) {
  const [home, statsAll, salesAn, prodAn, fin, custAn, empAn] = await Promise.all([
    reports.getDashboardHome({ store_id: storeId }),
    reports.getDashboardStats({ store_id: storeId, all_time: '1' }),
    reports.getSalesAnalytics({ store_id: storeId, all_time: '1' }),
    reports.getProductAnalytics({ store_id: storeId, all_time: '1' }),
    reports.getFinancialReport({ store_id: storeId, all_time: '1' }),
    reports.getCustomerAnalytics({ store_id: storeId, all_time: '1' }),
    reports.getEmployeeAnalytics({ store_id: storeId, all_time: '1' }),
  ]);
  return JSON.stringify({ home, statsAll, salesAn, prodAn, fin, custAn, empAn });
}

(async () => {
  const store = await knex('stores').first('id', 'name');
  const user = await knex('users').first('id', 'full_name');
  const admin = ADMIN(user.id);

  const [customer] = await knex('customers')
    .insert({ id: generateUUID(), phone: 'ZZ' + Date.now(), name: 'ZZ Credit Customer' })
    .returning('*');
  made.customers.push(customer.id);

  console.log('THE BUG: a mis-rung sale could not be undone at all.');
  console.log('');
  console.log('voiding:');

  // The baseline is taken AFTER the stock exists. Voiding returns the pairs to stock,
  // so an earlier baseline would differ for a correct reason — the inventory count —
  // and hide whether the money figures really came back.
  const stock = await stockUp(store.id, ['40', '41', '42']);
  const before = await snapshot(store.id);
  let sale;

  await check('a sale can be rung and reports move', async () => {
    sale = await sales.create({
      store_id: store.id,
      items: stock.items.map((i) => ({ id: i.id, sale_price: 500 })),
      payments: [{ amount: 1500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);
    const after = await snapshot(store.id);
    if (after === before) throw new Error('the sale changed no report at all');
    return sale.sale_number + ', 3 items, 1500';
  });

  await check('the items really are marked sold', async () => {
    const rows = await knex('inventory_items').whereIn('id', made.items);
    if (!rows.every((r) => r.status === 'sold')) throw new Error('not all sold');
    if (!rows.every((r) => r.sold_at)) throw new Error('sold_at not set');
  });

  await check('voiding puts every pair back in stock', async () => {
    const voided = await sales.voidSale(sale.id, { reason: 'wrong size scanned' }, admin);
    if (!voided.voided_at) throw new Error('voided_at not set');
    if (voided.void_reason !== 'wrong size scanned') throw new Error('reason lost');
    const rows = await knex('inventory_items').whereIn('id', made.items);
    if (!rows.every((r) => r.status === 'in_stock')) throw new Error('stock not returned');
    if (rows.some((r) => r.sold_at)) throw new Error('sold_at not cleared');
    return '3 pairs back';
  });

  await check('EVERY reported figure returns to what it was', async () => {
    const after = await snapshot(store.id);
    if (after !== before) {
      // Name the first difference, so a missed query is findable rather than just
      // "something is off".
      const a = JSON.parse(before), b = JSON.parse(after);
      for (const key of Object.keys(a)) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          throw new Error(`${key} still counts the voided sale`);
        }
      }
      throw new Error('snapshots differ');
    }
    return 'dashboard, sales, products, financial, customers, employees';
  });

  await check('the sale is hidden from the list but still reachable', async () => {
    const list = await sales.list({ store_id: store.id });
    if (list.some((s) => s.id === sale.id)) throw new Error('a voided sale is still listed');
    const withVoided = await sales.list({ store_id: store.id, include_voided: true });
    if (!withVoided.some((s) => s.id === sale.id)) throw new Error('cannot be found even on request');
    const one = await sales.getById(sale.id);
    if (!one.voided_at) throw new Error('getById cannot load it');
    return 'hidden by default, kept for the record';
  });

  await check('voiding twice is refused', async () => {
    try {
      await sales.voidSale(sale.id, {}, admin);
      throw new Error('voided twice');
    } catch (e) {
      if (!/already been voided/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a voided sale takes no further payment', async () => {
    try {
      await sales.addPayment(sale.id, { amount: 10, payment_method: 'cash' });
      throw new Error('accepted money for a sale that did not happen');
    } catch (e) {
      if (!/voided/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a voided sale cannot be edited', async () => {
    try {
      await sales.updateSale(sale.id, { notes: 'x' }, admin);
      throw new Error('edited a voided sale');
    } catch (e) {
      if (!/voided/i.test(e.message)) throw e;
    }
  });

  await check('a sale whose stock has moved on is refused, by name', async () => {
    const s2 = await sales.create({
      store_id: store.id,
      items: [{ id: stock.items[0].id, sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(s2.id);
    // Simulate the pair being transferred out after the sale.
    await knex('inventory_items').where('id', stock.items[0].id).update({ status: 'in_transfer' });
    try {
      await sales.voidSale(s2.id, {}, admin);
      throw new Error('voided a sale whose stock had moved');
    } catch (e) {
      if (!/moved on/i.test(e.message)) throw e;
      if (!e.message.includes(stock.product.product_code)) throw new Error('does not say which item');
    } finally {
      await knex('inventory_items').where('id', stock.items[0].id).update({ status: 'sold' });
    }
    await sales.voidSale(s2.id, {}, admin);
    return 'named the item and stopped';
  });

  console.log('');
  console.log('selling on credit:');

  await check('a walk-in cannot underpay, and is told why', async () => {
    const fresh = await stockUp(store.id, ['40']);
    try {
      const bad = await sales.create({
        store_id: store.id,
        items: [{ id: fresh.items[0].id, sale_price: 500 }],
        payments: [{ amount: 100, payment_method: 'cash' }],
      }, admin);
      made.sales.push(bad.id);
      throw new Error('a walk-in walked out owing money');
    } catch (e) {
      if (!/walk-in|in full/i.test(e.message)) throw e;
      if (!/add the customer/i.test(e.message)) throw new Error('does not say what to do instead');
    }
    // The failed sale must roll back completely — the pair is still sellable.
    const item = await knex('inventory_items').where('id', fresh.items[0].id).first();
    if (item.status !== 'in_stock') throw new Error('a failed sale left the item marked ' + item.status);
    return 'refused, and nothing left half-done';
  });

  let creditSale;
  await check('a registered customer can part-pay', async () => {
    const fresh = await stockUp(store.id, ['41']);
    creditSale = await sales.create({
      store_id: store.id,
      customer_id: customer.id,
      items: [{ id: fresh.items[0].id, sale_price: 500 }],
      payments: [{ amount: 200, payment_method: 'cash' }],
    }, admin);
    made.sales.push(creditSale.id);
    if (creditSale.amount_due !== 300) throw new Error('amount_due is ' + creditSale.amount_due);
    return '200 paid, 300 due';
  });

  await check('and take the goods with nothing down', async () => {
    const fresh = await stockUp(store.id, ['42']);
    const s = await sales.create({
      store_id: store.id,
      customer_id: customer.id,
      items: [{ id: fresh.items[0].id, sale_price: 500 }],
      payments: [],
    }, admin);
    made.sales.push(s.id);
    if (s.amount_due !== 500) throw new Error('amount_due is ' + s.amount_due);
    return 'wholly on account';
  });

  await check('the balance adds up, and settles', async () => {
    const bal = await sales.customerBalance(customer.id, { store_id: store.id });
    if (bal.outstanding !== 800) throw new Error('outstanding is ' + bal.outstanding);
    if (bal.unpaid_count !== 2) throw new Error('unpaid_count is ' + bal.unpaid_count);

    await sales.addPayment(creditSale.id, { amount: 300, payment_method: 'cash' });
    const after = await sales.customerBalance(customer.id, { store_id: store.id });
    if (after.outstanding !== 500) throw new Error('after settling: ' + after.outstanding);
    return '800 -> 500 after paying one off';
  });

  await check('overpayment is still refused', async () => {
    try {
      await sales.addPayment(creditSale.id, { amount: 1, payment_method: 'cash' });
      throw new Error('overpaid');
    } catch (e) {
      if (!/exceed/i.test(e.message)) throw e;
    }
  });

  await check('a voided sale drops out of the customer balance', async () => {
    const bal = await sales.customerBalance(customer.id, { store_id: store.id });
    const target = bal.unpaid_sales[0];
    await sales.voidSale(target.id, { reason: 'test' }, admin);
    const after = await sales.customerBalance(customer.id, { store_id: store.id });
    if (after.outstanding >= bal.outstanding) throw new Error('balance did not drop');
    return bal.outstanding + ' -> ' + after.outstanding;
  });

  await check('a sale still owing cannot be moved to a walk-in', async () => {
    const bal = await sales.customerBalance(customer.id, { store_id: store.id });
    if (!bal.unpaid_sales.length) return 'nothing outstanding — skipped';
    try {
      await sales.updateSale(bal.unpaid_sales[0].id, { customer_id: null }, admin);
      throw new Error('a debt was orphaned');
    } catch (e) {
      if (!/outstanding/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('notes and customer can still be corrected', async () => {
    const s = await sales.updateSale(creditSale.id, { notes: 'corrected note' }, admin);
    if (s.notes !== 'corrected note') throw new Error('note not saved');
    return 'notes edited';
  });

  console.log('');
  console.log('purchase boxes:');

  await check('the last box of a product is offered back', async () => {
    const invoice = await knex('purchase_invoices').first('id');
    if (!invoice) return 'no invoices — skipped';
    const box = await knex('purchase_invoice_boxes')
      .whereNotNull('product_id').orderBy('created_at', 'desc').first();
    if (!box) return 'no boxes — skipped';
    const suggestion = await purchases.lastBoxForProduct(box.product_id, {});
    if (!suggestion) throw new Error('nothing suggested for a product that has boxes');
    if (String(suggestion.id) !== String(box.id)) throw new Error('not the most recent box');
    if (!Array.isArray(suggestion.items)) throw new Error('items missing');
    return 'cost ' + suggestion.cost_per_item + ', ' + suggestion.items.length + ' item row(s)';
  });

  await check('a product never bought before suggests nothing', async () => {
    const s = await purchases.lastBoxForProduct(generateUUID(), {});
    if (s !== null) throw new Error('invented a suggestion');
    return 'null, not an error';
  });

  await check('duplicating a box copies its items and starts incomplete', async () => {
    const box = await knex('purchase_invoice_boxes as b')
      .join('purchase_invoices as inv', 'inv.id', 'b.invoice_id')
      .whereNotNull('b.product_id')
      .orderBy('b.created_at', 'desc')
      .first('b.id', 'b.invoice_id', 'b.total_items', 'b.cost_per_item', 'inv.total_amount');
    if (!box) return 'no boxes — skipped';

    const originalItems = await knex('box_items').where('invoice_box_id', box.id).count('id as n').first();
    try {
      const copy = await purchases.duplicateBox(box.id);
      made.invoices.push(copy.id);
      if (copy.detail_status === 'complete') throw new Error('the copy arrived complete — it would invent stock');
      const copied = await knex('box_items').where('invoice_box_id', copy.id).count('id as n').first();
      if (Number(copied.n) !== Number(originalItems.n)) throw new Error('items not copied');
      await knex('box_items').where('invoice_box_id', copy.id).del();
      await knex('purchase_invoice_boxes').where('id', copy.id).del();
      return Number(copied.n) + ' item row(s) copied, status ' + copy.detail_status;
    } catch (e) {
      // An invoice already at its total legitimately refuses — that is the guard, not
      // a failure.
      if (/exceed|over its total/i.test(e.message)) return 'refused: invoice already at its total';
      throw e;
    }
  });

  console.log('');
  console.log('notifications:');

  await check('clearing archives without deleting', async () => {
    const [n] = await knex('notifications').insert({
      id: generateUUID(), type: 'test', title: 'ZZ test', message: 'ZZ test message',
      user_id: user.id, is_read: false,
    }).returning('*');
    made.notifications.push(n.id);

    const unread = await notifications.getUnread(user.id);
    if (!unread.some((x) => x.id === n.id)) throw new Error('not in the bell to start with');

    await notifications.clear(user.id);

    const after = await notifications.getUnread(user.id);
    if (after.some((x) => x.id === n.id)) throw new Error('still in the bell');

    const hist = await notifications.history({}, user.id);
    if (!hist.data.some((x) => x.id === n.id)) throw new Error('lost from the history — the whole point');
    return 'bell empty, history keeps it';
  });

  await check('history filters by date', async () => {
    const future = await notifications.history({ from: '2099-01-01' }, user.id);
    if (future.pagination.total !== 0) throw new Error('a future range returned ' + future.pagination.total);
    const all = await notifications.history({}, user.id);
    if (all.pagination.total === 0) throw new Error('unfiltered history is empty');
    return all.pagination.total + ' in history, 0 in 2099';
  });

  await check('deleting a range needs a range', async () => {
    try {
      await notifications.deleteRange({}, user.id);
      throw new Error('deleted everything with no range given');
    } catch (e) {
      if (!/date range/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  // ------------------------------------------- finding a sale by what was sold in it
  //
  // Nobody keeps a receipt. A customer coming back to exchange arrives holding the
  // shoe, so the thing they can actually tell you is the product — or the label still
  // stuck to it. The trap is the join: a sale holding three pairs of one product is
  // still ONE sale, and a search that lists it three times reads as three sales.
  console.log('');
  console.log('finding a sale by what was in it:');

  const tag = 'ZZFIND' + Date.now().toString().slice(-6);
  const findable = await stockUp(store.id, ['40', '41'], {
    product: { product_code: tag + '-CODE', model_name: tag + ' Model', brand: tag + ' Brand' },
    colour: tag + 'Colour',
  });
  let findSale;
  let findVariant;

  await check('a sale of two pairs of one product', async () => {
    findSale = await sales.create({
      store_id: store.id,
      items: findable.items.map((i) => ({ id: i.id, sale_price: 500 })),
      payments: [{ amount: 1000, payment_method: 'cash' }],
    }, admin);
    made.sales.push(findSale.id);
    findVariant = await knex('product_variants').where('product_id', findable.product.id).first();
    return findSale.sale_number;
  });

  const finds = async (term) => {
    const rows = await sales.list({ store_id: store.id, search: term });
    return rows.filter((s) => s.id === findSale.id);
  };

  await check('found by the product name, the brand and the product code', async () => {
    for (const [what, term] of [
      ['model', findable.product.model_name],
      ['brand', findable.product.brand],
      ['code', findable.product.product_code],
    ]) {
      const hits = await finds(term);
      if (hits.length === 0) throw new Error(`searching the ${what} did not find the sale`);
    }
    return 'three ways in';
  });

  await check('found by the SKU and by the barcode on the label', async () => {
    for (const [what, term] of [['sku', findVariant.sku], ['barcode', findVariant.barcode]]) {
      if (!term) throw new Error(`the variant has no ${what} to search`);
      const hits = await finds(term);
      if (hits.length === 0) throw new Error(`searching the ${what} did not find the sale`);
    }
    // This is the one that makes scanning the shoe work at all: the exchange screen
    // sends a scanned barcode to this same search.
    return findVariant.barcode;
  });

  await check('found by the colour that was sold', async () => {
    const hits = await finds(findable.color.color_name);
    if (hits.length === 0) throw new Error('the colour did not find the sale');
  });

  await check('listed ONCE, not once per matching pair', async () => {
    const hits = await finds(findable.product.model_name);
    if (hits.length !== 1) throw new Error(`the sale appears ${hits.length} times`);
    return '2 pairs, 1 row';
  });

  await check('the row says what was in it', async () => {
    const [row] = await finds(findable.product.model_name);
    if (row.item_count !== 2) throw new Error(`item_count is ${row.item_count}, expected 2`);
    const name = (row.item_products || []).join(', ');
    if (!name.includes(findable.product.model_name)) {
      throw new Error(`item_products does not name the product: ${JSON.stringify(row.item_products)}`);
    }
    return row.item_count + ' x ' + name;
  });

  await check('the receipt number and the customer still find it', async () => {
    const byNumber = await finds(findSale.sale_number);
    if (byNumber.length !== 1) throw new Error('the receipt number stopped working');
  });

  await check('the stand-in colour of a colourless product never matches', async () => {
    // A colourless category carries a placeholder colour row so its variants still have
    // a key. If the search matched it, one word would return every knife in the shop.
    const list = await cats.listCategories({});
    const colourless = list.find((c) => c.has_colors === false);
    if (!colourless) return 'no colourless category in this catalogue';

    const p = await products.create({
      product_code: tag + '-TOOL', model_name: tag + ' Tool',
      category_id: colourless.id, default_selling_price: 300, net_price: 100,
    });
    made.products.push(p.id);
    const v = await products.createVariant(p.id, {});
    const [pair] = await knex('inventory_items').insert({
      id: generateUUID(), variant_id: v.id, store_id: store.id,
      cost: 100, source: 'manual', status: 'in_stock',
    }).returning('*');
    made.items.push(pair.id);
    const sold = await sales.create({
      store_id: store.id,
      items: [{ id: pair.id, sale_price: 300 }],
      payments: [{ amount: 300, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sold.id);

    const placeholder = await knex('product_colors')
      .where({ product_id: p.id, is_placeholder: true }).first();
    if (!placeholder) throw new Error('no placeholder colour was created');
    const rows = await sales.list({ store_id: store.id, search: placeholder.color_name });
    if (rows.some((s) => s.id === sold.id)) {
      throw new Error(`"${placeholder.color_name}" matched a sale through the stand-in colour`);
    }
    // The product's own name must still find it, or the sale would be unfindable.
    const byName = await sales.list({ store_id: store.id, search: p.model_name });
    if (!byName.some((s) => s.id === sold.id)) throw new Error('the colourless sale cannot be found at all');
    return 'hidden as a colour, findable by name';
  });

  await check('a term nobody has finds nothing, and % is not a wildcard', async () => {
    const nothing = await sales.list({ store_id: store.id, search: 'zzz-no-such-thing' });
    if (nothing.length !== 0) throw new Error(`${nothing.length} sales matched a nonsense term`);
    // The escaping matters: an unescaped % would return the whole history and read as
    // a search that quietly ignored what was typed.
    const percent = await sales.list({ store_id: store.id, search: '%' });
    if (percent.length !== 0) throw new Error(`a bare % returned ${percent.length} sales`);
  });

  await check('the spreadsheet exports what the screen shows', async () => {
    // The export used to ignore the search entirely, which was survivable while the
    // search ran in the browser and nobody expected the two to agree. It is not
    // survivable now that the search is the filter.
    // The export is one row per sale ITEM, keyed by sale_number rather than by id.
    const rows = await sales.exportExcel({ store_id: store.id, search: findable.product.model_name });
    if (!rows.some((r) => r.sale_number === findSale.sale_number)) {
      throw new Error('the export dropped the matching sale');
    }
    const empty = await sales.exportExcel({ store_id: store.id, search: 'zzz-no-such-thing' });
    if (empty.length !== 0) throw new Error(`the export ignored the search: ${empty.length} rows`);
    return rows.length + ' row(s), not the whole history';
  });

  await check('limit is honoured, and capped', async () => {
    const few = await sales.list({ store_id: store.id, limit: 2 });
    if (few.length > 2) throw new Error(`asked for 2, got ${few.length}`);
    const lots = await sales.list({ store_id: store.id, limit: 100000 });
    if (lots.length > 200) throw new Error(`the 200 cap was ignored: ${lots.length} rows`);
    return '2 when asked, never more than 200';
  });

  // ---------------------------------------------------------------- cleanup
  await knex('notifications').whereIn('id', made.notifications).del();
  await knex('notification_dismissals').where('user_id', user.id).del().catch(() => {});
  for (const id of made.sales) {
    await knex('sale_payments').where('sale_id', id).del();
    await knex('sale_items').where('sale_id', id).del();
    await knex('sales').where('id', id).del();
  }
  await knex('inventory_items').whereIn('id', made.items).del();
  for (const id of made.products) {
    await knex('product_variants').where('product_id', id).del();
    await knex('product_colors').where('product_id', id).del();
    await knex('products').where('id', id).del();
  }
  await knex('customers').whereIn('id', made.customers).del();

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  await knex.destroy();
  process.exit(1);
});
