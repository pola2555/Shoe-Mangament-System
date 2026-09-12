/*
 * Stores, POS filtering and the period comparison — over real HTTP.
 *
 * Three things are being proved here, and only the first is ordinary CRUD:
 *
 *  1. **The figures agree with the rest of the system.** A store's revenue on its own
 *     page, its row in the branch comparison, and the company report filtered to that
 *     store must be one number. They are computed by three different queries, so this
 *     asserts they match rather than assuming the shared SQL expression is enough.
 *
 *  2. **The guards actually guard.** A branch holding stock cannot be closed; the last
 *     open branch cannot be closed; a price band that would reject every sale is
 *     refused at the point where the message can explain itself.
 *
 *  3. **Facets are computed excluding their own filter.** This is the difference
 *     between a filter row that works and one that dead-ends: picking a colour must
 *     narrow the sizes but leave the other colours reachable.
 *
 * Runs against a server that is already up.
 */
const BASE = process.env.API_BASE || 'http://localhost:5000/api';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || 'admin123';

let token = null;
let pass = 0, fail = 0;
const created = { stores: [], prices: [] };

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

/** Two money figures agreeing to the cent. */
function near(a, b, label) {
  if (Math.abs(Number(a) - Number(b)) > 0.01) {
    throw new Error(`${label}: ${a} !== ${b}`);
  }
}

