import { test, expect } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage } from './world.js';

/**
 * WHO CAN DO WHAT — five people, one system, and the lines between them.
 *
 * Permissions in this system come only from `user_permissions` rows; the role name
 * buys nothing except for `admin`, which bypasses every check. So a "store manager"
 * with no rows can do less than a cashier, and the only way to know what any of them
 * can actually do is to try it.
 *
 * Two separate questions run through these, and they fail differently:
 *
 *   **Permission** — may this person do this kind of thing at all?
 *   **Scope**      — may they do it to THIS branch's data?
 *
 * The second is the one that leaks quietly: a 200 with somebody else's numbers in it
 * looks exactly like a 200 with your own.
 */

const world = loadWorld();

test.describe.configure({ mode: 'serial' });

const A = () => world.stores.A.id;
const B = () => world.stores.B.id;

// ─────────────────────────────────────────────── permission

test('P1 · the cashier can sell and can do nothing else', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');

  const allowed = [
    ['GET', '/inventory', 200],
    ['GET', '/products', 200],
    ['GET', '/customers', 200],
    ['GET', '/sales', 200],
    ['GET', '/stores', 200],           // reference data — the till cannot open without it
    ['GET', '/inventory/facets', 200],
    ['GET', '/inventory/product-grid', 200],
  ];
  for (const [method, path, status] of allowed) {
    const res = await api(page, method, path, { params: { limit: '2' } });
    expect(res.status, `${method} ${path} should be allowed`).toBe(status);
  }

  const forbidden = [
    ['GET', '/reports/dashboard', 'the money'],
    ['GET', '/reports/comparison', 'the money'],
    ['GET', '/stores/comparison', 'the money'],
    ['GET', `/stores/${A()}/overview`, "a branch's takings"],
    ['GET', '/expenses', 'what the shop spends'],
    ['GET', '/users', 'other people'],
    ['GET', '/audit-log', 'the audit trail'],
    ['GET', '/loans', 'lending'],
    ['GET', '/purchases/invoices', 'buying'],
    ['GET', '/transfers', 'moving stock'],
  ];
  for (const [method, path, what] of forbidden) {
    const res = await api(page, method, path);
    expect(res.status, `a cashier must not reach ${what} (${path})`).toBe(403);
  }
  await closePage(page);
});

test('P2 · asking for figures without permission gets names, not a broken page', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');

  // The till asks for the branch list. Asking for stats too must not turn that into a
  // 403 and take the whole page down with it — the names come back, the money does not.
  const res = await api(page, 'GET', '/stores', { params: { include_stats: '1' } });
  expect(res.status).toBe(200);
  expect(res.body.data.length).toBeGreaterThan(0);
  for (const store of res.body.data) {
    expect(store.name, 'names are reference data').toBeTruthy();
    expect(store.stats, 'figures are not').toBeUndefined();
  }
  await closePage(page);
});

test('P3 · the stockkeeper moves goods and never touches the till', async ({ browser }) => {
  const page = await pageAs(browser, 'stockkeeper');
  await page.goto('/');

  expect((await api(page, 'GET', '/inventory')).status).toBe(200);
  expect((await api(page, 'GET', '/transfers')).status).toBe(200);
  expect((await api(page, 'GET', '/purchases/invoices')).status).toBe(200);

  // No selling, no money.
  expect((await api(page, 'GET', '/sales')).status).toBe(403);
  expect((await api(page, 'GET', '/expenses')).status).toBe(403);
  expect((await api(page, 'GET', '/reports/dashboard')).status).toBe(403);

  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: B(), items: [], payments: [] },
  });
  expect(sale.status, 'a stockkeeper must not be able to ring a sale').toBe(403);
  await closePage(page);
});

