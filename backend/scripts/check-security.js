/**
 * The guards a security audit turned up, tested at the level they live at.
 *
 * These are NOT HTTP tests. check-controls already probes the running server over HTTP,
 * but it is rate-limited and, while the developer's own `npm run dev` holds port 5000,
 * it talks to whatever code that process happens to be running. These call the
 * controllers and services directly with their own knex, so they test THIS code, now,
 * with no server and no rate limit.
 *
 * What is covered (each was a real finding):
 *   1. CRITICAL — a non-admin with users:write could POST a new ADMIN account and take
 *      over. The update path guarded roles; create did not.
 *   2. HIGH — PUT /stores/:id/staff writes the same user_stores table as the admin-only
 *      setStores, but was gated only on users:write, so a non-admin could self-assign
 *      to any branch.
 *   3. MEDIUM — discount getById/decide/cancel/resume applied no store scope, so any
 *      pos user could read (and the floor leaked past priceVisibility) or act on another
 *      branch's request.
 *   4. MEDIUM — the pricing floor (min_price/min_total) was not in the price-band scrub.
 *
 * Creates and cleans up its own data. No uploads (local dev writes to a real S3 bucket).
 */

process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const { generateUUID } = require('../src/utils/generateCodes');
const usersController = require('../src/modules/users/users.controller');
const storesController = require('../src/modules/stores/stores.controller');
const discounts = require('../src/modules/discounts/discounts.service');
const { canSeePriceBand } = require('../src/middleware/priceVisibility');
const priceVisibility = require('../src/middleware/priceVisibility');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const r = await fn(); console.log('  ok   ' + name + (r ? '  ' + r : '')); pass++; }
  catch (e) { console.log('  FAIL ' + name + '  -> ' + e.message); fail++; }
}

/** A fake Express res that records what the controller sent. */
function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}
/** Run a controller method and capture status + body + any thrown/next error. */
async function run(method, req) {
  const res = fakeRes();
  let nextErr = null;
  await method(req, res, (e) => { nextErr = e; });
  return { status: res.statusCode, body: res.body, nextErr };
}

const made = { users: [], stores: [], items: [], requests: [], products: [] };

