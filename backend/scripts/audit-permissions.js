/**
 * PERMISSION AUDIT
 *
 * Answers three questions that cannot be answered by reading routes one at a time:
 *
 *   1. Does every write route have a gate, and is it the right one?
 *   2. Does any permission in the table gate nothing (dead), and does any route name a
 *      permission the table does not have (ungrantable — the `dashboard` bug)?
 *   3. Do two permissions overlap: two different codes gating the same resource, or one
 *      code gating two unrelated resources?
 *
 * It reads the MOUNTED Express app rather than the route files, so it describes what
 * actually runs. `permission()` is monkey-patched before the routes load so each gate
 * carries the code and level it was built with.
 *
 *   node scripts/audit-permissions.js          human-readable report
 *   node scripts/audit-permissions.js --json   machine-readable
 */
require('dotenv').config();
// app.js calls listen() on import; move it off the port the dev server holds.
process.env.PORT = process.env.AUDIT_PORT || '5099';

const path = require('path');

// ---------------------------------------------------------------- instrumentation
// Must happen BEFORE app.js pulls the routes in, or the gates are already built.
const permissionPath = require.resolve('../src/middleware/permission');
const realPermission = require(permissionPath);
require.cache[permissionPath].exports = function taggedPermission(code, level = 'read') {
  const mw = realPermission(code, level);
  mw._gate = { code, level };
  return mw;
};

const authPath = require.resolve('../src/middleware/auth');
const realAuth = require(authPath);
realAuth._isAuth = true;

const app = require('../src/app');
const db = require('../src/config/database');

// ---------------------------------------------------------------- route walking
const routes = [];

function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => m !== '_all')
        .map((m) => m.toUpperCase());
      const gates = [];
      let hasAuth = false;
      for (const h of layer.route.stack) {
        if (h.handle?._gate) gates.push(h.handle._gate);
        if (h.handle === realAuth || h.handle?._isAuth) hasAuth = true;
      }
      routes.push({
        methods,
        path: prefix + fromRegex(layer.regexp, layer.route.path),
        gates,
        hasAuth,
      });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + fromRegex(layer.regexp, ''));
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, prefix);
    }
  }
}

/** Express keeps mount paths only as regexes; recover the literal prefix. */
function fromRegex(re, fallback) {
  if (fallback) return fallback;
  if (!re) return '';
  const src = re.source;
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  const m = src
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '');
  return m.startsWith('/') ? m : '';
}

// Router-level middleware (`router.use(auth)`) does not appear on the route layer, so
// a route inside such a router looks unauthenticated. Recover it by checking whether
// the parent router applied auth to everything under it.
function markRouterLevelAuth(stack, prefix, inherited) {
  for (const layer of stack) {
    if (layer.route) {
      const r = routes.find((x) => x.path === prefix + layer.route.path
        && x.methods.includes(Object.keys(layer.route.methods)[0].toUpperCase()));
      if (r && inherited) r.hasAuth = true;
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const childPrefix = prefix + fromRegex(layer.regexp, '');
      const appliesAuth = layer.handle.stack.some(
        (l) => !l.route && (l.handle === realAuth || l.handle?._isAuth)
      );
      const appliesGate = layer.handle.stack
        .filter((l) => !l.route && l.handle?._gate)
        .map((l) => l.handle._gate);
      if (appliesGate.length) {
        for (const r of routes) {
          if (r.path.startsWith(childPrefix)) r.gates.push(...appliesGate);
        }
      }
      markRouterLevelAuth(layer.handle.stack, childPrefix, inherited || appliesAuth);
    }
  }
}

walk(app._router.stack, '');
markRouterLevelAuth(app._router.stack, '', false);

const apiRoutes = routes
  .filter((r) => r.path.startsWith('/api/'))
  .filter((r) => !/\/api\/health/.test(r.path));

// ---------------------------------------------------------------- the audit
(async () => {
  const perms = await db('permissions').select('code', 'category', 'description').orderBy('code');
  const known = new Set(perms.map((p) => p.code));
  const grantCounts = await db('user_permissions')
    .select('permission_code').count('user_id as c').groupBy('permission_code');
  const granted = new Map(grantCounts.map((r) => [r.permission_code, Number(r.c)]));

  const findings = [];
  const usedCodes = new Map(); // code -> [routes]

  for (const r of apiRoutes) {
    const codes = [...new Set(r.gates.map((g) => g.code))];
    for (const g of r.gates) {
      if (!usedCodes.has(g.code)) usedCodes.set(g.code, []);
      usedCodes.get(g.code).push(`${r.methods.join('|')} ${r.path} (${g.level})`);
    }

    const isWrite = r.methods.some((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m));
    const isPublic = /\/api\/auth\/(login|refresh)/.test(r.path);

    if (!r.hasAuth && !isPublic) {
      findings.push({ kind: 'no-auth', route: `${r.methods.join('|')} ${r.path}`,
        note: 'reachable without a token' });
    }
    if (r.hasAuth && codes.length === 0 && !isPublic) {
      findings.push({ kind: isWrite ? 'no-gate-write' : 'no-gate-read',
        route: `${r.methods.join('|')} ${r.path}`,
        note: 'any logged-in user can call this' });
    }
    for (const c of codes) {
      if (!known.has(c)) {
        findings.push({ kind: 'unknown-code', route: `${r.methods.join('|')} ${r.path}`,
          note: `gate names '${c}', which is not in the permissions table — ungrantable` });
      }
    }
    if (codes.length > 1) {
      findings.push({ kind: 'multi-gate', route: `${r.methods.join('|')} ${r.path}`,
        note: `needs all of: ${codes.join(' + ')}` });
    }
    // A write route gated at 'read' level lets a read-only user change data.
    for (const g of r.gates) {
      if (isWrite && g.level === 'read') {
        findings.push({ kind: 'write-gated-read', route: `${r.methods.join('|')} ${r.path}`,
          note: `'${g.code}' checked at read level on a write route` });
      }
    }
  }

  const dead = perms.filter((p) => !usedCodes.has(p.code));

  // Overlap: one resource prefix reachable through two different codes.
  const byPrefix = new Map();
  for (const r of apiRoutes) {
    const prefix = r.path.split('/').slice(0, 3).join('/');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
    r.gates.forEach((g) => byPrefix.get(prefix).add(g.code));
  }

  const out = {
    routeCount: apiRoutes.length,
    permissionCount: perms.length,
    findings,
    dead: dead.map((p) => ({ code: p.code, category: p.category, grants: granted.get(p.code) || 0 })),
    byPrefix: [...byPrefix.entries()].map(([p, s]) => ({ prefix: p, codes: [...s] })),
    usedCodes: [...usedCodes.entries()].map(([c, rs]) => ({ code: c, routes: rs })),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
    await db.destroy();
    return;
  }

  console.log(`Routes: ${out.routeCount}   Permissions: ${out.permissionCount}\n`);

  const groups = {};
  findings.forEach((f) => { (groups[f.kind] ||= []).push(f); });
  for (const [kind, list] of Object.entries(groups)) {
    console.log(`### ${kind} (${list.length})`);
    list.forEach((f) => console.log(`   ${f.route}\n      ${f.note}`));
    console.log();
  }

  console.log(`### permissions no route checks (${dead.length})`);
  dead.forEach((p) => console.log(`   ${p.code}  [${p.category}]  granted to ${p.grants} user(s)`));
  console.log();

  console.log('### codes per resource prefix');
  out.byPrefix
    .filter((b) => b.codes.length > 1)
    .forEach((b) => console.log(`   ${b.prefix}: ${b.codes.join(', ')}`));

  await db.destroy();
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