test('P4 · the viewer can read every screen she is given and write to none of them', async ({ browser }) => {
  const page = await pageAs(browser, 'viewer');
  await page.goto('/');

  for (const path of ['/products', '/inventory', '/sales', '/customers', '/expenses', '/stores']) {
    expect((await api(page, 'GET', path, { params: { limit: '2' } })).status, `reading ${path}`).toBe(200);
  }

  const writes = [
    ['POST', '/customers', { name: 'Nope', phone: '01000009999' }],
    ['POST', '/products', { product_code: 'NOPE', model_name: 'x', category_id: world.products.shoe.category_id }],
    ['POST', '/expenses', { store_id: A(), amount: 1, expense_date: '2026-09-01' }],
    ['POST', '/stores', { name: 'Nope Branch' }],
    ['PUT', `/stores/${A()}`, { name: 'Renamed' }],
    ['POST', '/inventory/manual', { variant_id: world.products.shoe.variants[0].id, store_id: A(), cost: 1, quantity: 1 }],
  ];
  for (const [method, path, body] of writes) {
    const res = await api(page, method, path, { body });
    expect(res.status, `${method} ${path} must be refused`).toBe(403);
    expect(String(res.body.message)).toMatch(/read-only|denied/i);
  }

  // And the branch is still called what it was called.
  expect((await api(page, 'GET', `/stores/${A()}`)).body.data.name).toBe(world.stores.A.name);
  await closePage(page);
});

test('P5 · somebody with no branch is told so, rather than shown an empty shop', async ({ browser }) => {
  const page = await pageAs(browser, 'nostore');
  await page.goto('/pos');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  await shot(page, 'story-no-branch');

  // Scoped to nothing: every list is empty rather than everything.
  const inv = await api(page, 'GET', '/inventory', { params: { limit: '50' } });
  expect(inv.status).toBe(200);
  expect(inv.body.data.length, 'a user with no branch must see no stock, not all of it').toBe(0);

  const sales = await api(page, 'GET', '/sales');
  expect(sales.body.data.length).toBe(0);

  // Asking for a branch by name is refused outright.
  const named = await api(page, 'GET', '/inventory', { params: { store_id: A(), limit: '5' } });
  expect(named.status, 'naming a branch they are not in must be refused').toBe(403);

  // And they cannot sell into one either.
  const sale = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [], payments: [] },
  });
  expect(sale.status).toBeGreaterThanOrEqual(400);
  await closePage(page);
});

// ─────────────────────────────────────────────── scope

test('P6 · the cashier sees his branch and only his branch', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');

  // Unfiltered reads are scoped to him without him asking.
  const inv = await api(page, 'GET', '/inventory', { params: { limit: '300' } });
  expect(inv.status).toBe(200);
  expect(inv.body.data.length).toBeGreaterThan(0);
  for (const row of inv.body.data) {
    expect(row.store_id, 'stock from a branch he is not in leaked into his list').toBe(A());
  }

  // Naming the other branch is refused, not silently honoured and not silently ignored.
  const other = await api(page, 'GET', '/inventory', { params: { store_id: B(), limit: '5' } });
  expect(other.status, 'asking for branch B must be refused').toBe(403);
  expect(String(other.body.message)).toMatch(/not assigned|denied/i);

  // Including through the facets and the grid, which are newer and easy to forget.
  expect((await api(page, 'GET', '/inventory/facets', { params: { store_id: B() } })).status).toBe(403);
  expect((await api(page, 'GET', '/inventory/product-grid', { params: { store_id: B() } })).status).toBe(403);
  await closePage(page);
});

test('P7 · the stockkeeper is scoped to the other branch, symmetrically', async ({ browser }) => {
  const page = await pageAs(browser, 'stockkeeper');
  await page.goto('/');

  const inv = await api(page, 'GET', '/inventory', { params: { limit: '300' } });
  for (const row of inv.body.data) {
    expect(row.store_id, 'branch A stock leaked to a branch B user').toBe(B());
  }
  expect((await api(page, 'GET', '/inventory', { params: { store_id: A(), limit: '5' } })).status).toBe(403);
  await closePage(page);
});

test('P8 · a manager in two branches sees both, and nothing beyond them', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const inv = await api(page, 'GET', '/inventory', { params: { limit: '500' } });
  const branches = new Set(inv.body.data.map((r) => r.store_id));
  expect([...branches].every((id) => [A(), B()].includes(id)),
    'a two-branch manager must see exactly those two').toBe(true);

  // Both named branches are allowed.
  expect((await api(page, 'GET', '/inventory', { params: { store_id: A(), limit: '2' } })).status).toBe(200);
  expect((await api(page, 'GET', '/inventory', { params: { store_id: B(), limit: '2' } })).status).toBe(200);
  await closePage(page);
});