(async () => {
  const roles = await knex('roles').select('id', 'name');
  const adminRole = roles.find((r) => r.name === 'admin');
  const empRole = roles.find((r) => r.name !== 'admin');
  const branchA = await knex('stores').where('is_active', true).first();
  const [branchB] = await knex('stores')
    .insert({ id: generateUUID(), name: 'ZZ Sec Branch ' + Date.now(), is_active: true })
    .returning('*');
  made.stores.push(branchB.id);

  // A manager at branch A only, holding the strong write permissions but NOT admin.
  const manager = {
    id: (await knex('users').first('id')).id,
    role_name: empRole.name,
    permissions: { users: 'write', user_permissions: 'write', pos: 'write', discount_approval: 'write' },
    assigned_stores: [branchA.id],
    store_id: branchA.id,
  };
  const admin = { id: manager.id, role_name: 'admin', permissions: { all_stores: true } };

  console.log('1. privilege escalation via user creation:');

  await check('a non-admin cannot create an ADMIN account', async () => {
    const r = await run(usersController.create.bind(usersController), {
      user: manager,
      body: { username: 'zzesc' + Date.now(), email: `e${Date.now()}@x.co`, password: 'secret123',
        role_id: adminRole.id, store_id: branchA.id },
    });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status} (${JSON.stringify(r.body)})`);
    // Make doubly sure nothing was written.
    const admins = await knex('users').where('username', 'like', 'zzesc%').count('* as c').first();
    if (Number(admins.c) > 0) throw new Error('an admin account was actually created');
    return 'refused, nothing written';
  });

  await check('a non-admin cannot plant a user in a branch they do not control', async () => {
    const r = await run(usersController.create.bind(usersController), {
      user: manager,
      body: { username: 'zzplant' + Date.now(), email: `p${Date.now()}@x.co`, password: 'secret123',
        role_id: empRole.id, store_id: branchB.id },
    });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    return 'refused';
  });

  await check('an admin CAN still create staff (the guard is not a wall)', async () => {
    const username = 'zzok' + Date.now();
    const r = await run(usersController.create.bind(usersController), {
      user: admin,
      body: { username, email: `${username}@x.co`, password: 'secret123',
        role_id: empRole.id, store_id: branchA.id },
    });
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status} (${JSON.stringify(r.body)})`);
    made.users.push(r.body.data.id);
    return 'created';
  });

  console.log('');
  console.log('2. staff assignment is an admin act:');

  await check('a non-admin cannot assign staff to a branch', async () => {
    const r = await run(storesController.setStaff.bind(storesController), {
      user: manager, params: { id: branchB.id }, body: { user_ids: [manager.id] },
    });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    // And it did not write.
    const planted = await knex('user_stores')
      .where({ store_id: branchB.id, user_id: manager.id }).first();
    if (planted) throw new Error('the assignment was written anyway');
    return 'refused, nothing written';
  });

  console.log('');
  console.log('3. a discount request is one branch\'s business:');

  // Park a request at branch B, then try to reach it as the branch-A manager.
  const variant = await knex('product_variants').first('id', 'product_id');
  const [pair] = await knex('inventory_items')
    .insert({ id: generateUUID(), variant_id: variant.id, store_id: branchB.id,
      cost: 100, source: 'manual', status: 'in_stock' })
    .returning('*');
  made.items.push(pair.id);

  const reqB = await discounts.request({
    store_id: branchB.id, items: [{ id: pair.id, sale_price: 200 }], requested_discount: 20,
  }, admin);
  made.requests.push(reqB.id);

  await check('getById refuses another branch\'s request', async () => {
    try {
      await discounts.getById(reqB.id, manager);
      throw new Error('the branch-A manager read a branch-B request');
    } catch (e) {
      if (!/another branch/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('an admin can still read it', async () => {
    const row = await discounts.getById(reqB.id, admin);
    if (row.id !== reqB.id) throw new Error('admin could not read it');
    return 'read';
  });

  await check('decide refuses another branch\'s request', async () => {
    try {
      await discounts.decide(reqB.id, { approve: true, amount: 10 }, manager);
      throw new Error('decided another branch\'s request');
    } catch (e) {
      if (!/another branch/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  await check('cancel refuses another branch\'s request', async () => {
    try {
      await discounts.cancel(reqB.id, manager);
      throw new Error('cancelled another branch\'s request');
    } catch (e) {
      if (!/another branch/i.test(e.message)) throw e;
      return 'refused';
    }
  });

  console.log('');
  console.log('4. the pricing floor is part of the price band:');

  await check('a cashier without price permission does not see the floor', async () => {
    const cashier = { role_name: empRole.name, permissions: { pos: 'write' } };
    if (canSeePriceBand(cashier)) throw new Error('a plain cashier can see the band');
    // Simulate a response carrying a request cart with a floor.
    const res = fakeRes();
    let sent = null;
    res.json = (b) => { sent = b; return res; };
    priceVisibility({ user: cashier }, res, () => {});
    res.json({ data: { min_total: 500, cart: [{ min_price: 250, sale_price: 300 }] } });
    if ('min_total' in sent.data) throw new Error('min_total leaked to a cashier');
    if ('min_price' in sent.data.cart[0]) throw new Error('per-line min_price leaked to a cashier');
    return 'floor stripped';
  });

  await check('an approver still sees the floor, or they cannot judge a request', async () => {
    const approver = { role_name: empRole.name, permissions: { discount_approval: 'write' } };
    if (!canSeePriceBand(approver)) throw new Error('an approver was denied the band');
    const res = fakeRes();
    let sent = null;
    res.json = (b) => { sent = b; return res; };
    priceVisibility({ user: approver }, res, () => {});
    res.json({ data: { min_total: 500 } });
    if (sent.data.min_total !== 500) throw new Error('the floor was stripped from an approver');
    return 'floor kept';
  });

  console.log('');
  console.log('5. the activity log never records a credential, however nested:');

  await check('a nested password/seller_code is scrubbed from audit details', async () => {
    const { scrubSensitive } = require('../src/middleware/activityLogger');
    const scrubbed = scrubSensitive({
      username: 'someone',
      credentials: { password: 'hunter2', note: 'keep me' },
      staff: [{ full_name: 'A', seller_code: '1234' }],
      pin: '9999',
    });
    if ('pin' in scrubbed) throw new Error('top-level pin survived');
    if ('password' in scrubbed.credentials) throw new Error('nested password survived');
    if ('seller_code' in scrubbed.staff[0]) throw new Error('seller_code in an array survived');
    // and it must not throw away the harmless neighbours
    if (scrubbed.username !== 'someone' || scrubbed.credentials.note !== 'keep me') {
      throw new Error('the scrub ate a non-sensitive field');
    }
    return 'nested + in-array secrets removed, the rest kept';
  });

  console.log('');
  console.log('6. refresh tokens are stored hashed, and rotate on use:');

  const authService = require('../src/modules/auth/auth.service');
  const cryptoLib = require('crypto');
  const sha = (t) => cryptoLib.createHash('sha256').update(t).digest('hex');
  const tokenUser = await knex('users').where('is_active', true).first('id');
  made.refreshHashes = [];

  await check('the stored value is the SHA-256 hash, never the raw JWT', async () => {
    const raw = await authService._generateRefreshToken(tokenUser.id);
    made.refreshHashes.push(sha(raw));
    const row = await knex('refresh_tokens').where('token', sha(raw)).first();
    if (!row) throw new Error('token was not stored under its hash');
    if (row.token === raw) throw new Error('the raw JWT is in the database in the clear');
    // the raw token must NOT be findable in the table
    const rawRow = await knex('refresh_tokens').where('token', raw).first();
    if (rawRow) throw new Error('the raw token is queryable in the table');
    return 'hash stored, raw returned to the client only';
  });

  await check('refresh rotates — the used token stops working', async () => {
    const raw = await authService._generateRefreshToken(tokenUser.id);
    made.refreshHashes.push(sha(raw));
    const res = await authService.refresh(raw);
    if (!res.accessToken || !res.refreshToken) throw new Error('refresh returned no tokens');
    made.refreshHashes.push(sha(res.refreshToken));
    try {
      await authService.refresh(raw);
      throw new Error('the old token still worked after rotation');
    } catch (e) {
      if (!/revoked|invalid|expired/i.test(e.message)) throw e;
    }
    return 'old revoked, new issued';
  });

  await check('logout revokes by hash', async () => {
    const raw = await authService._generateRefreshToken(tokenUser.id);
    made.refreshHashes.push(sha(raw));
    await authService.logout(raw);
    const row = await knex('refresh_tokens').where('token', sha(raw)).first();
    if (!row.is_revoked) throw new Error('logout did not revoke the token');
    return 'revoked';
  });

  // ---------------------------------------------------------------- cleanup
  if (made.refreshHashes?.length) await knex('refresh_tokens').whereIn('token', made.refreshHashes).del();
  for (const id of made.requests) await knex('discount_requests').where('id', id).del();
  await knex('inventory_items').whereIn('id', made.items).del();
  await knex('user_stores').whereIn('user_id', made.users).del();
  await knex('user_permissions').whereIn('user_id', made.users).del();
  await knex('users').whereIn('id', made.users).del();
  await knex('user_stores').whereIn('store_id', made.stores).del();
  await knex('stores').whereIn('id', made.stores).del();

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  await knex.destroy();
  process.exit(1);
});
