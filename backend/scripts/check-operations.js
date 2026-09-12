/**
 * Shifts and the drawer, exchanges, stock counts, and PLAN 3.
 *
 * THE LOAD-BEARING CHECKS
 *
 * 1. The drawer. Every way money enters or leaves a till is exercised — cash sale, card
 *    sale, cash refund, expense paid from the till, the owner taking the takings — and
 *    the expected figure is asserted after each one. A cash-up that is merely "present"
 *    is worthless; it has to be RIGHT, and a card sale must not appear in it at all.
 *
 * 2. Exchanges. Stock has to move both ways and the money has to net to zero on an even
 *    swap. Checked by counting the physical pairs, not by trusting a status column.
 *
 * 3. PLAN 3 is enforced on the SERVER. Each guard is attacked with a hand-made request,
 *    because hiding a field in the POS protects nothing.
 *
 * Everything reuses one scratch branch and one scratch product, and resets itself at
 * the start so a crashed run cannot poison the next one. No uploads: local dev writes
 * to a real S3 bucket.
 */

process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const bcrypt = require('bcryptjs');
const shifts = require('../src/modules/shifts/shifts.service');
const sales = require('../src/modules/sales/sales.service');
const returns = require('../src/modules/returns/returns.service');
const expenses = require('../src/modules/expenses/expenses.service');
const exchanges = require('../src/modules/exchanges/exchanges.service');
const counts = require('../src/modules/stock-counts/stock-counts.service');
const discounts = require('../src/modules/discounts/discounts.service');
const reports = require('../src/modules/reports/reports.service');
const intakes = require('../src/modules/stock-intakes/stock-intakes.service');

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
const today = () => businessToday();