test('P9 · a report cannot be pointed at a branch you are not in', async ({ browser }) => {
  const page = await pageAs(browser, 'stockkeeper');
  await page.goto('/');
  // No reports permission at all, so this is refused twice over — but the message
  // must be about permission, and the data must not come back either way.
  const res = await api(page, 'GET', '/reports/dashboard', { params: { store_id: A() } });
  expect(res.status).toBe(403);
  expect(res.body.data).toBeUndefined();
  await closePage(page);
});

// ─────────────────────────────────────────────── escalation

test('P10 · nobody can promote themselves by resetting the admin password', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  // The admin's own session, to find the account id. `api()` runs fetch inside the
  // page, so the page has to be on the app's origin first — a fresh tab is about:blank
  // and reading localStorage there is a SecurityError.
  const adminPage = await pageAs(browser, 'admin');
  await adminPage.goto('/');
  const admin = (await api(adminPage, 'GET', '/users')).body.data.find((u) => u.username === 'admin');
  await closePage(adminPage);
  expect(admin, 'the admin account must exist for this to mean anything').toBeTruthy();

  // Mona has no users:write at all, which is the first line of defence.
  const reset = await api(page, 'PUT', `/users/${admin.id}`, { body: { password: 'hijacked-123' } });
  expect(reset.status, 'a manager must not be able to reset the admin password').toBe(403);

  // The admin can still sign in with the real password afterwards.
  const ctx = await page.context().browser().newContext({ storageState: { cookies: [], origins: [] } });
  const check = await ctx.newPage();
  await check.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
  await check.waitForSelector('#username', { state: 'visible', timeout: 60_000 });
  await check.locator('#username').fill('admin');
  await check.locator('#password').fill('admin123');
  await check.locator('button[type="submit"]').click();
  await check.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  await ctx.close();
  await closePage(page);
});

test('P11 · assigning staff to a branch needs the power to change what people see', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  // Mona can rename her branch — she has stores:write.
  const rename = await api(page, 'PUT', `/stores/${A()}`, { body: { name: world.stores.A.name } });
  expect(rename.status, 'a manager may edit her own branch').toBe(200);

  // But she cannot let anybody into it, because that hands over its takings.
  const assign = await api(page, 'PUT', `/stores/${A()}/staff`, {
    body: { user_ids: [world.users.cashier.id, world.users.nostore.id] },
  });
  expect(assign.status, 'assigning staff needs users:write, not stores:write').toBe(403);

  // And the branch's staff list is unchanged.
  const staff = await api(page, 'GET', `/stores/${A()}/staff`);
  expect(staff.status).toBe(200);
  expect(staff.body.data.some((u) => u.id === world.users.nostore.id && u.assigned),
    'nobody was let in').toBe(false);
  await closePage(page);
});

test('P12 · the sidebar shows each person only what they can actually open', async ({ browser }) => {
  // What is on screen and what the server allows have to be the same list. A menu
  // entry that 403s is worse than no entry.
  const expectations = [
    ['cashier', ['POS', 'Sales History', 'Customers'], ['Expenses', 'Reports', 'Users', 'Purchases']],
    ['stockkeeper', ['Inventory', 'Transfers', 'Purchases'], ['POS', 'Sales History', 'Expenses', 'Reports']],
    ['viewer', ['Products', 'Inventory', 'Reports'], ['Users', 'Purchases', 'Transfers']],
  ];

  for (const [who, shown, hidden] of expectations) {
    const page = await pageAs(browser, who);
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('.sidebar, nav').first()).toBeVisible({ timeout: 25_000 });

    for (const label of shown) {
      await expect(page.getByRole('link', { name: label, exact: true }),
        `${who} should see ${label}`).toHaveCount(1);
    }
    for (const label of hidden) {
      await expect(page.getByRole('link', { name: label, exact: true }),
        `${who} should not see ${label}`).toHaveCount(0);
    }
    await shot(page, `story-sidebar-${who}`);
    await closePage(page);
  }
});
