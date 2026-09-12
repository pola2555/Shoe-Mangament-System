/**
 * THE AUDIT TRAIL, AND THE PERMISSION MAP.
 *
 * Two things the user asked for, and they are checked together because they share one
 * failure mode: something that LOOKS present and is not. A log row that says a store id
 * instead of a store name looks like a record and is not one. A permission that can be
 * granted but gates nothing looks like a control and is not one.
 *
 * THE LOAD-BEARING CHECKS
 *
 * 1. Every DELETE route the app mounts is covered by a snapshot target, or excused by
 *    name. A delete is the one case where the log is the only surviving copy of the
 *    record, and it was the one case that logged nothing at all.
 * 2. A seller passcode can never reach the log. It is bcrypt-hashed in the users table
 *    precisely because it is a credential; the log accepted it in plaintext from the
 *    body of every sale.
 * 3. Every mount in app.js is in the logger's module map. Nine modules were missing —
 *    including the cash drawer, which is what an audit trail is FOR.
 * 4. Every permission gates something, and nothing is gated two different ways.
 *
 * No uploads: local dev writes to a real S3 bucket.
 */

process.chdir(require('path').join(__dirname, '..'));
process.env.PORT = process.env.AUDIT_PORT || '5098';

const fs = require('fs');
const path = require('path');
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);

// Tag every permission gate before the routes are built, so the mounted app can be
// asked what it actually enforces rather than the route files being read by eye.
const permissionPath = require.resolve('../src/middleware/permission');
const realPermission = require(permissionPath);
require.cache[permissionPath].exports = function tagged(code, level = 'read') {
  const mw = realPermission(code, level);
  mw._gate = { code, level };
  return mw;
};

const app = require('../src/app');
const { resolveActivityInfo, SENSITIVE_FIELDS } = require('../src/middleware/activityLogger');
const { findDeleteTarget, isExcusedDelete, DELETE_TARGETS } = require('../src/middleware/auditTargets');
const { resolveNames, SOURCES, ENTITY_SOURCES, FIELD_SOURCES } = require('../src/utils/auditNames');

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

// ------------------------------------------------------------------ route walking
const routes = [];
function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all')
        .map((m) => m.toUpperCase());
      const gates = layer.route.stack.filter((h) => h.handle?._gate).map((h) => h.handle._gate);
      routes.push({ methods, path: prefix + layer.route.path, gates });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountOf(layer.regexp));
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, prefix);
    }
  }
}
function mountOf(re) {
  if (!re) return '';
  const src = re.source;
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  const m = src.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/').replace(/\$$/, '');
  return m.startsWith('/') ? m : '';
}
walk(app._router.stack, '');
const apiRoutes = routes.filter((r) => r.path.startsWith('/api/') && !/\/api\/health/.test(r.path));

/** Turn `/api/expenses/:id` into a concrete path a matcher can be tested against. */
const concrete = (p) => p.replace(/:[A-Za-z0-9_]+/g,
  '11111111-2222-3333-4444-555555555555');

