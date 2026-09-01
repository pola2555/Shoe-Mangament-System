/*
 * Expenses and loans, through the services.
 *
 * The two failures this suite pins down:
 *
 *   - Every expense filter and the "Total" underneath it were computed in the browser
 *     over a hard LIMIT 500, so both quietly stopped being true at row 501.
 *   - `loans.list` applied no store scope at all, and the API demanded that a borrower
 *     be a system user, so a shop could not record lending to a customer.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const expenses = require('../src/modules/expenses/expenses.service');
const loans = require('../src/modules/loans/loans.service');
const reports = require('../src/modules/reports/reports.service');
const { advance, monthStart } = require('../src/modules/expenses/expenses.service');
// The suite reads DATE columns back, so it needs the same conversion the services
// use: toISOString() on a pg date moves the day backwards in any timezone east of
// Greenwich, which is exactly the bug being guarded against.
const { toDateOnly, businessDayStart } = require('../src/utils/dateRange');

let pass = 0, fail = 0;
const made = { expenses: [], categories: [], recurring: [], budgets: [], loans: [] };

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

const ADMIN = { role_name: 'admin', permissions: { all_stores: true } };

(async () => {
  const store = await knex('stores').first('id', 'name');
  const store2 = await knex('stores').whereNot('id', store.id).first('id', 'name');
  const user = await knex('users').first('id', 'full_name');
  const scoped = { role_name: 'employee', id: user.id, store_id: store.id, assigned_stores: [store.id], permissions: {} };

  console.log('date arithmetic:');

  await check('a monthly template does not drift off the 31st', () => {
    if (advance('2026-01-31', 'monthly') !== '2026-02-28') throw new Error(advance('2026-01-31', 'monthly'));
    if (advance('2026-03-15', 'monthly') !== '2026-04-15') throw new Error(advance('2026-03-15', 'monthly'));
    if (advance('2026-12-15', 'monthly') !== '2027-01-15') throw new Error(advance('2026-12-15', 'monthly'));
    if (advance('2026-03-15', 'weekly') !== '2026-03-22') throw new Error(advance('2026-03-15', 'weekly'));
    if (advance('2026-03-15', 'quarterly') !== '2026-06-15') throw new Error(advance('2026-03-15', 'quarterly'));
    if (advance('2026-03-15', 'yearly') !== '2027-03-15') throw new Error(advance('2026-03-15', 'yearly'));
    return '31 Jan -> 28 Feb, not 3 Mar';
  });

  console.log('');
  console.log('categories:');

  let parent, child;

  await check('a shop can add its own category', async () => {
    parent = await expenses.createCategory({ name: 'ZZ Test Utilities', name_ar: 'مرافق اختبار' });
    made.categories.push(parent.id);
    if (!parent.id) throw new Error('no id');
    return parent.name + ' / ' + parent.name_ar;
  });

  await check('and a sub-category under it', async () => {
    child = await expenses.createCategory({ name: 'ZZ Electricity', parent_id: parent.id });
    made.categories.push(child.id);
    if (child.parent_id !== parent.id) throw new Error('parent not set');
    return child.name;
  });

  await check('but not a third level', async () => {
    try {
      const bad = await expenses.createCategory({ name: 'ZZ Meter', parent_id: child.id });
      made.categories.push(bad.id);
      throw new Error('a grandchild was allowed');
    } catch (e) {
      if (!/two levels/i.test(e.message)) throw e;
      return 'refused with a reason';
    }
  });

  await check('a duplicate name in the same place is refused', async () => {
    try {
      const dup = await expenses.createCategory({ name: 'zz test utilities' });
      made.categories.push(dup.id);
      throw new Error('duplicate accepted');
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
      return 'case-insensitive';
    }
  });

  await check('the same name IS allowed under a different parent', async () => {
    const other = await expenses.createCategory({ name: 'ZZ Other Parent' });
    made.categories.push(other.id);
    const same = await expenses.createCategory({ name: 'ZZ Electricity', parent_id: other.id });
    made.categories.push(same.id);
    return 'ZZ Electricity exists under two parents';
  });

  console.log('');
  console.log('THE BUG: filters and totals used to be computed in the browser over 500 rows:');

  const DAY = 24 * 60 * 60 * 1000;
  const dateOf = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);

  await check('seed 8 expenses across two categories and two dates', async () => {
    for (let i = 0; i < 5; i++) {
      const e = await expenses.create({
        store_id: store.id, category_id: child.id, amount: 100,
        description: 'zz child expense ' + i, expense_date: dateOf(1),
        payment_method: 'cash', paid_to: 'ZZ Vendor',
      }, user.id);
      made.expenses.push(e.id);
    }
    for (let i = 0; i < 3; i++) {
      const e = await expenses.create({
        store_id: store.id, category_id: parent.id, amount: 200,
        description: 'zz parent expense ' + i, expense_date: dateOf(40),
        payment_method: 'bank',
      }, user.id);
      made.expenses.push(e.id);
    }
    return '5 x 100 + 3 x 200 = 1100';
  });

  await check('the total describes the whole filter, not the page', async () => {
    const res = await expenses.list({ search: 'zz ', limit: 2 }, ADMIN);
    if (res.data.length !== 2) throw new Error('page size ignored: ' + res.data.length);
    if (res.pagination.total !== 8) throw new Error('count was ' + res.pagination.total);
    if (Math.abs(res.summary.total - 1100) > 0.01) throw new Error('total was ' + res.summary.total);
    return 'page of 2, count 8, total 1100';
  });

  await check('selecting a parent category includes its children', async () => {
    const res = await expenses.list({ category_id: parent.id, search: 'zz ' }, ADMIN);
    if (res.pagination.total !== 8) throw new Error('expected 8, got ' + res.pagination.total);
    const kids = await expenses.list({ category_id: child.id, search: 'zz ' }, ADMIN);
    if (kids.pagination.total !== 5) throw new Error('expected 5 under the child, got ' + kids.pagination.total);
    return 'parent 8, child 5';
  });

  await check('date and payment-method filters run in SQL', async () => {
    const recent = await expenses.list({ from_date: dateOf(7), search: 'zz ' }, ADMIN);
    if (recent.pagination.total !== 5) throw new Error('date filter gave ' + recent.pagination.total);
    const bank = await expenses.list({ payment_method: 'bank', search: 'zz ' }, ADMIN);
    if (bank.pagination.total !== 3) throw new Error('payment filter gave ' + bank.pagination.total);
    return 'last 7 days = 5, bank = 3';
  });

  await check('search matches what was paid, not just the description', async () => {
    const res = await expenses.list({ search: 'ZZ Vendor' }, ADMIN);
    if (res.pagination.total !== 5) throw new Error('got ' + res.pagination.total);
    return '5 rows by payee';
  });

  await check('a store-scoped user sees only their own store', async () => {
    if (!store2) return 'only one store — skipped';
    const other = await expenses.create({
      store_id: store2.id, category_id: parent.id, amount: 999,
      description: 'zz other store', expense_date: dateOf(1),
    }, user.id);
    made.expenses.push(other.id);
    const res = await expenses.list({ search: 'zz ' }, scoped);
    if (res.data.some((e) => e.store_id === store2.id)) throw new Error('leaked another store');
    if (Math.abs(res.summary.total - 1100) > 0.01) throw new Error('scoped total was ' + res.summary.total);
    return 'total stays 1100, not 2099';
  });

  await check('summary rolls sub-categories up under their parent', async () => {
    const rows = await expenses.summary({ store_id: store.id, from_date: dateOf(60) });
    const group = rows.find((r) => r.category_id === parent.id);
    if (!group) throw new Error('parent group missing');
    if (Math.abs(group.total - 1100) > 0.01) throw new Error('group total ' + group.total);
    const kid = group.children.find((c) => c.category_id === child.id);
    if (!kid) throw new Error('child not nested');
    if (Math.abs(kid.total - 500) > 0.01) throw new Error('child total ' + kid.total);
    return 'parent 1100 (child 500)';
  });

  await check('an uncategorised expense still appears in the summary', async () => {
    const e = await expenses.create({
      store_id: store.id, category_id: null, amount: 77,
      description: 'zz uncategorised', expense_date: dateOf(1),
    }, user.id);
    made.expenses.push(e.id);
    const rows = await expenses.summary({ store_id: store.id, from_date: dateOf(60) });
    const bucket = rows.find((r) => r.category_id === null);
    if (!bucket) throw new Error('uncategorised vanished — the exact leftJoin bug');
    if (bucket.total < 77) throw new Error('total ' + bucket.total);
    return 'bucket present, ' + bucket.total;
  });

  console.log('');
  console.log('recurring:');

  let tpl;
  await check('a template can be created and is flagged due', async () => {
    tpl = await expenses.createRecurring({
      store_id: store.id, category_id: parent.id, amount: 2500,
      description: 'zz monthly rent', frequency: 'monthly',
      next_date: dateOf(3), payment_method: 'cash',
    }, user.id);
    made.recurring.push(tpl.id);
    const due = await expenses.listRecurring({ store_id: store.id, due_only: true });
    if (!due.some((r) => r.id === tpl.id)) throw new Error('not listed as due');
    return 'due since ' + dateOf(3);
  });

  await check('posting it books a real expense and advances the schedule', async () => {
    const posted = await expenses.postRecurring(tpl.id, {}, user.id);
    made.expenses.push(posted.id);
    if (Math.abs(parseFloat(posted.amount) - 2500) > 0.01) throw new Error('amount ' + posted.amount);
    if (posted.recurring_id !== tpl.id) throw new Error('not traced back to the template');
    const after = await knex('expense_recurring').where('id', tpl.id).first();
    const nextDate = toDateOnly(after.next_date);
    if (nextDate !== advance(dateOf(3), 'monthly')) throw new Error('next_date is ' + nextDate);
    return 'next due ' + nextDate;
  });

  await check('it advances from the date that was DUE, not from today', async () => {
    // Posted three days late; next month must still land on the original day.
    const after = await knex('expense_recurring').where('id', tpl.id).first();
    const expectedDay = dateOf(3).slice(8, 10);
    const actualDay = toDateOnly(after.next_date).slice(8, 10);
    if (actualDay !== expectedDay) {
      throw new Error('drifted to day ' + actualDay + ', expected ' + expectedDay);
    }
    return 'no drift';
  });

  await check('a paused template refuses to post', async () => {
    await expenses.updateRecurring(tpl.id, { is_active: false });
    try {
      const e = await expenses.postRecurring(tpl.id, {}, user.id);
      made.expenses.push(e.id);
      throw new Error('a paused template posted');
    } catch (e) {
      if (!/paused/i.test(e.message)) throw e;
    }
    await expenses.updateRecurring(tpl.id, { is_active: true });
    return 'refused';
  });

  console.log('');
  console.log('budgets:');

  await check('budget against actual, with the variance', async () => {
    const month = monthStart(new Date());
    // Dated today, so it lands inside the month being budgeted. Every other seeded
    // expense is backdated on purpose, to exercise the date filters above.
    const thisMonth = await expenses.create({
      store_id: store.id, category_id: parent.id, amount: 450,
      description: 'zz this month', expense_date: businessDayStart(),
    }, user.id);
    made.expenses.push(thisMonth.id);
    const b = await expenses.setBudget({ store_id: store.id, category_id: parent.id, period_month: month, amount: 3000 });
    made.budgets.push(b.id);
    const res = await expenses.budgets({ store_id: store.id, period_month: month });
    const row = res.rows.find((r) => r.category_id === parent.id);
    if (!row) throw new Error('category missing from the budget sheet');
    if (row.budget !== 3000) throw new Error('budget ' + row.budget);
    if (row.actual <= 0) throw new Error('actual not picked up');
    if (Math.abs(row.variance - (row.budget - row.actual)) > 0.01) throw new Error('variance wrong');
    return 'budget 3000, actual ' + row.actual + ', variance ' + row.variance.toFixed(2);
  });

  await check('a category with no budget still appears, so overspend is visible', async () => {
    const res = await expenses.budgets({ store_id: store.id, period_month: monthStart(new Date()) });
    const row = res.rows.find((r) => r.category_id === child.id);
    if (!row) throw new Error('unbudgeted category was hidden');
    if (row.budget !== 0) throw new Error('budget ' + row.budget);
    if (row.used_pct !== null) throw new Error('a percentage of zero was reported');
    // The totals line must count spending that has no budget behind it, or an
    // overspent-but-unbudgeted category would be invisible in the summary figure.
    if (res.totals.actual < 450) throw new Error('totals.actual is ' + res.totals.actual);
    return 'budget 0, actual ' + row.actual + ', month total ' + res.totals.actual;
  });

  await check('setting a budget to zero removes it', async () => {
    const month = monthStart(new Date());
    await expenses.setBudget({ store_id: store.id, category_id: parent.id, period_month: month, amount: 0 });
    const left = await knex('expense_budgets').where({ store_id: store.id, category_id: parent.id, period_month: month }).first();
    if (left) throw new Error('still there');
    // Put it back for the report checks below.
    const b = await expenses.setBudget({ store_id: store.id, category_id: parent.id, period_month: month, amount: 3000 });
    made.budgets.push(b.id);
    return 'removed';
  });

  console.log('');
  console.log('categories cannot be deleted out from under real spending:');

  await check('a category in use refuses deletion and says why', async () => {
    try {
      await expenses.deleteCategory(child.id);
      throw new Error('deleted a category that is in use');
    } catch (e) {
      if (!/deactivate it instead/i.test(e.message)) throw e;
      return 'refused, suggests deactivating';
    }
  });

  await check('deactivating a parent hides its children from the picker', async () => {
    await expenses.updateCategory(parent.id, { is_active: false });
    const active = await expenses.listCategories({ is_active: true });
    if (active.some((c) => c.id === child.id)) throw new Error('orphan child still selectable');
    await expenses.updateCategory(parent.id, { is_active: true });
    return 'child hidden with its parent';
  });

  console.log('');
  console.log('THE OTHER BUG: loans took any store_id and demanded a system user:');

  let loanA, loanB;

  await check('a loan to someone who is NOT a system user', async () => {
    loanA = await loans.create({
      borrower_name: 'ZZ Walk-in Customer', borrower_phone: '0100000000',
      amount: 1000, loan_date: dateOf(40), due_date: dateOf(10), store_id: store.id,
    }, user.id);
    made.loans.push(loanA.id);
    if (loanA.borrower_user_id !== null) throw new Error('invented a user link');
    return loanA.borrower_name;
  });

  await check('a loan to a staff member takes their name from the account', async () => {
    loanB = await loans.create({
      borrower_user_id: user.id, amount: 500, loan_date: dateOf(5), store_id: store.id,
    }, user.id);
    made.loans.push(loanB.id);
    if (loanB.borrower_name !== user.full_name) throw new Error('name was ' + loanB.borrower_name);
    return loanB.borrower_name;
  });

  await check('a loan with neither is refused with a usable message', async () => {
    try {
      const bad = await loans.create({ amount: 100, loan_date: dateOf(1) }, user.id);
      made.loans.push(bad.id);
      throw new Error('a nameless loan was created');
    } catch (e) {
      if (!/staff member|borrower/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('overdue is derived, and drives the ordering', async () => {
    const list = await loans.list({ store_id: store.id });
    const a = list.find((l) => l.id === loanA.id);
    const b = list.find((l) => l.id === loanB.id);
    if (!a.is_overdue) throw new Error('a loan 10 days past due is not flagged');
    if (b.is_overdue) throw new Error('a loan with no due date is flagged overdue');
    if (list.findIndex((l) => l.id === loanA.id) > list.findIndex((l) => l.id === loanB.id)) {
      throw new Error('overdue loans do not sort first');
    }
    return 'overdue first, ' + a.days_to_due + ' days';
  });

  await check('overdue_only filters to what needs chasing', async () => {
    const list = await loans.list({ store_id: store.id, overdue_only: true });
    if (!list.some((l) => l.id === loanA.id)) throw new Error('overdue loan missing');
    if (list.some((l) => l.id === loanB.id)) throw new Error('a non-overdue loan came back');
    return list.length + ' overdue';
  });

  await check('a store-scoped user cannot see another store loans', async () => {
    if (!store2) return 'only one store — skipped';
    const other = await loans.create({
      borrower_name: 'ZZ Other Store', amount: 700, loan_date: dateOf(2), store_id: store2.id,
    }, user.id);
    made.loans.push(other.id);
    const list = await loans.list({ store_id: store.id });
    if (list.some((l) => l.id === other.id)) throw new Error('leaked another store — the original bug');
    return 'scoped';
  });

  await check('outstanding separates what is merely owed from what is late', async () => {
    const totals = await loans.outstanding({ store_id: store.id });
    if (totals.total < 1500) throw new Error('total ' + totals.total);
    if (totals.overdue < 1000) throw new Error('overdue ' + totals.overdue);
    if (totals.overdue_count < 1) throw new Error('overdue_count ' + totals.overdue_count);
    return totals.total + ' owed, ' + totals.overdue + ' overdue';
  });

  await check('an instalment plan splits to the penny', async () => {
    const rows = await loans.setInstallments(loanA.id, { count: 3, start_date: dateOf(-30) });
    if (rows.length !== 3) throw new Error('got ' + rows.length);
    const sum = rows.reduce((n, r) => n + parseFloat(r.amount), 0);
    if (Math.abs(sum - 1000) > 0.001) throw new Error('schedule sums to ' + sum);
    return rows.map((r) => r.amount).join(' + ') + ' = 1000';
  });

  await check('a payment settles the schedule oldest-first', async () => {
    await loans.addPayment(loanA.id, { amount: 400, payment_date: dateOf(1), payment_method: 'cash' }, user.id);
    const full = await loans.getById(loanA.id);
    const [first, second, third] = full.installments;
    if (!first.is_settled) throw new Error('first instalment not settled');
    if (second.paid <= 0) throw new Error('remainder did not flow to the second');
    if (third.paid !== 0) throw new Error('the third was touched too early');
    return 'settled ' + first.amount + ', part-paid ' + second.paid;
  });

  await check('a payment cannot exceed what is left', async () => {
    try {
      await loans.addPayment(loanA.id, { amount: 99999, payment_date: dateOf(1) }, user.id);
      throw new Error('overpayment accepted');
    } catch (e) {
      if (!/exceeds remaining/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a loan cannot be reduced below what is already repaid', async () => {
    try {
      await loans.update(loanA.id, { amount: 100 });
      throw new Error('reduced below the repaid amount');
    } catch (e) {
      if (!/already been repaid/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('a loan with payments cannot be deleted by accident', async () => {
    try {
      await loans.delete(loanA.id);
      throw new Error('deleted a loan with payments');
    } catch (e) {
      if (!/recorded payment/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('the statement adds up', async () => {
    const st = await loans.statement(loanA.id);
    if (Math.abs(st.totals.paid - 400) > 0.01) throw new Error('paid ' + st.totals.paid);
    if (Math.abs(st.totals.remaining - 600) > 0.01) throw new Error('remaining ' + st.totals.remaining);
    return st.totals.paid + ' paid, ' + st.totals.remaining + ' left';
  });

  console.log('');
  console.log('dashboard:');

  await check('overdue loans and due recurring reach the dashboard', async () => {
    const data = await reports.getDashboardAdmin({ store_id: store.id });
    if (!Array.isArray(data.overdue_loans)) throw new Error('overdue_loans missing');
    if (!data.overdue_loans.some((l) => l.id === loanA.id)) throw new Error('the overdue loan is not surfaced');
    if (!Array.isArray(data.due_recurring)) throw new Error('due_recurring missing');
    return data.overdue_loans.length + ' overdue loan(s), ' + data.due_recurring.length + ' recurring due';
  });

  await check('the monthly trend returns one row per month', async () => {
    const rows = await expenses.monthlyTrend({ store_id: store.id, months: 6 });
    if (!Array.isArray(rows)) throw new Error('not an array');
    if (rows.length && !/^\d{4}-\d{2}$/.test(rows[0].month)) throw new Error('bad month key ' + rows[0].month);
    return rows.length + ' month(s)';
  });

  // ---------------------------------------------------------------- cleanup
  for (const id of made.loans) {
    await knex('attached_images').where('entity_type', 'loan_payment')
      .whereIn('entity_id', knex('loan_payments').select('id').where('loan_id', id)).del();
    await knex('loan_payments').where('loan_id', id).del();
    await knex('loan_installments').where('loan_id', id).del();
    await knex('loans').where('id', id).del();
  }
  await knex('expense_budgets').whereIn('id', made.budgets).del();
  await knex('expenses').whereIn('id', made.expenses).del();
  await knex('expense_recurring').whereIn('id', made.recurring).del();
  // Children before parents, or the RESTRICT self-reference bites.
  for (const id of [...made.categories].reverse()) {
    await knex('expense_categories').where('id', id).del().catch(() => {});
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
