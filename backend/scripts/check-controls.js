/**
 * THE NEW CONTROLS, ATTACKED RATHER THAN DESCRIBED.
 *
 * Every one of these is a rule the UI also enforces, and the UI is not the control. A
 * cashier with devtools, or any other client, talks to the API directly — so each guard
 * is exercised with a hand-made request as the person it is meant to stop.
 *
 * WHAT IS BEING PROVED
 *
 * 1. The price band never reaches somebody who may not see it, from ANY endpoint. Not
 *    "the till hides it" — the bytes are not in the response.
 * 2. A cashier cannot leave a sale part-paid without a manager's approval, and cannot
 *    spend one approval twice or on a different customer.
 * 3. A discount that goes under the floor is refused once, with both numbers, and only
 *    goes through when the approver says so a second time.
 * 4. Notification topics actually silence the bell, and never the history.
 * 5. Hidden pages are a menu convenience and are honest about it: the API still
 *    answers, because the permission is the control.
 *
 * Nothing here uploads an image. Local dev writes to a real S3 bucket.
 */

process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();

const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const bcrypt = require('bcryptjs');

const BASE = process.env.CHECK_BASE || 'http://localhost:5000/api';

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

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const r = await api(null, 'POST', '/auth/login', { username, password });
  // This suite signs in as four different people, and /auth/login allows ten attempts
  // per fifteen minutes. Running it repeatedly exhausts that, and a 429 here otherwise
  // reads as the checks failing rather than as the limiter doing its job.
  if (r.status === 429) {
    console.log('\n  The login rate limit is exhausted (10 per 15 min). Wait a few '
      + 'minutes and re-run, or start the API with LOGIN_RATE_MAX raised.\n');
    process.exit(2);
  }
  assert(r.status === 200, `login ${username} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.accessToken || r.body.data.access_token || r.body.data.token;
}

/** Create-or-reset a scratch user with exactly these permissions. */
async function scratchUser({ username, permissions, storeId }) {
  const password = 'Scratch!2345';
  const hash = await bcrypt.hash(password, 10);
  let user = await knex('users').where('username', username).first();
  if (!user) {
    [user] = await knex('users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: hash,
      full_name: username,
      role_id: 3,
      store_id: storeId,
      is_active: true,
    }).returning('*');
  } else {
    await knex('users').where('id', user.id)
      .update({ password_hash: hash, is_active: true, store_id: storeId, hidden_pages: '[]' });
  }
  await knex('user_permissions').where('user_id', user.id).del();
  if (permissions.length) {
    await knex('user_permissions').insert(
      permissions.map((p) => ({ user_id: user.id, permission_code: p, access_level: 'write' }))
    );
  }
  await knex('user_stores').where('user_id', user.id).del();
  await knex('user_stores').insert({ user_id: user.id, store_id: storeId });
  return { ...user, password };
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log(`\n  The API is not answering at ${BASE}. Start the backend and re-run.\n`);
    process.exit(1);
  }

  const store = await knex('stores').where('is_active', true).first();
  assert(store, 'no active store');

  const adminToken = await login('admin', 'admin123');

  console.log('\n=== 1. The price band is not for everyone ===\n');

  // A cashier: may sell, may not price.
  const cashier = await scratchUser({
    username: 'chk_cashier',
    // `products` is granted so the catalogue endpoint can be checked for the band as
    // this person too; without it that request is a 403 and proves nothing.
    permissions: ['pos', 'sales', 'customers', 'inventory', 'products'],
    storeId: store.id,
  });
  const cashierToken = await login(cashier.username, cashier.password);

  // A manager: may price.
  const manager = await scratchUser({
    username: 'chk_manager',
    permissions: ['pos', 'sales', 'customers', 'inventory', 'price_override',
      'discount_approval', 'credit_approval', 'products'],
    storeId: store.id,
  });
  const managerToken = await login(manager.username, manager.password);

  const BAND = ['min_selling_price', 'max_selling_price',
    'store_min_selling_price', 'store_max_selling_price'];

  const bandIn = (payload) => {
    const text = JSON.stringify(payload);
    return BAND.filter((f) => text.includes(`"${f}"`));
  };

  const ENDPOINTS = [
    `/inventory?store_id=${store.id}&limit=5`,
    `/inventory/summary?store_id=${store.id}&limit=5`,
    `/inventory/product-grid?store_id=${store.id}&limit=5`,
    '/products?limit=5',
  ];

  for (const ep of ENDPOINTS) {
    await check(`a cashier gets no band from ${ep.split('?')[0]}`, async () => {
      const r = await api(cashierToken, 'GET', ep);
      assert(r.status === 200, `status ${r.status}`);
      const leaked = bandIn(r.body);
      assert(leaked.length === 0, `leaked ${leaked.join(', ')}`);
      return 'clean';
    });
  }

  await check('a manager still gets the band, or the test proves nothing', async () => {
    // If nobody sees the band, the checks above pass for the wrong reason.
    const r = await api(managerToken, 'GET', `/inventory?store_id=${store.id}&limit=5`);
    assert(r.status === 200, `status ${r.status}`);
    const present = bandIn(r.body);
    assert(present.length > 0, 'the band is missing for everyone — the filter is too broad');
    return present.join(', ');
  });

  await check('a cashier cannot read a branch price sheet at all', async () => {
    const r = await api(cashierToken, 'GET', `/stores/${store.id}/prices`);
    assert(r.status === 403, `expected 403, got ${r.status}`);
    return 'refused';
  });

  await check('a cashier cannot read a branch staff roster', async () => {
    const r = await api(cashierToken, 'GET', `/stores/${store.id}/staff`);
    assert(r.status === 403, `expected 403, got ${r.status}`);
    return 'refused';
  });

  await check('but branch NAMES stay readable, or the till cannot sell', async () => {
    const r = await api(cashierToken, 'GET', '/stores');
    assert(r.status === 200, `status ${r.status}`);
    assert((r.body.data || []).length > 0, 'no stores returned');
    return `${r.body.data.length} branches`;
  });

  console.log('\n=== 2. Pay later needs a manager ===\n');

  // A pair to sell, and a registered customer to sell it to.
  // THE EFFECTIVE price, not the catalogue one. A branch may set its own
  // (store_product_prices), and the server prices against that — so a test that sends
  // the catalogue figure is refused for changing the price, which looks exactly like
  // the credit guard failing. This codebase has been caught by that once already.
  const pair = await knex('inventory_items as ii')
    .join('product_variants as pv', 'pv.id', 'ii.variant_id')
    .join('products as p', 'p.id', 'pv.product_id')
    .leftJoin('store_product_prices as spp', function () {
      this.on('spp.product_id', '=', 'p.id').andOn('spp.store_id', '=', knex.raw('?', [store.id]));
    })
    .where('ii.store_id', store.id).where('ii.status', 'in_stock')
    .whereNotNull('p.default_selling_price')
    .first('ii.id', knex.raw('COALESCE(spp.selling_price, p.default_selling_price) as price'));
  assert(pair, 'no sellable stock at this branch');

  let customer = await knex('customers').where('name', 'Check Controls').first();
  if (!customer) {
    [customer] = await knex('customers')
      .insert({ name: 'Check Controls', phone: `01${Date.now()}`.slice(0, 11) })
      .returning('*');
  }

  const price = money(pair.price);

  await check('a cashier cannot leave a sale part-paid on their own', async () => {
    const r = await api(cashierToken, 'POST', '/sales', {
      store_id: store.id,
      customer_id: customer.id,
      items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: money(price / 2), payment_method: 'cash' }],
    });
    assert(r.status === 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(/pay-later|approve/i.test(r.body.message || ''), `unhelpful message: ${r.body.message}`);
    return r.body.message.slice(0, 60);
  });

  await check('a walk-in still cannot owe anything, approval or not', async () => {
    const r = await api(managerToken, 'POST', '/sales', {
      store_id: store.id,
      items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: money(price / 2), payment_method: 'cash' }],
    });
    assert(r.status === 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(/walk-in/i.test(r.body.message || ''), `message: ${r.body.message}`);
    return 'refused';
  });

  let creditRequestId;
  await check('the cashier can ASK, and the manager can answer', async () => {
    const asked = await api(cashierToken, 'POST', '/discounts', {
      store_id: store.id,
      customer_id: customer.id,
      kind: 'credit',
      items: [{ id: pair.id, sale_price: price }],
      requested_credit: money(price / 2),
      reason: 'regular customer',
    });
    assert(asked.status === 201, `ask -> ${asked.status} ${JSON.stringify(asked.body)}`);
    creditRequestId = asked.body.data.id;

    const decided = await api(managerToken, 'POST', `/discounts/${creditRequestId}/decide`, {
      approve: true,
    });
    assert(decided.status === 200, `decide -> ${decided.status} ${JSON.stringify(decided.body)}`);
    assert(money(decided.body.data.approved_credit) === money(price / 2),
      `approved ${decided.body.data.approved_credit}`);
    return `approved ${decided.body.data.approved_credit}`;
  });

  await check('a cashier without the permission cannot answer their own request', async () => {
    const asked = await api(cashierToken, 'POST', '/discounts', {
      store_id: store.id,
      customer_id: customer.id,
      kind: 'credit',
      items: [{ id: pair.id, sale_price: price }],
      requested_credit: 10,
    });
    assert(asked.status === 201, `ask -> ${asked.status}`);
    const self = await api(cashierToken, 'POST', `/discounts/${asked.body.data.id}/decide`, {
      approve: true,
    });
    assert(self.status === 403, `expected 403, got ${self.status}`);
    await api(cashierToken, 'POST', `/discounts/${asked.body.data.id}/cancel`);
    return 'refused';
  });

  let saleId;
  await check('with the approval, the part-paid sale goes through', async () => {
    const r = await api(cashierToken, 'POST', '/sales', {
      store_id: store.id,
      customer_id: customer.id,
      items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: money(price / 2), payment_method: 'cash' }],
      credit_request_id: creditRequestId,
    });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    saleId = r.body.data.id;
    return r.body.data.sale_number;
  });

  await check('the same approval cannot be spent a second time', async () => {
    const other = await knex('inventory_items')
      .where({ store_id: store.id, status: 'in_stock' }).whereNot('id', pair.id).first('id');
    if (!other) return 'no second pair to try with';
    const r = await api(cashierToken, 'POST', '/sales', {
      store_id: store.id,
      customer_id: customer.id,
      items: [{ id: other.id, sale_price: price }],
      payments: [{ amount: money(price / 2), payment_method: 'cash' }],
      credit_request_id: creditRequestId,
    });
    assert(r.status === 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    return 'refused as already used';
  });

  console.log('\n=== 3. The discount floor ===\n');

  // A product with a real floor, so the guard has something to breach.
  const floorPair = await knex('inventory_items as ii')
    .join('product_variants as pv', 'pv.id', 'ii.variant_id')
    .join('products as p', 'p.id', 'pv.product_id')
    .leftJoin('store_product_prices as spp', function () {
      this.on('spp.product_id', '=', 'p.id').andOn('spp.store_id', '=', knex.raw('?', [store.id]));
    })
    .where('ii.store_id', store.id).where('ii.status', 'in_stock')
    .whereNotNull('p.min_selling_price')
    .whereRaw('p.min_selling_price > 0')
    .first(
      'ii.id',
      knex.raw('COALESCE(spp.selling_price, p.default_selling_price) as price'),
      knex.raw('COALESCE(spp.min_selling_price, p.min_selling_price) as floor')
    );

  if (!floorPair) {
    console.log('  --   no product with a minimum price in stock; floor checks skipped');
  } else {
    let reqId;
    await check('a request records the floor as it was when asked', async () => {
      const r = await api(cashierToken, 'POST', '/discounts', {
        store_id: store.id,
        items: [{ id: floorPair.id, sale_price: money(floorPair.price) }],
        requested_discount: money(money(floorPair.price) - money(floorPair.floor) + 10),
        reason: 'floor check',
      });
      assert(r.status === 201, `ask -> ${r.status} ${JSON.stringify(r.body)}`);
      reqId = r.body.data.id;
      assert(money(r.body.data.min_total) === money(floorPair.floor),
        `min_total ${r.body.data.min_total} vs floor ${floorPair.floor}`);
      return `floor ${r.body.data.min_total}`;
    });

    await check('approving below it is refused first, with both numbers', async () => {
      const r = await api(managerToken, 'POST', `/discounts/${reqId}/decide`, { approve: true });
      assert(r.status === 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(r.body.details?.below_min, 'no structured details for the screen to render');
      assert(money(r.body.details.min_total) === money(floorPair.floor), 'wrong floor reported');
      assert(r.body.details.shortfall > 0, 'no shortfall reported');
      return `under by ${r.body.details.shortfall}`;
    });

    await check('and goes through when the manager says so again', async () => {
      const r = await api(managerToken, 'POST', `/discounts/${reqId}/decide`, {
        approve: true, acknowledge_below_min: true,
      });
      assert(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(r.body.data.below_min_acknowledged === true,
        'the override was not recorded, so nobody can see it happened');
      return 'recorded as acknowledged';
    });

    await check('a discount that stays above the floor is never questioned', async () => {
      const r = await api(cashierToken, 'POST', '/discounts', {
        store_id: store.id,
        items: [{ id: floorPair.id, sale_price: money(floorPair.price) }],
        requested_discount: 1,
      });
      assert(r.status === 201, `ask -> ${r.status}`);
      const d = await api(managerToken, 'POST', `/discounts/${r.body.data.id}/decide`, { approve: true });
      assert(d.status === 200, `expected 200, got ${d.status}: ${JSON.stringify(d.body)}`);
      assert(d.body.data.below_min_acknowledged === false, 'wrongly flagged as below minimum');
      await api(managerToken, 'POST', `/discounts/${r.body.data.id}/cancel`).catch(() => {});
      return 'approved cleanly';
    });
  }

  console.log('\n=== 4. Notification topics ===\n');

  await check('the topic list comes back with a default for every topic', async () => {
    const r = await api(adminToken, 'GET', `/notifications/preferences/users/${cashier.id}`);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.data.length >= 10, `only ${r.body.data.length} topics`);
    assert(r.body.data.every((x) => typeof x.enabled === 'boolean'), 'a topic has no answer');
    return `${r.body.data.length} topics`;
  });

  await check('switching a topic off hides it from the bell', async () => {
    // Raise one directly, so the check does not depend on something else happening.
    await knex('notifications').insert({
      user_id: cashier.id,
      type: 'staff_expense',
      title: 'check-controls probe',
      message: 'probe',
      is_read: false,
    });

    const before = await api(cashierToken, 'GET', '/notifications');
    const seen = (before.body.data || []).filter((n) => n.type === 'staff_expense').length;
    assert(seen > 0, 'the probe notification was not delivered at all');

    await api(adminToken, 'PUT', `/notifications/preferences/users/${cashier.id}`, {
      preferences: [{ type: 'staff_expense', enabled: false }],
    });

    const after = await api(cashierToken, 'GET', '/notifications');
    const still = (after.body.data || []).filter((n) => n.type === 'staff_expense').length;
    assert(still === 0, `${still} muted notifications still in the bell`);
    return `${seen} hidden`;
  });

  await check('but the history still has it — muting is not deleting', async () => {
    const r = await api(cashierToken, 'GET', '/notifications/history?include_muted=true&limit=100');
    assert(r.status === 200, `status ${r.status}`);
    const found = (r.body.data || []).filter((n) => n.type === 'staff_expense').length;
    assert(found > 0, 'the record is gone, not just hidden');
    return `${found} kept`;
  });

  await check('a cashier cannot set anybody else\'s topics', async () => {
    const r = await api(cashierToken, 'PUT', `/notifications/preferences/users/${manager.id}`, {
      preferences: [{ type: 'staff_expense', enabled: false }],
    });
    assert(r.status === 403, `expected 403, got ${r.status}`);
    return 'refused';
  });

  await knex('notifications').where('title', 'check-controls probe').del();
  await api(adminToken, 'PUT', `/notifications/preferences/users/${cashier.id}`, { preferences: [] });

  console.log('\n=== 5. Hidden pages are a menu, not a lock ===\n');

  await check('a hidden page is recorded against the user', async () => {
    const r = await api(adminToken, 'PUT', `/users/${cashier.id}/hidden-pages`, {
      pages: ['/reports', '/not-a-real-page'],
    });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.data.includes('/reports'), 'the real page was not stored');
    assert(!r.body.data.includes('/not-a-real-page'), 'an unknown path was stored');
    return r.body.data.join(', ');
  });

  await check('the dashboard and settings can never be hidden', async () => {
    const r = await api(adminToken, 'PUT', `/users/${cashier.id}/hidden-pages`, {
      pages: ['/', '/settings', '/reports'],
    });
    assert(r.status === 200, `status ${r.status}`);
    assert(!r.body.data.includes('/'), 'the dashboard was hidden — that redirect is a loop');
    assert(!r.body.data.includes('/settings'), 'settings was hidden — no way to fix your own account');
    return 'both refused';
  });

  await check('hiding a page does NOT protect its data, and the check says so', async () => {
    // The honest, load-bearing assertion. If this ever starts returning 403, somebody
    // has begun treating hidden_pages as a permission, and the UI hint that calls it
    // "not a lock" has become a lie.
    const withReports = await scratchUser({
      username: 'chk_hidden',
      permissions: ['reports'],
      storeId: store.id,
    });
    await api(adminToken, 'PUT', `/users/${withReports.id}/hidden-pages`, { pages: ['/reports'] });
    const token = await login(withReports.username, withReports.password);
    const r = await api(token, 'GET', '/reports/dashboard');
    assert(r.status === 200,
      `hiding a page changed API access (${r.status}) — it is documented as not doing that`);
    return 'API still answers, as documented';
  });

  await api(adminToken, 'PUT', `/users/${cashier.id}/hidden-pages`, { pages: [] });

  console.log('\n=== putting everything back ===\n');

  await check('the run leaves no stock sold and no request hanging', async () => {
    // Every other check script in this repo resets itself, and this one did not: the
    // part-paid sale it makes takes a pair out of stock for good, which then surfaces
    // as an unrelated browser test failing to find anything to sell. Fixture hygiene
    // is not optional when the suites share one database.
    let undone = 0;
    if (saleId) {
      const v = await api(adminToken, 'POST', `/sales/${saleId}/void`,
        { body: { reason: 'check-controls cleanup' } });
      if (v.status === 200 || v.status === 201) undone += 1;
    }
    const stale = await knex('discount_requests')
      .whereIn('status', ['pending', 'approved'])
      .whereIn('requested_by', [cashier.id, manager.id])
      .pluck('id');
    if (stale.length) {
      await knex('discount_requests').whereIn('id', stale).update({ status: 'cancelled' });
    }
    return `${undone} sale voided, ${stale.length} request(s) closed`;
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await knex.destroy();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
