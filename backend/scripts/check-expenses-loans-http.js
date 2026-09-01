/*
 * The expenses and loans HTTP surface: routes, Joi validation and permissions.
 *
 * The service-level suite (check-expenses-loans.js) proves the logic. This one proves
 * the wiring around it — route ordering, query validation, and the store-access checks
 * in the controllers — which only exist over HTTP.
 *
 * Runs against a server that is already up. Uses few enough requests to stay well
 * inside the 200/min limiter.
 */
const BASE = process.env.API_BASE || 'http://localhost:5000/api';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || 'admin123';

let token = null;
let pass = 0, fail = 0;
const made = { expenses: [], loans: [], categories: [], recurring: [] };

async function call(method, path, body, params) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const res = await fetch(BASE + path + qs, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

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
  const login = await call('POST', '/auth/login', { username: USER, password: PASS });
  if (login.status !== 200) {
    console.log('login failed (' + login.status + '): ' + JSON.stringify(login.body));
    process.exit(1);
  }
  token = login.body.data?.accessToken || login.body.accessToken || login.body.data?.token;
  if (!token) { console.log('no token in login response'); process.exit(1); }

  const stores = await call('GET', '/stores');
  const storeId = stores.body.data[0].id;

  console.log('routes:');

  await check('GET /expenses returns a page, a count and a filter total', async () => {
    const r = await call('GET', '/expenses', null, { limit: '5' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.data)) throw new Error('no data array');
    if (!r.body.pagination) throw new Error('no pagination');
    if (r.body.summary === undefined) throw new Error('no summary total');
    return r.body.pagination.total + ' rows, total ' + r.body.summary.total;
  });

  await check('a bad query is a 400, not a 500 from Postgres', async () => {
    const r = await call('GET', '/expenses', null, { payment_method: 'bitcoin' });
    if (r.status !== 400) throw new Error('status ' + r.status);
    return 'rejected at the door';
  });

  await check('/expenses/categories is not swallowed by /expenses/:id', async () => {
    // Route order matters: a literal path declared after '/:id' would be read as an id.
    const r = await call('GET', '/expenses/categories');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.data)) throw new Error('not a list');
    return r.body.data.length + ' categories';
  });

  await check('/expenses/recurring and /expenses/budgets likewise', async () => {
    const rec = await call('GET', '/expenses/recurring');
    if (rec.status !== 200) throw new Error('recurring status ' + rec.status);
    const bud = await call('GET', '/expenses/budgets', null, { store_id: storeId });
    if (bud.status !== 200) throw new Error('budgets status ' + bud.status);
    if (!Array.isArray(bud.body.data.rows)) throw new Error('no budget rows');
    return 'both reachable';
  });

  await check('/loans/outstanding is not read as a loan id', async () => {
    const r = await call('GET', '/loans/outstanding');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (typeof r.body.data.total !== 'number') throw new Error('no total');
    return r.body.data.total + ' outstanding, ' + r.body.data.overdue_count + ' overdue';
  });

  console.log('');
  console.log('creating through the API:');

  let categoryId;
  await check('a category, then a sub-category under it', async () => {
    const parent = await call('POST', '/expenses/categories', { name: 'HTTP Check Parent' });
    if (parent.status !== 201) throw new Error('parent status ' + parent.status + ' ' + JSON.stringify(parent.body));
    made.categories.push(parent.body.data.id);
    const child = await call('POST', '/expenses/categories', { name: 'HTTP Check Child', parent_id: parent.body.data.id });
    if (child.status !== 201) throw new Error('child status ' + child.status);
    made.categories.unshift(child.body.data.id);
    categoryId = child.body.data.id;
    return 'parent ' + parent.body.data.id + ', child ' + categoryId;
  });

  await check('an expense with a payment method and a payee', async () => {
    const r = await call('POST', '/expenses', {
      store_id: storeId, category_id: categoryId, amount: 250.75,
      description: 'HTTP check', expense_date: '2026-06-15',
      payment_method: 'instapay', paid_to: 'HTTP Vendor',
    });
    if (r.status !== 201) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    made.expenses.push(r.body.data.id);
    if (r.body.data.payment_method !== 'instapay') throw new Error('payment method lost');
    if (r.body.data.paid_to !== 'HTTP Vendor') throw new Error('payee lost');
    return r.body.data.id;
  });

  await check('an expense with NO category is accepted', async () => {
    // category_id was `required()`, which pushed anyone in a hurry to file rent under
    // "Other" — worse for a report than an honest blank.
    const r = await call('POST', '/expenses', {
      store_id: storeId, amount: 10, description: 'HTTP uncategorised', expense_date: '2026-06-15',
    });
    if (r.status !== 201) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    made.expenses.push(r.body.data.id);
    if (r.body.data.category_id !== null) throw new Error('category invented');
    return 'uncategorised';
  });

  await check('editing an expense works over HTTP', async () => {
    const id = made.expenses[0];
    const r = await call('PUT', '/expenses/' + id, { amount: 300, paid_to: 'HTTP Corrected' });
    if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (parseFloat(r.body.data.amount) !== 300) throw new Error('amount ' + r.body.data.amount);
    return '250.75 -> 300';
  });

  await check('a recurring template, posted as a real expense', async () => {
    const tpl = await call('POST', '/expenses/recurring', {
      store_id: storeId, category_id: categoryId, amount: 900,
      description: 'HTTP rent', frequency: 'monthly', next_date: '2026-06-01',
    });
    if (tpl.status !== 201) throw new Error('status ' + tpl.status + ' ' + JSON.stringify(tpl.body));
    made.recurring.push(tpl.body.data.id);

    const posted = await call('POST', '/expenses/recurring/' + tpl.body.data.id + '/post', {});
    if (posted.status !== 201) throw new Error('post status ' + posted.status + ' ' + JSON.stringify(posted.body));
    made.expenses.push(posted.body.data.id);
    if (posted.body.data.recurring_id !== tpl.body.data.id) throw new Error('not traced to the template');

    const after = await call('GET', '/expenses/recurring');
    const t = after.body.data.find((r) => r.id === tpl.body.data.id);
    if (String(t.next_date).slice(0, 10) !== '2026-07-01') throw new Error('next_date ' + t.next_date);
    return 'advanced to 2026-07-01';
  });

  await check('a budget can be set and read back', async () => {
    const set = await call('PUT', '/expenses/budgets', {
      store_id: storeId, category_id: categoryId, period_month: '2026-06-01', amount: 5000,
    });
    if (set.status !== 200) throw new Error('status ' + set.status + ' ' + JSON.stringify(set.body));
    const read = await call('GET', '/expenses/budgets', null, { store_id: storeId, period_month: '2026-06-01' });
    const row = read.body.data.rows.find((r) => r.category_id === categoryId);
    if (!row || row.budget !== 5000) throw new Error('budget read back as ' + row?.budget);
    if (row.actual <= 0) throw new Error('actual not picked up: ' + row.actual);
    await call('PUT', '/expenses/budgets', {
      store_id: storeId, category_id: categoryId, period_month: '2026-06-01', amount: 0,
    });
    return 'budget 5000, actual ' + row.actual;
  });

  console.log('');
  console.log('THE LOANS BUG, over HTTP:');

  let loanId;
  await check('a loan to someone who is not a system user', async () => {
    const r = await call('POST', '/loans', {
      borrower_name: 'HTTP Customer', borrower_phone: '0100000000',
      amount: 1200, loan_date: '2026-05-01', due_date: '2026-06-01', store_id: storeId,
    });
    if (r.status !== 201) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    made.loans.push(r.body.data.id);
    loanId = r.body.data.id;
    if (r.body.data.borrower_user_id !== null) throw new Error('a user link was invented');
    return r.body.data.borrower_name;
  });

  await check('a loan with no borrower at all is refused with a usable message', async () => {
    const r = await call('POST', '/loans', { amount: 100, loan_date: '2026-05-01' });
    if (r.status !== 400) throw new Error('status ' + r.status);
    if (!/staff member|borrower/i.test(JSON.stringify(r.body))) {
      throw new Error('unhelpful message: ' + JSON.stringify(r.body));
    }
    return 'refused';
  });

  await check('overdue is computed on read', async () => {
    const r = await call('GET', '/loans', null, { search: 'HTTP Customer' });
    const loan = r.body.data.find((l) => l.id === loanId);
    if (!loan) throw new Error('loan not listed');
    if (loan.is_overdue !== true) throw new Error('not flagged overdue');
    if (Number(loan.remaining) !== 1200) throw new Error('remaining ' + loan.remaining);
    return loan.days_to_due + ' days past due';
  });

  await check('an instalment plan can be set over HTTP', async () => {
    const r = await call('PUT', '/loans/' + loanId + '/installments', { count: 3, start_date: '2026-06-01' });
    if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (r.body.data.length !== 3) throw new Error('got ' + r.body.data.length);
    const sum = r.body.data.reduce((n, i) => n + parseFloat(i.amount), 0);
    if (Math.abs(sum - 1200) > 0.001) throw new Error('schedule sums to ' + sum);
    return r.body.data.map((i) => i.amount).join(' + ');
  });

  await check('a payment returns the payment id, for attaching proof', async () => {
    const r = await call('POST', '/loans/' + loanId + '/payments', {
      amount: 400, payment_date: '2026-06-05', payment_method: 'salary_deduction',
    });
    if (r.status !== 201) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (!r.body.payment_id) throw new Error('no payment_id in the response');
    const full = await call('GET', '/loans/' + loanId);
    if (!full.body.data.installments[0].is_settled) throw new Error('first instalment not settled');
    return 'payment ' + r.body.payment_id.slice(0, 8) + ', first instalment settled';
  });

  await check('the statement adds up', async () => {
    const r = await call('GET', '/loans/' + loanId + '/statement');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (r.body.data.totals.paid !== 400) throw new Error('paid ' + r.body.data.totals.paid);
    if (r.body.data.totals.remaining !== 800) throw new Error('remaining ' + r.body.data.totals.remaining);
    return '400 paid, 800 left';
  });

  await check('the dashboard carries overdue loans and due recurring', async () => {
    const r = await call('GET', '/reports/dashboard-admin');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.data.overdue_loans)) throw new Error('overdue_loans missing');
    if (!Array.isArray(r.body.data.due_recurring)) throw new Error('due_recurring missing');
    if (!r.body.data.overdue_loans.some((l) => l.id === loanId)) throw new Error('this loan is not surfaced');
    return r.body.data.overdue_loans.length + ' overdue';
  });

  await check('the financial report carries the expense ratio and trend', async () => {
    const r = await call('GET', '/reports/financial', null, { all_time: '1' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!('expense_ratio_pct' in r.body.data.summary)) throw new Error('no expense_ratio_pct');
    if (!Array.isArray(r.body.data.expense_trend)) throw new Error('no expense_trend');
    return 'ratio ' + r.body.data.summary.expense_ratio_pct + '%, ' + r.body.data.expense_trend.length + ' month(s)';
  });

  // ---------------------------------------------------------------- cleanup
  console.log('');
  const full = await call('GET', '/loans/' + loanId);
  for (const p of (full.body?.data?.payments || [])) {
    await call('DELETE', '/loans/' + loanId + '/payments/' + p.id);
  }
  for (const id of made.loans) await call('DELETE', '/loans/' + id);
  for (const id of made.expenses) await call('DELETE', '/expenses/' + id);
  for (const id of made.recurring) await call('DELETE', '/expenses/recurring/' + id);
  for (const id of made.categories) await call('DELETE', '/expenses/categories/' + id);

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  process.exit(1);
});
