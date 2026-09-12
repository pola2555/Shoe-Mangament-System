/**
 * Stock intakes, guessed costs, and the corrections that replace them.
 *
 * THE LOAD-BEARING CHECK is "a real invoice heals the guess, and every reported figure
 * moves with it". Correcting a cost has to reach `inventory_items`, `sale_items` and
 * therefore every report — and reverting has to put all of it back exactly. So rather
 * than asserting that some column was written, this snapshots the reported profit,
 * corrects, asserts the profit moved by precisely the expected amount, reverts, and
 * asserts it came back to the byte.
 *
 * Everything is reused: one scratch branch, one scratch product, one supplier. Run it
 * twice and the row counts do not move.
 *
 * Nothing here uploads anything — local dev writes to a real S3 bucket.
 */

process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const intakes = require('../src/modules/stock-intakes/stock-intakes.service');
const purchases = require('../src/modules/purchases/purchases.service');
const sales = require('../src/modules/sales/sales.service');
const reports = require('../src/modules/reports/reports.service');
const { resetCapabilities } = require('../src/utils/schemaCapabilities');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}  -> ${error.message}`);
  }
}

const ADMIN_PERMS = { all_stores: true };
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Today, as the SHOP reckons it — not as UTC does.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date. This machine and the shop
 * both run at UTC+3, so between midnight and 03:00 local it returns YESTERDAY, while
 * the reports these checks query use business-day boundaries and correctly say today.
 * The result was three failures that appear only in a three-hour window overnight and
 * vanish by morning — the worst possible shape for a test.
 *
 * The application code already fixed this class of bug (config/pgTypes.js,
 * frontend/src/utils/dates.js); the check scripts were left behind.
 */
function businessToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}


async function main() {
  resetCapabilities();

  const user = await knex('users').where('username', 'admin').first()
    || await knex('users').first();
  const admin = { id: user.id, role_name: 'admin', permissions: ADMIN_PERMS, assigned_stores: [] };

  // ---- the world, reused between runs -------------------------------------
  let store = await knex('stores').where('name', 'CHK intake branch').first();
  if (!store) {
    [store] = await knex('stores').insert({
      name: 'CHK intake branch', is_active: true,
    }).returning('*');
  }

  let supplier = await knex('suppliers').where('name', 'CHK intake supplier').first();
  if (!supplier) {
    [supplier] = await knex('suppliers').insert({ name: 'CHK intake supplier' }).returning('*');
  }

  const category = await knex('product_categories').where('code', 'shoes').first()
    || await knex('product_categories').first();

  const CODE = 'CHK-INTAKE-1';
  let product = await knex('products').where('product_code', CODE).first();
  if (!product) {
    [product] = await knex('products').insert({
      product_code: CODE, brand: 'CHK', model_name: 'Intake Test Shoe',
      category_id: category.id, default_selling_price: 500,
      min_selling_price: 0, max_selling_price: 100000, is_active: true,
    }).returning('*');
  }
  let color = await knex('product_colors').where({ product_id: product.id, color_name: 'Black' }).first();
  if (!color) {
    [color] = await knex('product_colors')
      .insert({ product_id: product.id, color_name: 'Black' }).returning('*');
  }

  // Leave nothing behind: every sheet and sale this run makes is undone at the end.
  const made = { intakes: [], sales: [], invoices: [] };

  /**
   * Wipe everything this suite has ever created for the scratch product.
   *
   * Run at the START as well as the end. The assertions here are exact — "the profit
   * moved by exactly 50", "5 corrections were logged" — and an earlier run that died
   * before its cleanup leaves stock behind that the next run's invoice then heals as
   * well, turning a real pass into a confusing failure about the wrong number. Doing it
   * up front means a crashed run cannot poison the next one.
   */
  async function resetWorld() {
    const itemIds = await knex('inventory_items as ii')
      .join('product_variants as v', 'v.id', 'ii.variant_id')
      .where('v.product_id', product.id)
      .pluck('ii.id');

    if (itemIds.length) {
      const saleIds = await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('sale_id');
      const lineIds = await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('id');
      if (lineIds.length) {
        await knex('customer_return_items').whereIn('sale_item_id', lineIds).del();
      }
      if (saleIds.length) {
        await knex('sale_items').whereIn('sale_id', saleIds).del();
        await knex('sale_payments').whereIn('sale_id', saleIds).del();
        await knex('sales').whereIn('id', saleIds).del();
      }
      // cost_corrections cascade from inventory_items, but delete explicitly so the
      // product is clean even where a pair has already gone.
      await knex('cost_corrections').where('product_id', product.id).del();
      await knex('inventory_items').whereIn('id', itemIds).del();
    }
    await knex('cost_corrections').where('product_id', product.id).del();

    const invIds = await knex('purchase_invoices').where('supplier_id', supplier.id).pluck('id');
    if (invIds.length) {
      const boxIds = await knex('purchase_invoice_boxes').whereIn('invoice_id', invIds).pluck('id');
      if (boxIds.length) {
        await knex('inventory_items').whereIn('invoice_box_id', boxIds).del();
        await knex('box_items').whereIn('invoice_box_id', boxIds).del();
        await knex('purchase_invoice_boxes').whereIn('id', boxIds).del();
      }
      await knex('supplier_payment_allocations').whereIn('invoice_id', invIds).del();
      await knex('purchase_invoices').whereIn('id', invIds).del();
    }

    const sheetIds = await knex('stock_intakes').where('store_id', store.id).pluck('id');
    if (sheetIds.length) {
      await knex('inventory_items').whereIn('intake_id', sheetIds).del();
      await knex('stock_intake_lines').whereIn('intake_id', sheetIds).del();
      await knex('stock_intakes').whereIn('id', sheetIds).del();
    }

    await knex('notifications').whereIn('type', ['cost_corrected']).del();
  }

  await resetWorld();

  console.log('');
  console.log('the sheet:');

  let sheet;
  await check('a draft creates no stock at all', async () => {
    const before = await knex('inventory_items')
      .join('product_variants as v', 'v.id', 'inventory_items.variant_id')
      .where('v.product_id', product.id).count('inventory_items.id as n').first();

    sheet = await intakes.create({
      store_id: store.id,
      supplier_id: supplier.id,
      reason: 'opening',
      intake_date: businessToday(),
      notes: 'CHK opening stock',
      lines: [
        { product_id: product.id, product_color_id: color.id, size_eu: '42', quantity: 3, unit_cost: 300, cost_is_estimated: true },
        { product_id: product.id, product_color_id: color.id, size_eu: '43', quantity: 2, unit_cost: 300, cost_is_estimated: true },
      ],
    }, admin.id);
    made.intakes.push(sheet.id);

    const after = await knex('inventory_items')
      .join('product_variants as v', 'v.id', 'inventory_items.variant_id')
      .where('v.product_id', product.id).count('inventory_items.id as n').first();
    if (Number(before.n) !== Number(after.n)) throw new Error('a draft created stock');
    if (sheet.status !== 'draft') throw new Error('status is ' + sheet.status);
    if (sheet.total_units !== 5) throw new Error('units ' + sheet.total_units);
    return `${sheet.intake_number}, ${sheet.total_units} units, ${sheet.total_value} EGP`;
  });

  await check('an intake creates no supplier debt', async () => {
    // The whole point of the feature: the supplier is a note about where the goods came
    // from, not a party we now owe money to. A fake purchase invoice would have created
    // a payable that was never owed.
    const owed = await knex('purchase_invoices').where('supplier_id', supplier.id).count('id as n').first();
    if (Number(owed.n) !== 0) throw new Error(`${owed.n} invoice(s) appeared`);
    const payments = await knex('supplier_payments').where('supplier_id', supplier.id).count('id as n').first();
    if (Number(payments.n) !== 0) throw new Error('a supplier payment appeared');
    return 'no payable, no payment';
  });

  await check('posting creates exactly one pair per unit', async () => {
    const posted = await intakes.post(sheet.id, admin.id);
    if (posted.status !== 'posted') throw new Error('status ' + posted.status);
    const items = await knex('inventory_items').where('intake_id', sheet.id);
    if (items.length !== 5) throw new Error('created ' + items.length);
    if (items.some((i) => i.status !== 'in_stock')) throw new Error('not all in stock');
    if (items.some((i) => i.store_id !== store.id)) throw new Error('wrong branch');
    if (items.some((i) => i.source !== 'manual')) throw new Error('source not manual');
    if (items.some((i) => !i.cost_is_estimated)) throw new Error('not marked as a guess');
    return '5 pairs, all marked estimated';
  });

  await check('every pair it created got a barcode, like a received one', async () => {
    const variants = await knex('stock_intake_lines').where('intake_id', sheet.id).pluck('variant_id');
    const rows = await knex('product_variants').whereIn('id', variants).select('barcode', 'sku');
    if (rows.some((r) => !r.barcode)) throw new Error('a variant has no barcode');
    if (rows.some((r) => !/^\d{13}$/.test(r.barcode))) throw new Error('not an EAN-13');
    return rows.map((r) => r.sku).join(', ');
  });

  await check('posting twice is refused', async () => {
    try {
      await intakes.post(sheet.id, admin.id);
      throw new Error('posted a second time');
    } catch (e) {
      if (!/already been posted/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('the sheet LIST returns its totals', async () => {
    // The list runs one grouped aggregate over the lines. A malformed alias there made
    // the whole endpoint 500 while every other test still passed, because nothing
    // asserted on the list itself — the page just showed an error toast.
    const list = await intakes.list({ store_id: store.id });
    const row = list.data.find((r) => r.id === sheet.id);
    if (!row) throw new Error('the sheet is not in its own list');
    if (row.total_units !== 5) throw new Error('total_units ' + row.total_units);
    if (money(row.total_value) !== 1500) throw new Error('total_value ' + row.total_value);
    if (row.estimated_units !== 5) throw new Error('estimated_units ' + row.estimated_units);
    return `${row.total_units} units, ${row.total_value} EGP, ${row.estimated_units} guessed`;
  });

  await check('a posted sheet can no longer be edited', async () => {
    try {
      await intakes.update(sheet.id, { notes: 'nope' });
      throw new Error('edited a posted sheet');
    } catch (e) {
      if (!/no longer be edited/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  console.log('');
  console.log('reversing:');

  let scratch;
  await check('an untouched posted sheet reverses cleanly', async () => {
    scratch = await intakes.create({
      store_id: store.id, reason: 'found',
      intake_date: businessToday(),
      lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '44', quantity: 2, unit_cost: 310 }],
    }, admin.id);
    await intakes.post(scratch.id, admin.id);
    const before = await knex('inventory_items').where('intake_id', scratch.id).count('id as n').first();
    await intakes.reverse(scratch.id, 'CHK undo', admin.id);
    const after = await knex('inventory_items').where('intake_id', scratch.id).count('id as n').first();
    if (Number(before.n) !== 2 || Number(after.n) !== 0) {
      throw new Error(`before ${before.n}, after ${after.n}`);
    }
    return '2 pairs in, 2 pairs gone';
  });

  await check('a sheet whose stock has sold refuses to reverse', async () => {
    const pair = await knex('inventory_items').where('intake_id', sheet.id).where('status', 'in_stock').first();
    const sale = await sales.create({
      store_id: store.id,
      items: [{ id: pair.id, sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);
    try {
      await intakes.reverse(sheet.id, 'should fail', admin.id);
      throw new Error('reversed a sheet with a sold pair');
    } catch (e) {
      if (!/already been sold/i.test(e.message)) throw e;
      return 'refused, and it names how many';
    }
  });

  await check('a sheet whose stock was sold then VOIDED still refuses to reverse', async () => {
    // Voiding puts the pair back in stock, so the "has it moved?" check passes — but the
    // voided sale keeps its line as the record of what happened, and that line still
    // points at the pair. Deleting it would orphan a document, and the database would
    // refuse with a bare foreign-key error rather than anything a person could act on.
    const saleId = made.sales[0];
    await sales.voidSale(saleId, { reason: 'CHK void then reverse' }, admin);
    try {
      await intakes.reverse(sheet.id, 'should still fail', admin.id);
      throw new Error('reversed a sheet whose stock appears on a cancelled sale');
    } catch (e) {
      if (!/appear on a sale/i.test(e.message)) throw e;
      return 'refused, and it explains why';
    } finally {
      // Put the sale back so the rest of the run reads as it did before.
      await knex('sales').where('id', saleId).update({ voided_at: null, voided_by: null, void_reason: null });
      const lines = await knex('sale_items').where('sale_id', saleId).pluck('inventory_item_id');
      await knex('inventory_items').whereIn('id', lines).update({ status: 'sold' });
    }
  });

  console.log('');
  console.log('the guessed cost reaching a sale:');

  await check('a sale of a guessed pair carries the mark onto its line', async () => {
    const line = await knex('sale_items').where('sale_id', made.sales[0]).first();
    if (!line.cost_is_estimated) throw new Error('the sale line is not marked');
    if (money(line.cost_at_sale) !== 300) throw new Error('cost_at_sale ' + line.cost_at_sale);
    return 'marked, cost 300';
  });

  await check('the report says how much profit rests on a guess', async () => {
    const today = businessToday();
    const basis = await reports.getCostBasis({ startDate: today, endDate: today, store_id: store.id });
    if (basis.estimated_items < 1) throw new Error('reported 0 estimated items');
    if (basis.estimated_share_pct === null) throw new Error('no share reported');
    return `${basis.estimated_items} of ${basis.total_items} items (${basis.estimated_share_pct}%)`;
  });

  console.log('');
  console.log('THE LOAD-BEARING ONE — a real invoice heals the guess:');

  const today = businessToday();
  let profitBefore;
  let healBatch;

  await check('profit is snapshotted before anything is corrected', async () => {
    const fin = await reports.getFinancialReport({ startDate: today, endDate: today, store_id: store.id });
    profitBefore = money(fin.summary.gross_profit);
    return 'profit ' + profitBefore;
  });

  await check('receiving the product at a real cost replaces every guess', async () => {
    // A real purchase at 350, where the guess was 300.
    const invoice = await purchases.createInvoice({
      supplier_id: supplier.id, total_amount: 700, invoice_date: today,
      boxes: [{ product_id: product.id, cost_per_item: 350, total_items: 2, destination_store_id: store.id }],
    }, admin.id);
    made.invoices.push(invoice.id);

    const box = (await knex('purchase_invoice_boxes').where('invoice_id', invoice.id))[0];
    await purchases.setBoxItems(box.id, [
      { product_color_id: color.id, size_eu: '42', quantity: 2 },
    ]);
    await purchases.completeBox(box.id);

    const stillGuessed = await knex('inventory_items as ii')
      .join('product_variants as v', 'v.id', 'ii.variant_id')
      .where('v.product_id', product.id)
      .where('ii.cost_is_estimated', true)
      .count('ii.id as n').first();
    if (Number(stillGuessed.n) !== 0) throw new Error(stillGuessed.n + ' guesses survived');

    const corr = await knex('cost_corrections').where('product_id', product.id).whereNull('reverted_at');
    if (corr.length === 0) throw new Error('nothing was logged');
    healBatch = corr[0].batch_id;
    return `${corr.length} corrections logged, 300 -> 350`;
  });

  await check('the ALREADY SOLD pair had its sale line corrected too', async () => {
    const line = await knex('sale_items').where('sale_id', made.sales[0]).first();
    if (money(line.cost_at_sale) !== 350) throw new Error('cost_at_sale is still ' + line.cost_at_sale);
    if (line.cost_is_estimated) throw new Error('still marked as a guess');
    return 'cost_at_sale 300 -> 350';
  });

  await check('and the reported profit moved by exactly the difference', async () => {
    const fin = await reports.getFinancialReport({ startDate: today, endDate: today, store_id: store.id });
    const after = money(fin.summary.gross_profit);
    // One pair sold, cost up by 50, so profit is 50 lower.
    const expected = money(profitBefore - 50);
    if (after !== expected) throw new Error(`profit ${after}, expected ${expected} (was ${profitBefore})`);
    return `${profitBefore} -> ${after}`;
  });

  await check('the report now says the period was restated, and when', async () => {
    const basis = await reports.getCostBasis({ startDate: today, endDate: today, store_id: store.id });
    if (!basis.restated_at) throw new Error('no restatement recorded');
    if (basis.restated_items < 1) throw new Error('0 restated items');
    if (money(basis.restated_cost_delta) !== 50) throw new Error('delta ' + basis.restated_cost_delta);
    return `${basis.restated_items} item(s), cost up by ${basis.restated_cost_delta}`;
  });

  await check('nothing is left resting on a guess', async () => {
    const basis = await reports.getCostBasis({ startDate: today, endDate: today, store_id: store.id });
    if (basis.estimated_items !== 0) throw new Error(basis.estimated_items + ' still estimated');
    return '0 estimated';
  });

  console.log('');
  console.log('undo:');

  await check('reverting a correction puts the profit back exactly', async () => {
    await intakes.revertCorrection(healBatch, admin.id);
    const fin = await reports.getFinancialReport({ startDate: today, endDate: today, store_id: store.id });
    const after = money(fin.summary.gross_profit);
    if (after !== profitBefore) throw new Error(`profit ${after}, expected ${profitBefore}`);
    return `back to ${profitBefore}`;
  });

  await check('and the guess mark comes back with it', async () => {
    const line = await knex('sale_items').where('sale_id', made.sales[0]).first();
    if (money(line.cost_at_sale) !== 300) throw new Error('cost_at_sale ' + line.cost_at_sale);
    if (!line.cost_is_estimated) throw new Error('mark not restored');
    const shelf = await knex('inventory_items').where('intake_id', sheet.id).where('status', 'in_stock');
    if (shelf.some((i) => !i.cost_is_estimated)) throw new Error('a shelf pair kept the real cost');
    return 'guess restored on the sale line and on the shelf';
  });

  await check('reverting twice changes nothing more', async () => {
    const again = await intakes.revertCorrection(healBatch, admin.id);
    if (again.reverted !== 0) throw new Error('reverted ' + again.reverted + ' a second time');
    return 'idempotent';
  });

  console.log('');
  console.log('THE RULE — a real cost is history and is never rewritten:');

  await check('a pair bought on an invoice is never re-costed by a later one', async () => {
    // The two pairs received above came in at a REAL 350. Receive again at 400.
    const invoice = await purchases.createInvoice({
      supplier_id: supplier.id, total_amount: 400, invoice_date: today,
      boxes: [{ product_id: product.id, cost_per_item: 400, total_items: 1, destination_store_id: store.id }],
    }, admin.id);
    made.invoices.push(invoice.id);
    const box = (await knex('purchase_invoice_boxes').where('invoice_id', invoice.id))[0];
    await purchases.setBoxItems(box.id, [{ product_color_id: color.id, size_eu: '42', quantity: 1 }]);
    await purchases.completeBox(box.id);

    const real350 = await knex('inventory_items as ii')
      .join('product_variants as v', 'v.id', 'ii.variant_id')
      .where('v.product_id', product.id)
      .where('ii.cost_is_estimated', false)
      .where('ii.cost', 350)
      .count('ii.id as n').first();
    if (Number(real350.n) < 2) throw new Error('the invoiced pairs at 350 were overwritten');
    return 'the 350 pairs kept 350 while a 400 invoice landed';
  });

  await check('a past sale of a real-cost pair is never touched', async () => {
    const pair = await knex('inventory_items as ii')
      .join('product_variants as v', 'v.id', 'ii.variant_id')
      .where('v.product_id', product.id)
      .where('ii.cost_is_estimated', false)
      .where('ii.status', 'in_stock')
      .first('ii.id');
    const sale = await sales.create({
      store_id: store.id,
      items: [{ id: pair.id, sale_price: 600 }],
      payments: [{ amount: 600, payment_method: 'cash' }],
    }, admin);
    made.sales.push(sale.id);
    const line = await knex('sale_items').where('sale_id', sale.id).first();
    const costWhenSold = money(line.cost_at_sale);

    const invoice = await purchases.createInvoice({
      supplier_id: supplier.id, total_amount: 900, invoice_date: today,
      boxes: [{ product_id: product.id, cost_per_item: 900, total_items: 1, destination_store_id: store.id }],
    }, admin.id);
    made.invoices.push(invoice.id);
    const box = (await knex('purchase_invoice_boxes').where('invoice_id', invoice.id))[0];
    await purchases.setBoxItems(box.id, [{ product_color_id: color.id, size_eu: '42', quantity: 1 }]);
    await purchases.completeBox(box.id);

    const after = await knex('sale_items').where('sale_id', sale.id).first();
    if (money(after.cost_at_sale) !== costWhenSold) {
      throw new Error(`a real cost was rewritten: ${costWhenSold} -> ${after.cost_at_sale}`);
    }
    return `sold at cost ${costWhenSold}, still ${costWhenSold} after a 900 invoice`;
  });

  await check('the old net_price notification still fires, untouched', async () => {
    const n = await knex('notifications')
      .where('type', 'price_update')
      .where('reference_id', product.id)
      .count('id as n').first();
    if (Number(n.n) === 0) throw new Error('the existing cost-change notification stopped firing');
    return Number(n.n) + ' price_update notification(s)';
  });

  await check('the correction has its own notification with an undo target', async () => {
    const n = await knex('notifications').where('type', 'cost_corrected').orderBy('created_at', 'desc').first();
    if (!n) throw new Error('no cost_corrected notification');
    if (!n.reference_id) throw new Error('nothing to undo');
    const batch = await knex('cost_corrections').where('batch_id', n.reference_id).first();
    if (!batch) throw new Error('reference_id is not a correction batch');
    return 'links to its batch';
  });

  console.log('');
  console.log('costing help, and what is still a guess:');

  await check('the cost hint prefers a real invoice over any guess', async () => {
    const hint = await intakes.costHint(product.id, { store_id: store.id });
    if (hint.source !== 'purchase') throw new Error('source is ' + hint.source);
    if (hint.cost_is_estimated) throw new Error('an invoiced cost came back marked as a guess');
    if (!hint.source_label) throw new Error('it does not say which invoice');
    return `${hint.unit_cost} from ${hint.source_label}`;
  });

  await check('a line marked KNOWN is never healed', async () => {
    const known = await intakes.create({
      store_id: store.id, reason: 'opening', intake_date: today,
      lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '45', quantity: 1, unit_cost: 123, cost_is_estimated: false }],
    }, admin.id);
    made.intakes.push(known.id);
    await intakes.post(known.id, admin.id);

    const invoice = await purchases.createInvoice({
      supplier_id: supplier.id, total_amount: 999, invoice_date: today,
      boxes: [{ product_id: product.id, cost_per_item: 999, total_items: 1, destination_store_id: store.id }],
    }, admin.id);
    made.invoices.push(invoice.id);
    const box = (await knex('purchase_invoice_boxes').where('invoice_id', invoice.id))[0];
    await purchases.setBoxItems(box.id, [{ product_color_id: color.id, size_eu: '42', quantity: 1 }]);
    await purchases.completeBox(box.id);

    const item = await knex('inventory_items').where('intake_id', known.id).first();
    if (money(item.cost) !== 123) throw new Error('a known cost was overwritten to ' + item.cost);
    return 'still 123 after a 999 invoice';
  });

  await check('the estimated summary lists what is still a guess', async () => {
    const guessed = await intakes.create({
      store_id: store.id, reason: 'opening', intake_date: today,
      lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '41', quantity: 4, unit_cost: 280 }],
    }, admin.id);
    made.intakes.push(guessed.id);
    await intakes.post(guessed.id, admin.id);

    const rows = await intakes.estimatedSummary({ store_id: store.id });
    const row = rows.find((r) => r.product_id === product.id);
    if (!row) throw new Error('the product is not listed');
    if (row.pairs < 4) throw new Error('pairs ' + row.pairs);
    return `${row.pairs} pair(s), ${row.guessed_value} EGP guessed`;
  });

  await check('a guess can be corrected by hand and logged like any other', async () => {
    const res = await intakes.recost(product.id, {
      unit_cost: 290, still_estimated: false, store_id: store.id,
    }, admin.id);
    if (res.pairs < 4) throw new Error('touched ' + res.pairs);
    const left = await intakes.estimatedSummary({ store_id: store.id });
    if (left.find((r) => r.product_id === product.id)) throw new Error('still listed as a guess');
    const logged = await knex('cost_corrections').where('batch_id', res.batch_id).count('id as n').first();
    if (Number(logged.n) === 0) throw new Error('the manual re-cost was not logged');
    return `${res.pairs} pair(s) set to 290 and marked known`;
  });

  console.log('');
  console.log('scoping and guards:');

  await check('a sheet with no lines refuses to post', async () => {
    const empty = await intakes.create({ store_id: store.id, intake_date: today, lines: [] }, admin.id);
    made.intakes.push(empty.id);
    try {
      await intakes.post(empty.id, admin.id);
      throw new Error('posted an empty sheet');
    } catch (e) {
      if (!/at least one line/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a line with no cost is refused', async () => {
    try {
      await intakes.create({
        store_id: store.id, intake_date: today,
        lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '42', quantity: 1, unit_cost: 'abc' }],
      }, admin.id);
      throw new Error('accepted a line with no cost');
    } catch (e) {
      if (!/needs a cost/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a user scoped elsewhere cannot see this branch sheets', async () => {
    const other = await knex('stores').whereNot('id', store.id).first();
    const list = await intakes.list({ store_id: other.id });
    if (list.data.some((r) => r.store_id === store.id)) throw new Error('leaked across branches');
    return 'scoped';
  });

  await check('an unknown reason is refused', async () => {
    try {
      await intakes.create({ store_id: store.id, intake_date: today, reason: 'because', lines: [] }, admin.id);
      throw new Error('accepted an unknown reason');
    } catch (e) {
      if (!/Unknown intake reason/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  // ---- put the world back -------------------------------------------------
  // Same routine the run started with, so two consecutive runs see identical counts.
  await resetWorld();
  await knex('notifications').where('type', 'price_update')
    .where('reference_id', product.id).del().catch(() => {});

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