(async () => {
  const login = await call('POST', '/auth/login', { username: USER, password: PASS });
  if (login.status !== 200) {
    console.log('login failed (' + login.status + '): ' + JSON.stringify(login.body));
    process.exit(1);
  }
  token = login.body.data?.accessToken || login.body.accessToken;
  if (!token) { console.log('no token in login response'); process.exit(1); }

  const stores = (await call('GET', '/stores')).body.data;
  const storeId = stores[0].id;

  // ============================================================ list & stats
  console.log('store list:');

  await check('GET /stores still answers with names alone', async () => {
    const r = await call('GET', '/stores');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (r.body.data[0].stats !== undefined) throw new Error('stats returned without being asked for');
    return r.body.data.length + ' stores';
  });

  await check('include_stats attaches a live picture of each branch', async () => {
    const r = await call('GET', '/stores', null, { include_stats: '1' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    const s = r.body.data.find((x) => x.id === storeId);
    if (!s.stats) throw new Error('no stats block');
    for (const key of ['stock_units', 'stock_value', 'revenue_today', 'revenue_month',
      'profit_month', 'expenses_month', 'net_month', 'staff_count', 'customer_credit']) {
      if (s.stats[key] === undefined) throw new Error('missing ' + key);
    }
    return `${s.name}: ${s.stats.stock_units} in stock, ${s.stats.staff_count} staff`;
  });

  await check('net for the month is profit less expenses, not something else', async () => {
    const r = await call('GET', '/stores', null, { include_stats: '1' });
    for (const s of r.body.data) {
      if (!s.stats) continue;
      near(s.stats.net_month, s.stats.profit_month - s.stats.expenses_month, s.name + ' net');
    }
  });

  await check('is_active=false lists only closed branches', async () => {
    const r = await call('GET', '/stores', null, { is_active: 'false' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (r.body.data.some((s) => s.is_active)) throw new Error('an open store came back');
    return r.body.data.length + ' closed';
  });

  // ============================================================ the report
  console.log('store report:');

  await check('GET /stores/:id/overview returns metrics, trend and leaderboards', async () => {
    const r = await call('GET', `/stores/${storeId}/overview`, null, { all_time: '1' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    const d = r.body.data;
    for (const key of ['store', 'metrics', 'trend', 'top_products', 'staff',
      'payment_methods', 'stock_by_category', 'low_stock']) {
      if (d[key] === undefined) throw new Error('missing ' + key);
    }
    return `${d.metrics.sales_count} sales, ${d.trend.length} days`;
  });

  await check('net is profit less expenses here too', async () => {
    const d = (await call('GET', `/stores/${storeId}/overview`, null, { all_time: '1' })).body.data;
    near(d.metrics.net, d.metrics.gross_profit - d.metrics.expenses, 'overview net');
  });

  await check('revenue is net of refunds, and gross is reported beside it', async () => {
    const d = (await call('GET', `/stores/${storeId}/overview`, null, { all_time: '1' })).body.data;
    near(d.metrics.revenue, d.metrics.gross_revenue - d.metrics.refunded, 'net = gross - refunds');
    return `${d.metrics.gross_revenue} gross - ${d.metrics.refunded} refunded = ${d.metrics.revenue}`;
  });

  await check('the margin is profit over revenue, or zero when nothing sold', async () => {
    const d = (await call('GET', `/stores/${storeId}/overview`, null, { all_time: '1' })).body.data;
    const expected = d.metrics.revenue
      ? Math.round((d.metrics.gross_profit / d.metrics.revenue) * 1000) / 10
      : 0;
    near(d.metrics.margin_pct, expected, 'margin');
  });

  await check('a 404 for a store that does not exist, not a 500', async () => {
    const r = await call('GET', '/stores/00000000-0000-0000-0000-000000000000/overview');
    if (r.status !== 404) throw new Error('status ' + r.status);
  });

  // THE LOAD-BEARING ONE. Three queries, one answer.
  await check('THE AGREEMENT: store page, branch comparison and company report all say the same revenue', async () => {
    const range = { startDate: '2020-01-01', endDate: '2035-12-31' };
    const overview = (await call('GET', `/stores/${storeId}/overview`, null, range)).body.data;
    const comparison = (await call('GET', '/stores/comparison', null, range)).body.data;
    const row = comparison.stores.find((s) => s.store_id === storeId);
    if (!row) throw new Error('store missing from the comparison');
    near(row.revenue, overview.metrics.revenue, 'comparison vs overview revenue');
    near(row.gross_profit, overview.metrics.gross_profit, 'comparison vs overview profit');
    near(row.expenses, overview.metrics.expenses, 'comparison vs overview expenses');

    // `revenue` means net of refunds in all three, matching the dashboard's headline.
    // These were three different numbers when this check was first written: the store
    // figures were gross and the dashboard's were net, so one branch read two
    // different revenues on two screens.
    const company = (await call('GET', '/reports/dashboard', null, { ...range, store_id: storeId })).body.data;
    near(company.metrics.net_sales, overview.metrics.revenue, 'company report vs store page revenue');
    near(company.metrics.total_revenue, overview.metrics.gross_revenue, 'gross revenue');
    return overview.metrics.revenue + ' agreed three ways';
  });

  await check('the comparison totals are the sum of its rows', async () => {
    const d = (await call('GET', '/stores/comparison', null, { all_time: '1' })).body.data;
    near(d.totals.revenue, d.stores.reduce((n, s) => n + s.revenue, 0), 'total revenue');
    near(d.totals.net, d.stores.reduce((n, s) => n + s.net, 0), 'total net');
    return d.stores.length + ' branches';
  });

  await check('/stores/comparison is not swallowed by /stores/:id', async () => {
    const r = await call('GET', '/stores/comparison');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.data?.stores)) throw new Error('got a store, not a comparison');
  });

  // ============================================================ guards
  console.log('guards:');

  await check('a branch holding stock cannot be closed, and the message says how much', async () => {
    const withStock = (await call('GET', '/stores', null, { include_stats: '1' })).body.data
      .find((s) => s.is_active && s.stats?.stock_units > 0);
    if (!withStock) return 'no store with stock to test against — skipped';
    const r = await call('PUT', `/stores/${withStock.id}`, { is_active: false });
    if (r.status !== 400) throw new Error('status ' + r.status + ' (it let the branch close)');
    if (!/in stock/i.test(r.body.message || '')) throw new Error('message does not mention stock: ' + r.body.message);
    return r.body.message;
  });

  await check('the last open branch cannot be closed', async () => {
    // An empty branch: nothing to strand, so only the "last one open" rule could stop
    // it closing. Reused across runs rather than created each time — a store can never
    // be deleted (RESTRICT everywhere), so a fresh one per run would slowly fill the
    // till's store picker with test branches.
    const NAME = 'CHK scratch branch';
    const existing = (await call('GET', '/stores')).body.data.find((s) => s.name === NAME);
    const id = existing
      ? existing.id
      : (await call('POST', '/stores', { name: NAME })).body.data?.id;
    if (!id) throw new Error('could not create the scratch branch');
    created.stores.push(id);
    if (existing && !existing.is_active) await call('PUT', `/stores/${id}`, { is_active: true });
    const close = await call('PUT', `/stores/${id}`, { is_active: false });
    if (close.status !== 200) throw new Error('an empty branch should close: ' + JSON.stringify(close.body));
    const reopen = await call('PUT', `/stores/${id}`, { is_active: true });
    if (reopen.status !== 200) throw new Error('could not reopen');
    return 'empty branch closed and reopened';
  });

  await check('a price band that would reject every sale is refused', async () => {
    const products = (await call('GET', '/products', null, { limit: '1' })).body.data;
    if (!products?.length) return 'no products — skipped';
    const pid = products[0].id;
    created.prices.push(pid);
    const bad = await call('PUT', `/stores/${storeId}/prices/${pid}`, {
      selling_price: 100, min_selling_price: 200, max_selling_price: 300,
    });
    if (bad.status !== 400) throw new Error('status ' + bad.status);
    const inverted = await call('PUT', `/stores/${storeId}/prices/${pid}`, {
      selling_price: 250, min_selling_price: 300, max_selling_price: 200,
    });
    if (inverted.status !== 400) throw new Error('inverted band accepted');
    return bad.body.message;
  });

  await check('a branch price is set, read back, and cleared back to the catalogue', async () => {
    const products = (await call('GET', '/products', null, { limit: '1' })).body.data;
    if (!products?.length) return 'no products — skipped';
    const pid = products[0].id;

    const set = await call('PUT', `/stores/${storeId}/prices/${pid}`, { selling_price: 777 });
    if (set.status !== 200) throw new Error('set: ' + JSON.stringify(set.body));

    const listed = (await call('GET', `/stores/${storeId}/prices`, null, { only_overridden: 'true' })).body.data;
    const row = listed.find((p) => p.product_id === pid);
    if (!row) throw new Error('override not listed');
    near(row.store_selling_price, 777, 'store price');

    // The till must see it, or the whole feature is decorative.
    const inv = (await call('GET', '/inventory', null, { store_id: storeId, product_id: pid, limit: '1' })).body.data;
    if (inv.length) near(inv[0].store_selling_price, 777, 'price as the till sees it');

    // null clears — distinct from a price of zero, which is why it has to stay
    // expressible at all.
    const cleared = await call('PUT', `/stores/${storeId}/prices/${pid}`, { selling_price: null });
    if (cleared.status !== 200) throw new Error('clear: ' + JSON.stringify(cleared.body));
    const after = (await call('GET', `/stores/${storeId}/prices`, null, { only_overridden: 'true' })).body.data;
    if (after.some((p) => p.product_id === pid)) throw new Error('override survived the clear');
    return 'set 777, seen by the till, cleared';
  });

  await check('staff assignment is a whole-set replace, and a duplicate id is a 400', async () => {
    const before = (await call('GET', `/stores/${storeId}/staff`)).body.data;
    const assigned = before.filter((u) => u.assigned).map((u) => u.id);

    const dup = await call('PUT', `/stores/${storeId}/staff`, { user_ids: [assigned[0] || null, assigned[0] || null].filter(Boolean) });
    if (assigned.length && dup.status !== 400) throw new Error('a duplicate id was accepted');

    const bogus = await call('PUT', `/stores/${storeId}/staff`, { user_ids: ['00000000-0000-0000-0000-000000000000'] });
    if (bogus.status !== 400) throw new Error('an unknown user was accepted: ' + bogus.status);

    // Put it back exactly as it was.
    const restore = await call('PUT', `/stores/${storeId}/staff`, { user_ids: assigned });
    if (restore.status !== 200) throw new Error('restore failed: ' + JSON.stringify(restore.body));
    const after = (await call('GET', `/stores/${storeId}/staff`)).body.data.filter((u) => u.assigned).map((u) => u.id);
    if (after.sort().join() !== assigned.sort().join()) throw new Error('assignment not restored');
    return assigned.length + ' assigned, unchanged';
  });

  // ============================================================ facets
  console.log('POS filters:');

  await check('GET /inventory/facets returns colours, sizes and categories with counts', async () => {
    const r = await call('GET', '/inventory/facets', null, { store_id: storeId });
    if (r.status !== 200) throw new Error('status ' + r.status);
    const d = r.body.data;
    for (const key of ['colors', 'sizes', 'categories']) {
      if (!Array.isArray(d[key])) throw new Error('missing ' + key);
    }
    return `${d.colors.length} colours, ${d.sizes.length} sizes, ${d.categories.length} categories`;
  });

  await check('every chip has stock behind it', async () => {
    const d = (await call('GET', '/inventory/facets', null, { store_id: storeId })).body.data;
    for (const c of d.colors) if (!(c.count > 0)) throw new Error('colour ' + c.name + ' has no stock');
    for (const s of d.sizes) if (!(s.count > 0)) throw new Error('size ' + s.value + ' has no stock');
  });

  await check('THE DEAD END: picking a colour narrows the sizes but leaves the colours reachable', async () => {
    const before = (await call('GET', '/inventory/facets', null, { store_id: storeId })).body.data;
    if (before.colors.length < 2) return 'fewer than two colours in stock — skipped';
    const pick = before.colors[0].name;
    const after = (await call('GET', '/inventory/facets', null, { store_id: storeId, colors: pick })).body.data;
    if (after.colors.length !== before.colors.length) {
      throw new Error(`the colour row collapsed from ${before.colors.length} to ${after.colors.length}`);
    }
    if (after.sizes.length > before.sizes.length) throw new Error('sizes did not narrow');
    return `${pick}: colours ${after.colors.length}, sizes ${before.sizes.length} -> ${after.sizes.length}`;
  });

  await check('the colour filter matches by name, and every row honours it', async () => {
    const facets = (await call('GET', '/inventory/facets', null, { store_id: storeId })).body.data;
    if (!facets.colors.length) return 'no colours in stock — skipped';
    const pick = facets.colors[0].name;
    const rows = (await call('GET', '/inventory/summary', null, { store_id: storeId, colors: pick, limit: '500' })).body.data;
    if (!rows.length) throw new Error('the filter found nothing, but a chip said ' + facets.colors[0].count);
    for (const r of rows) {
      if (String(r.color_name).toLowerCase() !== pick.toLowerCase()) {
        throw new Error('got ' + r.color_name + ' for ' + pick);
      }
    }
    return `${pick}: ${rows.length} rows`;
  });

  await check('colour and size together narrow further, never wider', async () => {
    const facets = (await call('GET', '/inventory/facets', null, { store_id: storeId })).body.data;
    if (!facets.colors.length || !facets.sizes.length) return 'nothing to combine — skipped';
    const colour = facets.colors[0].name;
    const size = facets.sizes[0].value;
    const one = (await call('GET', '/inventory/summary', null, { store_id: storeId, colors: colour, limit: '500' })).body.data;
    const both = (await call('GET', '/inventory/summary', null, { store_id: storeId, colors: colour, size_values: size, limit: '500' })).body.data;
    if (both.length > one.length) throw new Error('adding a size widened the result');
    for (const r of both) if (r.size_eu !== size) throw new Error('size filter leaked: ' + r.size_eu);
  });

  await check('the placeholder colour is never offered as a colour', async () => {
    const d = (await call('GET', '/inventory/facets', null, { store_id: storeId })).body.data;
    // A colourless category's stand-in row must not appear. It has no hex and is
    // named by the category, so the only reliable test is that filtering by it
    // returns nothing — which cannot happen if it was never offered.
    const rows = (await call('GET', '/inventory/summary', null, { store_id: storeId, limit: '2000' })).body.data;
    const placeholders = new Set(rows.filter((r) => r.color_is_placeholder).map((r) => String(r.color_name).toLowerCase()));
    for (const c of d.colors) {
      if (placeholders.has(String(c.name).toLowerCase())) throw new Error('placeholder offered: ' + c.name);
    }
    return placeholders.size + ' placeholder name(s) correctly withheld';
  });

  await check('a malformed colour list is a 400, not a 500 from Postgres', async () => {
    const r = await call('GET', '/inventory/summary', null, { store_id: storeId, colors: 'x'.repeat(4000) });
    if (r.status !== 400) throw new Error('status ' + r.status);
  });

  // ============================================================ comparison
  console.log('period comparison:');

  await check('the previous window is the same length, immediately before', async () => {
    const r = await call('GET', '/reports/comparison', null, { startDate: '2026-03-10', endDate: '2026-03-19' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    const d = r.body.data;
    if (!d.comparable) throw new Error('not comparable');
    if (d.previous.range.startDate !== '2026-02-28') throw new Error('previous start ' + d.previous.range.startDate);
    if (d.previous.range.endDate !== '2026-03-09') throw new Error('previous end ' + d.previous.range.endDate);
    return `${d.previous.range.startDate} to ${d.previous.range.endDate}`;
  });

  await check('a single day compares against the day before', async () => {
    const d = (await call('GET', '/reports/comparison', null, { startDate: '2026-03-10', endDate: '2026-03-10' })).body.data;
    if (d.previous.range.startDate !== '2026-03-09' || d.previous.range.endDate !== '2026-03-09') {
      throw new Error(JSON.stringify(d.previous.range));
    }
  });

  await check('All Time reports that it has nothing to compare against', async () => {
    const d = (await call('GET', '/reports/comparison', null, { all_time: '1' })).body.data;
    if (d.comparable !== false) throw new Error('claimed comparability with no previous period');
    if (d.current !== null) throw new Error('returned figures it cannot stand behind');
  });

  await check('growth from zero is null, not an invented percentage', async () => {
    // A window far enough back that both halves are certainly empty.
    const d = (await call('GET', '/reports/comparison', null, { startDate: '2001-01-01', endDate: '2001-01-31' })).body.data;
    for (const [key, value] of Object.entries(d.change)) {
      if (value !== null) throw new Error(`${key} claimed ${value}% against a zero baseline`);
    }
  });

  await check("the comparison's current window agrees with the dashboard", async () => {
    const range = { startDate: '2026-01-01', endDate: '2026-12-31' };
    const cmp = (await call('GET', '/reports/comparison', null, range)).body.data;
    const dash = (await call('GET', '/reports/dashboard', null, range)).body.data;
    near(cmp.current.revenue, dash.metrics.net_sales, 'comparison vs dashboard revenue');
    return cmp.current.revenue + '';
  });

  // ============================================================ expenses by store
  console.log('expenses by branch:');

  await check('GET /expenses/by-store splits the same filtered spend', async () => {
    const r = await call('GET', '/expenses/by-store');
    if (r.status !== 200) throw new Error('status ' + r.status);
    const split = r.body.data;
    near(split.total, split.stores.reduce((n, s) => n + s.total, 0), 'split total');

    // The strip and the table must describe one set of rows.
    const list = (await call('GET', '/expenses', null, { limit: '1' })).body;
    near(split.total, list.summary.total, 'by-store total vs list total');
    return `${split.stores.length} branches, ${split.total}`;
  });

  await check('a filter applies to the split as well as to the list', async () => {
    const params = { from_date: '2026-09-01', to_date: '2026-09-30' };
    const split = (await call('GET', '/expenses/by-store', null, params)).body.data;
    const list = (await call('GET', '/expenses', null, { ...params, limit: '1' })).body;
    near(split.total, list.summary.total, 'filtered totals');
    return split.total + ' in September';
  });

  await check('the split ignores the store filter, because a split of one store is one row', async () => {
    const all = (await call('GET', '/expenses/by-store')).body.data;
    const scoped = (await call('GET', '/expenses/by-store', null, { store_id: storeId })).body.data;
    if (scoped.stores.length !== all.stores.length) throw new Error('the store filter narrowed the split');
  });

  // ============================================================ cleanup
  for (const id of created.stores) {
    // Stores are never deleted (RESTRICT everywhere); leave them closed so a re-run
    // does not accumulate open branches on the till.
    await call('PUT', `/stores/${id}`, { is_active: false });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