async function main() {
  console.log('\n=== 1. DELETE routes are audited ===\n');

  const deleteRoutes = apiRoutes.filter((r) => r.methods.includes('DELETE'));

  await check('the app actually mounts DELETE routes', async () =>
    (assert(deleteRoutes.length >= 20, `only ${deleteRoutes.length} found`),
      `${deleteRoutes.length} routes`));

  await check('every DELETE route has a snapshot target or a written excuse', async () => {
    const uncovered = [];
    for (const r of deleteRoutes) {
      const p = concrete(r.path);
      if (!findDeleteTarget(p) && !isExcusedDelete(p)) uncovered.push(r.path);
    }
    assert(uncovered.length === 0,
      `no snapshot for: ${uncovered.join(', ')} — add it to middleware/auditTargets.js`);
    return `${deleteRoutes.length} covered`;
  });

  await check('every snapshot target names a real table with real columns', async () => {
    for (const t of DELETE_TARGETS) {
      const cols = await knex('information_schema.columns')
        .where('table_name', t.table).pluck('column_name');
      assert(cols.length > 0, `table ${t.table} does not exist`);
      const missing = t.columns.filter((c) => !cols.includes(c));
      assert(missing.length === 0, `${t.table} has no ${missing.join(', ')}`);
    }
    return `${DELETE_TARGETS.length} targets`;
  });

  await check('no snapshot target reads a password or a code hash', async () => {
    for (const t of DELETE_TARGETS) {
      const bad = t.columns.filter((c) => /password|hash|secret|token/i.test(c));
      assert(bad.length === 0, `${t.table} snapshot would keep ${bad.join(', ')}`);
    }
  });

  await check('a delete of an expense snapshots the expense', async () => {
    const target = findDeleteTarget('/api/expenses/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert(target, 'no target matched');
    assert(target.target.table === 'expenses', `matched ${target.target.table}`);
    assert(target.target.columns.includes('amount'), 'amount not captured');
    assert(target.target.columns.includes('description'), 'description not captured');
    return 'amount + description + date';
  });

  await check('nested delete paths beat the bare /:id pattern', async () => {
    const cat = findDeleteTarget('/api/expenses/categories/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert(cat.target.table === 'expense_categories',
      `an expense category matched ${cat.target.table} — order in DELETE_TARGETS is wrong`);
    const receipt = findDeleteTarget('/api/expenses/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/receipts/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert(receipt.target.table === 'attached_images', `a receipt matched ${receipt.target.table}`);
    const pay = findDeleteTarget('/api/loans/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/payments/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert(pay.target.table === 'loan_payments', `a loan payment matched ${pay.target.table}`);
    return 'categories, receipts and loan payments each match their own table';
  });

  console.log('\n=== 2. Credentials never reach the log ===\n');

  await check('a seller passcode is filtered out of the details', async () => {
    assert(SENSITIVE_FIELDS.has('seller_code'),
      'seller_code is not in the denylist — every sale would log the cashier\'s passcode');
    for (const f of ['password', 'newPassword', 'code', 'pin', 'seller_code_hash']) {
      assert(SENSITIVE_FIELDS.has(f), `${f} is not filtered`);
    }
    return `${SENSITIVE_FIELDS.size} fields filtered`;
  });

  await check('the sale endpoint really does accept a seller_code', async () => {
    // If this ever stops being true the denylist entry above is dead weight, and the
    // check should be re-pointed rather than left passing for the wrong reason.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'modules', 'sales', 'sales.validation.js'), 'utf8');
    assert(src.includes('seller_code'), 'sales.validation.js no longer accepts seller_code');
  });

  await check('nothing already stored contains a plaintext code field', async () => {
    const rows = await knex('activity_log')
      .whereRaw("details::text ILIKE '%\"seller_code\"%' OR details::text ILIKE '%\"password\"%' OR details::text ILIKE '%\"pin\"%'")
      .count('id as c').first();
    assert(Number(rows.c) === 0, `${rows.c} log rows carry a credential`);
    return 'none';
  });

  console.log('\n=== 3. Nothing writes without being logged ===\n');

  await check('every /api mount appears in the logger module map', async () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const mounts = [...appSrc.matchAll(/app\.use\('\/api\/([a-z-]+)'/g)].map((m) => m[1]);
    const unlogged = [];
    for (const mount of mounts) {
      // audit-log, backup and reports are read-only or self-referential by design.
      if (['audit-log', 'backup', 'reports'].includes(mount)) continue;
      // auth logs only its meaningful actions; a bare POST /api/auth is not a route,
      // and a token refresh is deliberately excluded, so probe a real one.
      const url = mount === 'auth' ? '/api/auth/login' : `/api/${mount}`;
      const info = resolveActivityInfo({
        method: 'POST', originalUrl: url, params: {}, body: {},
      });
      if (!info) unlogged.push(mount);
    }
    assert(unlogged.length === 0,
      `these modules write without being audited: ${unlogged.join(', ')}`);
    return `${mounts.length} mounts`;
  });

  await check('the cash drawer is audited', async () => {
    const move = resolveActivityInfo({ method: 'POST', originalUrl: '/api/shifts/movements', params: {}, body: {} });
    assert(move && move.action === 'cash_movement', `got ${JSON.stringify(move)}`);
    const open = resolveActivityInfo({ method: 'POST', originalUrl: '/api/shifts', params: {}, body: {} });
    assert(open && open.action === 'open_shift', `got ${JSON.stringify(open)}`);
    const close = resolveActivityInfo({ method: 'POST', originalUrl: '/api/shifts/x/close', params: {}, body: {} });
    assert(close && close.action === 'close_shift', `got ${JSON.stringify(close)}`);
    return 'open, close and takings';
  });

  await check('voiding a sale and setting a seller code are audited as themselves', async () => {
    const v = resolveActivityInfo({ method: 'POST', originalUrl: '/api/sales/x/void', params: {}, body: {} });
    assert(v && v.action === 'void', `void logged as ${v && v.action}`);
    const c = resolveActivityInfo({ method: 'PUT', originalUrl: '/api/discounts/sellers/x/code', params: {}, body: {} });
    assert(c && c.action === 'set_seller_code', `seller code logged as ${c && c.action}`);
    assert(c.entityType === 'seller_code', `entity type ${c.entityType}`);
  });

  await check('a token refresh is still not logged', async () => {
    const r = resolveActivityInfo({ method: 'POST', originalUrl: '/api/auth/refresh', params: {}, body: {} });
    assert(r === null, 'refresh is being logged, which would fill the table');
  });

  console.log('\n=== 4. Ids become names ===\n');

  await check('a store id in details resolves to the branch name', async () => {
    const store = await knex('stores').first('id', 'name');
    assert(store, 'no stores');
    const names = await resolveNames([
      { entity_type: 'store', entity_id: store.id, module: 'stores', details: { store_id: store.id } },
    ]);
    assert(names[store.id] === store.name, `got ${JSON.stringify(names)}`);
    return `${store.name}`;
  });

  await check('the Entity column resolves for every entity type the logger emits', async () => {
    const emitted = new Set();
    const paths = [
      ['POST', '/api/sales'], ['POST', '/api/stores'], ['POST', '/api/users'],
      ['POST', '/api/customers'], ['POST', '/api/suppliers'], ['POST', '/api/expenses'],
      ['POST', '/api/loans'], ['POST', '/api/shifts'], ['POST', '/api/exchanges'],
      ['POST', '/api/stock-counts'], ['POST', '/api/stock-intakes'], ['POST', '/api/transfers'],
      ['POST', '/api/purchases/invoices'], ['POST', '/api/discounts'], ['POST', '/api/products'],
      ['POST', '/api/dealers'], ['POST', '/api/inventory/manual'], ['POST', '/api/returns/customer'],
      ['POST', '/api/product-categories'], ['POST', '/api/box-templates'],
    ];
    for (const [method, url] of paths) {
      const info = resolveActivityInfo({ method, originalUrl: url, params: {}, body: {} });
      if (info?.entityType) emitted.add(info.entityType);
    }
    const unknown = [...emitted].filter((t) => !(t in ENTITY_SOURCES));
    assert(unknown.length === 0,
      `entity types with no name lookup: ${unknown.join(', ')} — add them to utils/auditNames.js`);
    return `${emitted.size} types`;
  });

  await check('every name source points at a real table and real columns', async () => {
    for (const [key, def] of Object.entries(SOURCES)) {
      const cols = await knex('information_schema.columns')
        .where('table_name', def.table).pluck('column_name');
      assert(cols.length > 0, `${key}: table ${def.table} does not exist`);
      const missing = def.columns.filter((c) => !cols.includes(c));
      assert(missing.length === 0, `${key}: ${def.table} has no ${missing.join(', ')}`);
    }
    return `${Object.keys(SOURCES).length} sources`;
  });

  await check('every field source names a source that exists', async () => {
    const bad = Object.entries(FIELD_SOURCES).filter(([, s]) => !SOURCES[s]);
    assert(bad.length === 0, `dangling: ${bad.map(([f, s]) => `${f}->${s}`).join(', ')}`);
  });

  await check('a placeholder colour is never named as if somebody chose it', async () => {
    const ph = await knex('product_colors').where('is_placeholder', true).first('id');
    if (!ph) return 'no placeholder colours in this database';
    const names = await resolveNames([
      { entity_type: 'color', entity_id: ph.id, module: 'products', details: {} },
    ]);
    assert(names[ph.id] === undefined,
      `the stand-in colour was rendered as "${names[ph.id]}"`);
    return 'left blank';
  });

  await check('resolving a page of real log rows costs one query per table', async () => {
    const rows = await knex('activity_log').orderBy('created_at', 'desc').limit(50);
    // resolveNames uses the APP's knex instance, not this script's — counting on the
    // wrong one silently reported zero queries and proved nothing.
    const appDb = require('../src/config/database');
    let queries = 0;
    const listener = () => { queries += 1; };
    appDb.on('query', listener);
    const names = await resolveNames(rows);
    appDb.removeListener('query', listener);
    assert(queries > 0, 'no queries ran at all — the listener is on the wrong instance');
    // 44 permissions worth of sources exist; a page can only touch a handful.
    assert(queries <= Object.keys(SOURCES).length,
      `${queries} queries for 50 rows — that is per-row, not batched`);
    return `${queries} queries, ${Object.keys(names).length} names for ${rows.length} rows`;
  });

  console.log('\n=== 5. Permissions: correct, and no overlap ===\n');

  const perms = await knex('permissions').select('code', 'category', 'description');
  const known = new Set(perms.map((p) => p.code));

  await check('no route names a permission that cannot be granted', async () => {
    const bad = [];
    for (const r of apiRoutes) {
      for (const g of r.gates) {
        if (!known.has(g.code)) bad.push(`${r.methods.join('|')} ${r.path} -> ${g.code}`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
    return `${apiRoutes.length} routes`;
  });

  await check('every permission gates something', async () => {
    const used = new Set();
    apiRoutes.forEach((r) => r.gates.forEach((g) => used.add(g.code)));

    // Some permissions are enforced inside a service or controller rather than as
    // route middleware — `price_override` is checked while pricing a line, not at the
    // door. Those are found by reading the source rather than kept in a list here: a
    // hand-kept second copy is the exact failure this whole suite exists to catch.
    const srcDir = path.join(__dirname, '..', 'src');
    const sources = [];
    (function walkDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'migrations') walkDir(full); }
        else if (entry.name.endsWith('.js')) sources.push(fs.readFileSync(full, 'utf8'));
      }
    }(srcDir));
    const allSource = sources.join('\n');

    const checkedInCode = [];
    for (const p of perms) {
      // Matches `permissions.foo`, `permissions?.foo` and `permissions['foo']`.
      const dot = `permissions\\??\\.${p.code}\\b`;
      const bracket = `permissions\\??\\[['"\`]${p.code}['"\`]\\]`;
      if (new RegExp(`${dot}|${bracket}`).test(allSource)) {
        used.add(p.code);
        checkedInCode.push(p.code);
      }
    }

    const dead = perms.filter((p) => !used.has(p.code)).map((p) => p.code);
    assert(dead.length === 0,
      `these can be granted but gate nothing: ${dead.join(', ')}`);
    return `${perms.length} permissions, all live (${checkedInCode.length} enforced in code)`;
  });

  await check('a write route is never gated at read level', async () => {
    const bad = [];
    for (const r of apiRoutes) {
      const isWrite = r.methods.some((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m));
      if (!isWrite) continue;
      for (const g of r.gates) {
        if (g.level === 'read') bad.push(`${r.methods.join('|')} ${r.path} (${g.code})`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  await check('branch pricing has exactly one permission, not two', async () => {
    // store_product_prices is writable from the product page and the branch page. They
    // used to answer to product_prices and stores respectively, so granting the right
    // to rename a branch silently granted the right to set its prices.
    const pricing = apiRoutes.filter((r) => /\/prices/.test(r.path)
      && r.methods.some((m) => ['PUT', 'DELETE'].includes(m)));
    assert(pricing.length >= 2, `only ${pricing.length} price-writing routes found`);
    const codes = new Set(pricing.flatMap((r) => r.gates.map((g) => g.code)));
    assert(codes.size === 1 && codes.has('product_prices'),
      `written under: ${[...codes].join(', ')}`);
    return `${pricing.length} routes, all product_prices`;
  });

  await check('a staff roster needs the users permission', async () => {
    const staff = apiRoutes.find((r) => r.path === '/api/stores/:id/staff' && r.methods.includes('GET'));
    assert(staff, 'route not found');
    assert(staff.gates.some((g) => g.code === 'users'),
      'reading a branch\'s staff bypasses users:read');
  });

  await check('branch names stay readable without a permission', async () => {
    // The deliberate exception, and it must stay deliberate: a till cannot ring up a
    // sale without knowing which branches exist.
    const list = apiRoutes.find((r) => r.path === '/api/stores/' && r.methods.includes('GET'));
    assert(list, 'route not found');
    assert(list.gates.length === 0, `GET /stores is gated on ${list.gates.map((g) => g.code)}`);
  });

  await check('every permission has a description a shopkeeper can read', async () => {
    const bad = perms.filter((p) => !p.description || p.description.length < 10).map((p) => p.code);
    assert(bad.length === 0, `no usable description: ${bad.join(', ')}`);
    return `${perms.length} described`;
  });

  await check('the dead permissions are gone', async () => {
    assert(!known.has('pos_store_access'), 'pos_store_access still exists and still does nothing');
    assert(!known.has('notifications'), 'notifications still exists and still gates nothing');
    const orphans = await knex('user_permissions')
      .whereIn('permission_code', ['pos_store_access', 'notifications']).count('user_id as c').first();
    assert(Number(orphans.c) === 0, `${orphans.c} grants survive for removed permissions`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await knex.destroy();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