async function main() {
  const adminRow = await knex('users as u').join('roles as r', 'r.id', 'u.role_id')
    .where('r.name', 'admin').first('u.id', 'u.full_name');
  const admin = {
    id: adminRow.id, full_name: adminRow.full_name, role_name: 'admin',
    permissions: { all_stores: true }, assigned_stores: [],
  };

  // ---- world --------------------------------------------------------------
  let store = await knex('stores').where('name', 'CHK ops branch').first();
  if (!store) [store] = await knex('stores').insert({ name: 'CHK ops branch', is_active: true }).returning('*');

  const category = await knex('product_categories').where('code', 'shoes').first()
    || await knex('product_categories').first();

  let product = await knex('products').where('product_code', 'CHK-OPS-1').first();
  if (!product) {
    [product] = await knex('products').insert({
      product_code: 'CHK-OPS-1', brand: 'CHK', model_name: 'Ops Test Shoe',
      category_id: category.id, default_selling_price: 500,
      min_selling_price: 300, max_selling_price: 900, is_active: true,
    }).returning('*');
  }
  let color = await knex('product_colors').where({ product_id: product.id, color_name: 'Black' }).first();
  if (!color) [color] = await knex('product_colors').insert({ product_id: product.id, color_name: 'Black' }).returning('*');

  let customer = await knex('customers').where('phone', '01000000777').first();
  if (!customer) [customer] = await knex('customers').insert({ name: 'CHK Ops Customer', phone: '01000000777' }).returning('*');

  let cashier = await knex('users').where('username', 'chk_ops_cashier').first();
  if (!cashier) {
    const employeeRole = await knex('roles').whereNot('id', 1).first() || { id: 1 };
    [cashier] = await knex('users').insert({
      username: 'chk_ops_cashier', full_name: 'CHK Ops Cashier',
      email: 'chk_ops_cashier@story-fixtures.com',
      password_hash: await bcrypt.hash('chkops123', 10),
      role_id: employeeRole.id, store_id: store.id, is_active: true,
    }).returning('*');
  }
  // Explicit permission map: the role name buys nothing in this system.
  const employee = {
    id: cashier.id, full_name: cashier.full_name, role_name: 'employee',
    permissions: { pos: 'write', sales: 'write', shifts: 'write' },
    assigned_stores: [store.id], store_id: store.id,
  };

  /** Wipe everything this suite has made, so exact assertions stay exact. */
  async function reset() {
    const itemIds = await knex('inventory_items as ii')
      .join('product_variants as v', 'v.id', 'ii.variant_id')
      .where('v.product_id', product.id).pluck('ii.id');
    if (itemIds.length) {
      const lineIds = await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('id');
      const saleIds = await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('sale_id');
      if (lineIds.length) await knex('customer_return_items').whereIn('sale_item_id', lineIds).del();
      await knex('exchanges').whereIn('original_sale_id', saleIds).orWhereIn('new_sale_id', saleIds).del();
      const retIds = await knex('customer_returns').whereIn('sale_id', saleIds).pluck('id');
      if (retIds.length) await knex('customer_return_items').whereIn('return_id', retIds).del();
      await knex('customer_returns').whereIn('sale_id', saleIds).del();
      if (saleIds.length) {
        await knex('sale_items').whereIn('sale_id', saleIds).del();
        await knex('sale_payments').whereIn('sale_id', saleIds).del();
        await knex('discount_requests').whereIn('sale_id', saleIds).update({ sale_id: null });
        await knex('sales').whereIn('id', saleIds).del();
      }
      await knex('cost_corrections').where('product_id', product.id).del();
      await knex('stock_count_lines').whereIn('variant_id',
        knex('product_variants').where('product_id', product.id).select('id')).del();
      await knex('inventory_items').whereIn('id', itemIds).del();
    }
    await knex('stock_counts').where('store_id', store.id).del();
    await knex('discount_requests').where('store_id', store.id).del();
    await knex('expenses').where('store_id', store.id).del();
    await knex('cash_movements').where('store_id', store.id).del();
    await knex('sales').where('store_id', store.id).del();
    await knex('shifts').where('store_id', store.id).del();
    const sheets = await knex('stock_intakes').where('store_id', store.id).pluck('id');
    if (sheets.length) {
      await knex('inventory_items').whereIn('intake_id', sheets).del();
      await knex('stock_intake_lines').whereIn('intake_id', sheets).del();
      await knex('stock_intakes').whereIn('id', sheets).del();
    }
    await knex('users').where('id', cashier.id).update({ seller_code_hash: null });
    await knex('stores').where('id', store.id).update({ require_seller_passcode: false });
  }
  await reset();

  /** Put 10 pairs on the shelf at a known cost. */
  async function stockUp(qty = 10, cost = 200) {
    const sheet = await intakes.create({
      store_id: store.id, reason: 'opening', intake_date: today(),
      lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '42',
        quantity: qty, unit_cost: cost, cost_is_estimated: false }],
    }, admin.id);
    await intakes.post(sheet.id, admin.id);
    return knex('inventory_items').where('intake_id', sheet.id).where('status', 'in_stock').pluck('id');
  }

  let pairs = await stockUp(12, 200);

  // ============================================================ shifts
  console.log('');
  console.log('the drawer:');

  let shift;
  await check('opening a shift records the counted float', async () => {
    shift = await shifts.open({ store_id: store.id, opening_float: 500, notes: 'CHK' }, employee.id);
    if (shift.status !== 'open') throw new Error('status ' + shift.status);
    if (money(shift.opening_float) !== 500) throw new Error('float ' + shift.opening_float);
    if (money(shift.position.expected_cash) !== 500) throw new Error('expected ' + shift.position.expected_cash);
    return `${shift.shift_number}, float 500`;
  });

  await check('a second shift at the same branch is refused', async () => {
    try {
      await shifts.open({ store_id: store.id, opening_float: 100 }, employee.id);
      throw new Error('two drawers opened at once');
    } catch (e) {
      if (!/already has a shift open/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  let cashSale;
  await check('a cash sale lands in the drawer AND in the shift', async () => {
    cashSale = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[0], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const row = await knex('sales').where('id', cashSale.id).first();
    if (row.shift_id !== shift.id) throw new Error('the sale was not attached to the shift');
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 1000) throw new Error('expected ' + p.expected_cash);
    return '500 float + 500 cash = 1000';
  });

  let cardSale;
  await check('a CARD sale does not touch the drawer', async () => {
    cardSale = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[1], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'card' }],
    }, admin);
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 1000) throw new Error('a card sale moved the drawer to ' + p.expected_cash);
    if (money(p.non_cash_taken) !== 500) throw new Error('non-cash not reported');
    return 'still 1000, 500 taken on card';
  });

  await check('a cash refund takes money back out', async () => {
    const line = await knex('sale_items').where('sale_id', cashSale.id).first();
    await returns.createCustomerReturn({
      sale_id: cashSale.id, store_id: store.id, refund_method: 'cash',
      reason: 'CHK', items: [{ sale_item_id: line.id, refund_amount: 200 }],
      created_by: admin.id,
    });
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 800) throw new Error('expected ' + p.expected_cash);
    return '1000 - 200 = 800';
  });

  await check('an expense paid FROM THE TILL comes out of the drawer', async () => {
    const cat = await knex('expense_categories').first();
    await expenses.create({
      store_id: store.id, category_id: cat?.id ?? null, amount: 50,
      description: 'CHK plastic bags', expense_date: today(),
      payment_method: 'cash', paid_from_drawer: true,
    }, employee);
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 750) throw new Error('expected ' + p.expected_cash);
    return '800 - 50 = 750';
  });

  await check('an expense NOT paid from the till leaves the drawer alone', async () => {
    const cat = await knex('expense_categories').first();
    await expenses.create({
      store_id: store.id, category_id: cat?.id ?? null, amount: 900,
      description: 'CHK bank transfer', expense_date: today(),
      payment_method: 'bank', paid_from_drawer: false,
    }, admin);
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 750) throw new Error('expected ' + p.expected_cash);
    return 'still 750';
  });

  await check('THE NOTIFICATION: staff spending raises one, the owner spending does not', async () => {
    const forStaff = await knex('notifications')
      .where('type', 'staff_expense').where('created_at', '>', new Date(Date.now() - 300e3));
    if (forStaff.length === 0) throw new Error('no notification for the staff expense');
    const msg = forStaff.map((n) => n.message).join(' ');
    if (!/plastic bags/i.test(msg)) throw new Error('the notification does not name the expense');
    if (/bank transfer/i.test(msg)) throw new Error('the ADMIN expense also raised one');
    return `${forStaff.length} notification(s), and none for the admin's own`;
  });

  await check('the owner taking the takings comes out of the drawer', async () => {
    await shifts.addMovement({
      store_id: store.id, type: 'owner_take', amount: 600, reason: 'CHK owner collection',
    }, admin.id);
    const p = await shifts.cashPosition(shift.id);
    if (money(p.expected_cash) !== 150) throw new Error('expected ' + p.expected_cash);
    if (money(p.taken_out) !== 600) throw new Error('taken_out ' + p.taken_out);
    return '750 - 600 = 150';
  });

  await check('the owner cannot take more than is in the drawer', async () => {
    try {
      await shifts.addMovement({ store_id: store.id, type: 'owner_take', amount: 5000 }, admin.id);
      throw new Error('took out more than the drawer held');
    } catch (e) {
      if (!/should only be/i.test(e.message)) throw e;
      return 'refused, and it says how much is there';
    }
  });

  await check('closing against a counted drawer records the DIFFERENCE', async () => {
    // Counted 140 where 150 was expected: ten short.
    const closed = await shifts.close(shift.id, { counted_cash: 140, notes: 'CHK count' }, employee.id);
    if (closed.status !== 'closed') throw new Error('status ' + closed.status);
    if (money(closed.expected_cash) !== 150) throw new Error('expected ' + closed.expected_cash);
    if (money(closed.counted_cash) !== 140) throw new Error('counted ' + closed.counted_cash);
    if (money(closed.difference) !== -10) throw new Error('difference ' + closed.difference);
    return 'expected 150, counted 140, short 10';
  });

  await check('a closed shift keeps the figure it was closed on', async () => {
    // Void one of the shift's sales AFTER the close. The recorded shortfall must not
    // move: somebody has already investigated that number and written down what they
    // found. (The card sale, because the cash one has a partial return against it and
    // voiding a partly-returned sale is correctly refused.)
    await sales.voidSale(cardSale.id, { reason: 'CHK after close' }, admin);
    const again = await knex('shifts').where('id', shift.id).first();
    if (money(again.expected_cash) !== 150) throw new Error('a settled close was rewritten to ' + again.expected_cash);
    if (money(again.difference) !== -10) throw new Error('difference moved to ' + again.difference);
    return 'still expected 150, short 10';
  });

  await check('closing twice is refused', async () => {
    try {
      await shifts.close(shift.id, { counted_cash: 100 }, employee.id);
      throw new Error('closed twice');
    } catch (e) {
      if (!/already closed/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('cash taken with no shift open is reported, not hidden', async () => {
    await sales.create({
      store_id: store.id,
      items: [{ id: pairs[2], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const loose = await shifts.unassignedCash({ store_id: store.id });
    if (money(loose.amount) !== 500) throw new Error('unassigned ' + loose.amount);
    return '500 EGP belongs to no cash-up';
  });

  await check('cash from before a branch ran cash-ups is history, not loose', async () => {
    // THE BUG THE OWNER HIT: the insight counted every cash sale a branch had ever
    // made with no shift attached — including thousands of EGP rung up before the
    // cash-up feature existed at all, when "no shift" was simply how things were. The
    // frightening total was mostly the past. Unassigned cash is now scoped to sales on
    // or after the branch's FIRST cash-up.
    //
    // A brand-new branch that has never opened a shift must therefore report zero, even
    // with a cash sale sitting against it — there is no cash-up yet for it to miss.
    // Self-contained: it makes its own branch and cleans it up, because the suite's
    // reset only knows about the scratch branch.
    const variant = await knex('product_variants').where('product_id', product.id).first();
    const freshId = knex.raw('gen_random_uuid()');
    const [fresh] = await knex('stores')
      .insert({ id: freshId, name: 'ZZ No-Cashup ' + Date.now(), is_active: true })
      .returning('*');
    let saleId;
    try {
      const [pair] = await knex('inventory_items')
        .insert({ id: knex.raw('gen_random_uuid()'), variant_id: variant.id, store_id: fresh.id,
          cost: 200, source: 'manual', status: 'in_stock' })
        .returning('*');
      const s = await sales.create({
        store_id: fresh.id,
        items: [{ id: pair.id, sale_price: 500 }],
        payments: [{ amount: 500, payment_method: 'cash' }],
      }, admin);
      saleId = s.id;

      const loose = await shifts.unassignedCash({ store_id: fresh.id });
      if (money(loose.amount) !== 0) {
        throw new Error(`a branch with no cash-up reported ${loose.amount} as loose`);
      }
      return 'no cash-up ever → nothing to reconcile → 0';
    } finally {
      if (saleId) {
        await knex('sale_items').where('sale_id', saleId).del();
        await knex('sale_payments').where('sale_id', saleId).del();
        await knex('sales').where('id', saleId).del();
      }
      await knex('inventory_items').where('store_id', fresh.id).del();
      await knex('stores').where('id', fresh.id).del();
    }
  });

  // ============================================================ exchanges
  console.log('');
  console.log('exchanges:');

  let base;
  await check('an EVEN swap moves both pairs and nets to zero', async () => {
    base = await sales.create({
      store_id: store.id, customer_id: customer.id,
      items: [{ id: pairs[3], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const line = await knex('sale_items').where('sale_id', base.id).first();

    const ex = await exchanges.create({
      store_id: store.id,
      original_sale_id: base.id,
      returned: [{ sale_item_id: line.id }],
      new_items: [{ id: pairs[4], sale_price: 500 }],
      reason: 'wrong size',
    }, admin);

    if (money(ex.difference) !== 0) throw new Error('difference ' + ex.difference);
    const back = await knex('inventory_items').where('id', pairs[3]).first();
    const out = await knex('inventory_items').where('id', pairs[4]).first();
    // A returned pair goes back ON THE SHELF, not into a dead status — the whole point
    // is that it can be sold again, and to whichever branch took it back.
    if (back.status !== 'in_stock') throw new Error('the returned pair is ' + back.status);
    if (back.sold_at !== null) throw new Error('the returned pair still looks sold');
    if (back.store_id !== store.id) throw new Error('the returned pair went to the wrong branch');
    if (out.status !== 'sold') throw new Error('the new pair is ' + out.status);
    return `${ex.exchange_number}, 500 for 500, the old pair back on the shelf`;
  });

  await check('an even swap leaves the customer owing nothing', async () => {
    const ex = await knex('exchanges').orderBy('created_at', 'desc').first();
    const sale = await sales.getById(ex.new_sale_id);
    if (money(sale.amount_due) !== 0) {
      throw new Error('the swap left ' + sale.amount_due + ' owing');
    }
    return 'settled by the goods returned';
  });

  await check('swapping UP charges the difference', async () => {
    const s = await sales.create({
      store_id: store.id, customer_id: customer.id,
      items: [{ id: pairs[5], sale_price: 400 }],
      payments: [{ amount: 400, payment_method: 'cash' }],
    }, admin);
    const line = await knex('sale_items').where('sale_id', s.id).first();
    const ex = await exchanges.create({
      store_id: store.id, original_sale_id: s.id,
      returned: [{ sale_item_id: line.id }],
      new_items: [{ id: pairs[6], sale_price: 700 }],
      settlement: 'cash',
    }, admin);
    if (money(ex.difference) !== 300) throw new Error('difference ' + ex.difference);
    const sale = await sales.getById(ex.new_sale_id);
    if (money(sale.amount_due) !== 0) throw new Error('still owing ' + sale.amount_due);
    const cashPaid = sale.payments.find((p) => p.payment_method === 'cash');
    if (money(cashPaid?.amount) !== 300) throw new Error('cash taken ' + cashPaid?.amount);
    return '700 for 400, customer paid 300';
  });

  await check('swapping for a DIFFERENT PRODUCT works the same way', async () => {
    const other = await knex('products').whereNot('id', product.id).where('is_active', true).first();
    const otherPair = await knex('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('pv.product_id', other.id).where('ii.store_id', store.id)
      .where('ii.status', 'in_stock').first('ii.id');
    if (!otherPair) return 'skipped — no second product in stock at this branch';

    const s = await sales.create({
      store_id: store.id, customer_id: customer.id,
      items: [{ id: pairs[7], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const line = await knex('sale_items').where('sale_id', s.id).first();
    const ex = await exchanges.create({
      store_id: store.id, original_sale_id: s.id,
      returned: [{ sale_item_id: line.id }],
      new_items: [{ id: otherPair.id }],
      settlement: 'cash',
    }, admin);
    const detail = await exchanges.getById(ex.id);
    if (detail.new_items[0].product_code === detail.returned_items[0].product_code) {
      throw new Error('the same product came back out');
    }
    return `${detail.returned_items[0].product_code} -> ${detail.new_items[0].product_code}`;
  });

  await check('a reason is optional', async () => {
    const s = await sales.create({
      store_id: store.id, customer_id: customer.id,
      items: [{ id: pairs[8], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const line = await knex('sale_items').where('sale_id', s.id).first();
    const ex = await exchanges.create({
      store_id: store.id, original_sale_id: s.id,
      returned: [{ sale_item_id: line.id }],
      new_items: [{ id: pairs[9], sale_price: 500 }],
    }, admin);
    const row = await knex('exchanges').where('id', ex.id).first();
    if (row.reason) throw new Error('a reason was invented');
    return 'accepted with no reason';
  });

  await check('exchanging against a VOIDED sale is refused', async () => {
    const s = await sales.create({
      store_id: store.id, customer_id: customer.id,
      items: [{ id: pairs[10], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const line = await knex('sale_items').where('sale_id', s.id).first();
    await sales.voidSale(s.id, { reason: 'CHK' }, admin);
    try {
      await exchanges.create({
        store_id: store.id, original_sale_id: s.id,
        returned: [{ sale_item_id: line.id }],
        new_items: [{ id: pairs[11], sale_price: 500 }],
      }, admin);
      throw new Error('exchanged against a cancelled sale');
    } catch (e) {
      if (!/cancelled/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  // ============================================================ stock count
  console.log('');
  console.log('stock take:');

  let count;
  await check('a sheet snapshots what the system believes is there', async () => {
    count = await counts.create({ store_id: store.id, scope: 'product', product_id: product.id }, admin.id);
    const line = count.lines.find((l) => l.product_id === product.id);
    if (!line) throw new Error('the product is not on the sheet');
    const actual = await knex('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('pv.product_id', product.id).where('ii.store_id', store.id)
      .where('ii.status', 'in_stock').count('ii.id as n').first();
    if (line.expected_qty !== Number(actual.n)) {
      throw new Error(`expected ${line.expected_qty}, really ${actual.n}`);
    }
    return `${count.count_number}, expected ${line.expected_qty}`;
  });

  await check('counting FEWER than expected writes the difference off as lost', async () => {
    const line = count.lines[0];
    const short = line.expected_qty - 2;
    await counts.setCounts(count.id, [{ variant_id: line.variant_id, counted_qty: short }]);
    const posted = await counts.post(count.id, admin.id);
    if (posted.summary.lost !== 2) throw new Error('lost ' + posted.summary.lost);
    const lost = await knex('inventory_items').where('stock_count_id', count.id).where('status', 'lost');
    if (lost.length !== 2) throw new Error(lost.length + ' rows marked lost');
    return `2 pairs lost, ${posted.summary.lost_value} EGP`;
  });

  await check('lost stock leaves the shelf but stays in the record', async () => {
    const onShelf = await knex('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('pv.product_id', product.id).where('ii.store_id', store.id)
      .where('ii.status', 'in_stock').count('ii.id as n').first();
    const line = (await counts.getById(count.id)).lines[0];
    if (Number(onShelf.n) !== line.counted_qty) {
      throw new Error(`shelf says ${onShelf.n}, the count said ${line.counted_qty}`);
    }
    return 'the shelf now matches the count';
  });

  await check('counting MORE than expected creates the extra pairs', async () => {
    const c2 = await counts.create({ store_id: store.id, scope: 'product', product_id: product.id }, admin.id);
    const line = c2.lines[0];
    await counts.setCounts(c2.id, [{ variant_id: line.variant_id, counted_qty: line.expected_qty + 3 }]);
    const posted = await counts.post(c2.id, admin.id);
    if (posted.summary.found !== 3) throw new Error('found ' + posted.summary.found);
    const made = await knex('inventory_items').where('stock_count_id', c2.id).where('status', 'in_stock');
    if (made.length !== 3) throw new Error(made.length + ' created');
    if (made.some((m) => !m.cost_is_estimated)) {
      throw new Error('found stock was costed as if somebody knew what it cost');
    }
    return '3 pairs found, costed as an estimate';
  });

  await check('a line left BLANK is not treated as zero', async () => {
    const c3 = await counts.create({ store_id: store.id, scope: 'product', product_id: product.id }, admin.id);
    const before = await knex('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('pv.product_id', product.id).where('ii.store_id', store.id)
      .where('ii.status', 'in_stock').count('ii.id as n').first();
    // Count nothing at all, then post: it must refuse rather than write off the shop.
    try {
      await counts.post(c3.id, admin.id);
      throw new Error('posted a sheet with nothing counted');
    } catch (e) {
      if (!/Nothing has been counted/i.test(e.message)) throw e;
    }
    const after = await knex('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('pv.product_id', product.id).where('ii.store_id', store.id)
      .where('ii.status', 'in_stock').count('ii.id as n').first();
    if (Number(before.n) !== Number(after.n)) throw new Error('stock changed anyway');
    await counts.cancel(c3.id);
    return 'refused, and nothing was written off';
  });

  // ============================================================ PLAN 3
  console.log('');
  console.log('PLAN 3 — priced by role, discounts approved, sellers identified:');

  pairs = await stockUp(8, 200);

  await check('an employee cannot change a price, even by hand-made request', async () => {
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[0], sale_price: 350 }],   // inside the band, but not the default
        payments: [{ amount: 350, payment_method: 'cash' }],
      }, employee);
      throw new Error('an employee set their own price');
    } catch (e) {
      if (!/cannot change the price/i.test(e.message)) throw e;
      return 'refused on the server';
    }
  });

  await check('an employee CAN sell at the default price', async () => {
    const s = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[0], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, employee);
    if (!s.id) throw new Error('no sale');
    return 'sold at 500';
  });

  await check('someone with price_override can, within the band', async () => {
    const manager = { ...employee, id: admin.id, permissions: { ...employee.permissions, price_override: 'write' } };
    const s = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[1], sale_price: 350 }],
      payments: [{ amount: 350, payment_method: 'cash' }],
    }, manager);
    if (!s.id) throw new Error('no sale');
    return 'sold at 350';
  });

  await check('and still not outside it', async () => {
    const manager = { ...employee, id: admin.id, permissions: { ...employee.permissions, price_override: 'write' } };
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[2], sale_price: 100 }],   // below min_selling_price 300
        payments: [{ amount: 100, payment_method: 'cash' }],
      }, manager);
      throw new Error('sold below the floor');
    } catch (e) {
      if (!/minimum allowed/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('an employee cannot discount on their own', async () => {
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[2], sale_price: 500 }],
        discount_amount: 100,
        payments: [{ amount: 400, payment_method: 'cash' }],
      }, employee);
      throw new Error('an employee discounted unaided');
    } catch (e) {
      if (!/manager to approve/i.test(e.message)) throw e;
      return 'refused, and it says what to do';
    }
  });

  let request;
  await check('they can ask, and a manager can approve for less', async () => {
    request = await discounts.request({
      store_id: store.id,
      items: [{ id: pairs[2], sale_price: 500 }],
      requested_discount: 100,
      reason: 'CHK regular customer',
    }, employee);
    if (request.status !== 'pending') throw new Error('status ' + request.status);
    const decided = await discounts.decide(request.id, { approve: true, amount: 60 }, admin);
    if (decided.status !== 'approved') throw new Error('status ' + decided.status);
    if (money(decided.approved_discount) !== 60) throw new Error('approved ' + decided.approved_discount);
    return 'asked 100, approved 60';
  });

  await check('the approval lets the sale through — for the approved amount only', async () => {
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[2], sale_price: 500 }],
        discount_amount: 100, discount_request_id: request.id,
        payments: [{ amount: 400, payment_method: 'cash' }],
      }, employee);
      throw new Error('spent more than was approved');
    } catch (e) {
      if (!/Only 60/i.test(e.message)) throw e;
    }
    const s = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[2], sale_price: 500 }],
      discount_amount: 60, discount_request_id: request.id,
      payments: [{ amount: 440, payment_method: 'cash' }],
    }, employee);
    if (money(s.final_amount) !== 440) throw new Error('final ' + s.final_amount);
    return 'sold at 440';
  });

  await check('an approval cannot be spent twice', async () => {
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[3], sale_price: 500 }],
        discount_amount: 60, discount_request_id: request.id,
        payments: [{ amount: 440, payment_method: 'cash' }],
      }, employee);
      throw new Error('one approval bought two discounts');
    } catch (e) {
      if (!/already been used/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a parked cart holds no stock, and says what has gone', async () => {
    const parked = await discounts.request({
      store_id: store.id,
      items: [{ id: pairs[4], sale_price: 500 }, { id: pairs[5], sale_price: 500 }],
      requested_discount: 50,
    }, employee);
    await discounts.decide(parked.id, { approve: true }, admin);
    // Somebody else sells one of them while the cart is parked.
    await sales.create({
      store_id: store.id,
      items: [{ id: pairs[4], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
    }, admin);
    const resumed = await discounts.resume(parked.id, employee);
    if (resumed.resumable) throw new Error('claimed to be resumable with a sold pair in it');
    if (resumed.unavailable_items.length !== 1) throw new Error('named ' + resumed.unavailable_items.length);
    if (resumed.available_items.length !== 1) throw new Error('lost the pair that is still there');
    return 'one pair gone, named; the other still available';
  });

  await check('a rejected request cannot be used at all', async () => {
    const asked = await discounts.request({
      store_id: store.id, items: [{ id: pairs[6], sale_price: 500 }], requested_discount: 50,
    }, employee);
    await discounts.decide(asked.id, { approve: false, note: 'no' }, admin);
    try {
      await sales.create({
        store_id: store.id,
        items: [{ id: pairs[6], sale_price: 500 }],
        discount_amount: 50, discount_request_id: asked.id,
        payments: [{ amount: 450, payment_method: 'cash' }],
      }, employee);
      throw new Error('a refused discount was applied');
    } catch (e) {
      if (!/rejected, not approved/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a seller code credits the sale to the person, not the login', async () => {
    await discounts.setSellerCode(cashier.id, 'ma456');
    await knex('stores').where('id', store.id).update({ require_seller_passcode: true });

    const s = await sales.create({
      store_id: store.id,
      items: [{ id: pairs[7], sale_price: 500 }],
      payments: [{ amount: 500, payment_method: 'cash' }],
      seller_code: 'ma456',
    }, admin);                                   // rung up on the ADMIN's session
    const row = await knex('sales').where('id', s.id).first();
    if (row.created_by !== admin.id) throw new Error('created_by was overwritten');
    if (row.sold_by !== cashier.id) throw new Error('sold_by is ' + row.sold_by);
    return 'rung by admin, credited to the cashier';
  });

  await check('a wrong code is refused, and a missing one is asked for', async () => {
    const pair = (await stockUp(2, 200))[0];
    try {
      await sales.create({
        store_id: store.id, items: [{ id: pair, sale_price: 500 }],
        payments: [{ amount: 500, payment_method: 'cash' }], seller_code: 'nope9',
      }, admin);
      throw new Error('an unknown code was accepted');
    } catch (e) {
      if (!/not recognised/i.test(e.message)) throw e;
    }
    try {
      await sales.create({
        store_id: store.id, items: [{ id: pair, sale_price: 500 }],
        payments: [{ amount: 500, payment_method: 'cash' }],
      }, admin);
      throw new Error('no code was required');
    } catch (e) {
      if (!/Enter your selling code/i.test(e.message)) throw e;
    }
    await knex('stores').where('id', store.id).update({ require_seller_passcode: false });
    return 'both refused';
  });

  await check('a code is never stored where it can be read back', async () => {
    const row = await knex('users').where('id', cashier.id).first('seller_code_hash');
    if (!row.seller_code_hash) throw new Error('no code stored');
    if (row.seller_code_hash === 'ma456') throw new Error('THE CODE IS IN PLAIN TEXT');
    if (!row.seller_code_hash.startsWith('$2')) throw new Error('not a bcrypt hash');
    const sellers = await discounts.sellersAt(store.id);
    if (JSON.stringify(sellers).includes('ma456')) throw new Error('the list leaks the code');
    return 'bcrypt, and the roster only says who has one';
  });

  // ============================================================ reports
  console.log('');
  console.log('reorder signals and insights:');

  await check('days of cover drives the answer, not a bare stock number', async () => {
    const r = await reports.getReorderSignals({ store_id: store.id, window_days: 30 });
    const row = [...r.buy, ...r.dead, ...r.overstocked].find((x) => x.product_id === product.id)
      || null;
    if (!row) {
      // Not urgent is a legitimate answer; assert the shape instead.
      if (!Array.isArray(r.buy)) throw new Error('no buy list');
      return 'nothing urgent for the scratch product';
    }
    if (row.days_cover !== null && row.weekly_rate === 0) {
      throw new Error('a product with no sales was given a cover figure');
    }
    return `${row.product_code}: ${row.on_hand} on hand, ${row.weekly_rate}/week, cover ${row.days_cover}`;
  });

  await check('a product that never sells is DEAD, not urgent', async () => {
    const r = await reports.getReorderSignals({ store_id: store.id, window_days: 7, dead_after_days: 1 });
    const wrong = r.buy.find((x) => x.weekly_rate === 0 && x.on_hand > 0);
    if (wrong) throw new Error(`${wrong.product_code} is on the shopping list with no sales at all`);
    return `${r.dead.length} dead, ${r.buy.length} to buy`;
  });

  await check('insights are ranked, and say something in words', async () => {
    const { insights } = await reports.getInsights({ store_id: store.id });
    if (!Array.isArray(insights)) throw new Error('no insights');
    for (const i of insights) {
      if (!i.title || !i.severity) throw new Error('an insight has no title or severity');
      if (/undefined|NaN|\[object/.test(i.title + i.detail)) throw new Error('a broken string: ' + i.title);
    }
    const rank = { critical: 0, warning: 1, good: 2, info: 3 };
    for (let i = 1; i < insights.length; i++) {
      if (rank[insights[i - 1].severity] > rank[insights[i].severity]) {
        throw new Error('not ranked by severity');
      }
    }
    return `${insights.length}: ` + insights.slice(0, 2).map((i) => i.key).join(', ');
  });

  await check('the cash difference reaches the insights', async () => {
    const { insights } = await reports.getInsights({ store_id: store.id });
    const short = insights.find((i) => i.key === 'cash_short');
    const loose = insights.find((i) => i.key === 'unassigned_cash');
    if (!short) throw new Error('a 10 EGP shortfall was not surfaced');
    if (!loose) throw new Error('cash taken with no shift open was not surfaced');
    return `${short.title}; ${loose.title}`;
  });

  await reset();

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
