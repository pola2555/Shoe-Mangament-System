import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { api } from './helpers.js';

/**
 * The world the user stories run in: a cast of people with different powers, two
 * branches, five kinds of product, and three kinds of customer.
 *
 * Everything here is **idempotent and reused across runs**. A store can never be
 * deleted and a product with stock can never be deleted, so a fixture that mints a new
 * one every run slowly fills the real catalogue with junk — which is exactly what
 * happened before, and it broke a barcode test that took whichever product came back
 * first.
 *
 * **Nothing here uploads an image.** `backend/.env` has `STORAGE_TYPE=s3` pointing at a
 * real bucket, so every upload from local dev is a live S3 write. The stories cover
 * everything else.
 */

const OUT = path.join(process.cwd(), 'e2e', '.stories');
const AUTH = path.join(process.cwd(), 'e2e', '.auth');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(AUTH, { recursive: true });

const PASSWORD = 'story-pass-1';

/**
 * The cast.
 *
 * Permissions come only from `user_permissions` rows — the role name buys nothing
 * except for `admin`, which bypasses every check. So each of these is an explicit list,
 * and the gaps in each list are the point: the cashier has no `sale_void` and no
 * `reports`, and that is what several stories are about.
 */
const CAST = {
  manager: {
    username: 'story_manager',
    full_name: 'Mona the Manager',
    role_id: 2,
    stores: ['A', 'B'],
    permissions: {
      stores: 'write', reports: 'read', dashboard_admin: 'read',
      inventory: 'write', products: 'write', product_variants: 'write',
      product_prices: 'write', product_categories: 'read', box_templates: 'write',
      pos: 'write', sales: 'write', sale_payments: 'write', sale_void: 'write',
      customers: 'write', customer_returns: 'write',
      transfers: 'write', transfer_actions: 'write',
      purchases: 'write', purchase_boxes: 'write', suppliers: 'write',
      supplier_payments: 'write', supplier_returns: 'write',
      expenses: 'write', expense_categories: 'write', loans: 'write',
      dealers: 'write', dealer_invoices: 'write', dealer_payments: 'write',
      barcodes: 'write', notifications: 'read', audit_log: 'read',
      // PLAN 3. A manager may price away from the default, answer discount requests,
      // run the till and count stock. Karim below gets NONE of these, which is what
      // makes the pair a real test of the feature rather than a description of it.
      price_override: 'write', discount_approval: 'write',
      shifts: 'write', cash_drawer: 'write', exchanges: 'write',
      stock_count: 'write', stock_intake: 'write',
    },
  },
  cashier: {
    username: 'story_cashier',
    full_name: 'Karim at the Till',
    role_id: 3,
    stores: ['A'],
    // Deliberately no sale_void, no reports, no expenses, no stores — and, from PLAN 3,
    // no price_override and no discount_approval. He can open and close the till he
    // stands at, and nothing more.
    permissions: {
      pos: 'write', sales: 'write', sale_payments: 'write',
      customers: 'write', inventory: 'read', products: 'read',
      barcodes: 'read', notifications: 'read', product_categories: 'read',
      shifts: 'write',
    },
  },
  stockkeeper: {
    username: 'story_stock',
    full_name: 'Samir in the Stockroom',
    role_id: 3,
    stores: ['B'],
    // Can move and receive stock, cannot sell it.
    permissions: {
      inventory: 'write', transfers: 'write', transfer_actions: 'write',
      purchases: 'write', purchase_boxes: 'write',
      products: 'write', product_variants: 'write', product_categories: 'read',
      suppliers: 'read', barcodes: 'write', box_templates: 'read',
      notifications: 'read',
    },
  },
  viewer: {
    username: 'story_viewer',
    full_name: 'Viviane who only looks',
    role_id: 3,
    stores: ['A'],
    permissions: {
      products: 'read', inventory: 'read', sales: 'read', customers: 'read',
      reports: 'read', expenses: 'read', stores: 'read', notifications: 'read',
    },
  },
  nostore: {
    username: 'story_nostore',
    full_name: 'Nabil with no branch',
    role_id: 3,
    stores: [],
    permissions: {
      pos: 'write', sales: 'write', customers: 'read',
      inventory: 'read', products: 'read', notifications: 'read',
    },
  },
};

/** Five product shapes, because the catalogue is not only shoes. */
const CATALOGUE = [
  { key: 'shoe', code: 'STORY-SHOE', name: 'Story Runner', brand: 'Storybrand',
    category: 'shoes', colors: ['Black', 'Black and White'], sizes: ['41', '42', '43'],
    price: 1200, min: 1000, max: 1500, cost: 700 },
  { key: 'sock', code: 'STORY-SOCK', name: 'Story Sock', brand: 'Storybrand',
    category: 'socks', colors: ['Grey'], sizes: ['KIDS', 'ADULTS'],
    price: 60, min: 50, max: 80, cost: 25 },
  { key: 'belt', code: 'STORY-BELT', name: 'Story Belt', brand: 'Storybrand',
    category: 'belts', colors: ['Brown'], sizes: ['90', '100'],
    price: 300, min: 250, max: 400, cost: 150 },
  { key: 'bag', code: 'STORY-BAG', name: 'Story Bag', brand: 'Storybrand',
    category: 'bags', colors: ['Navy'], sizes: null,
    price: 850, min: 700, max: 1000, cost: 400 },
  { key: 'tool', code: 'STORY-TOOL', name: 'Story Knife', brand: 'Storybrand',
    category: 'tools', colors: null, sizes: null,
    price: 200, min: 150, max: 260, cost: 90 },
];

setup('build the story world', async ({ browser }) => {
  setup.setTimeout(180_000);
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const world = { password: PASSWORD, stores: {}, users: {}, products: {}, customers: {} };

  // ---------------------------------------------------------------- branches
  const storeRes = await api(page, 'GET', '/stores');
  const stores = storeRes.body.data.filter((s) => s.is_active);
  expect(stores.length, 'the world needs at least one open branch').toBeGreaterThan(0);

  world.stores.A = { id: stores[0].id, name: stores[0].name };
  if (stores.length > 1) {
    world.stores.B = { id: stores[1].id, name: stores[1].name };
  } else {
    // A second branch is needed for transfers and for the scoping stories.
    const made = await api(page, 'POST', '/stores', { body: { name: 'Story Branch B' } });
    world.stores.B = { id: made.body.data.id, name: made.body.data.name };
  }

  // ---------------------------------------------------------------- the cast
  const existingUsers = (await api(page, 'GET', '/users')).body.data;
  for (const [key, spec] of Object.entries(CAST)) {
    let user = existingUsers.find((u) => u.username === spec.username);
    if (!user) {
      const made = await api(page, 'POST', '/users', {
        body: {
          username: spec.username,
          // Joi's email() checks the TLD against the IANA list, so `.local`, `.test`
          // and even `.example` are all rejected. Not worth working around — use a
          // TLD it accepts.
          email: `${spec.username}@story-fixtures.com`,
          password: PASSWORD,
          full_name: spec.full_name,
          role_id: spec.role_id,
          store_id: spec.stores.length ? world.stores[spec.stores[0]].id : null,
        },
      });
      expect(made.status, `create ${spec.username}: ${JSON.stringify(made.body)}`).toBe(201);
      user = made.body.data;
    } else {
      // Re-assert everything a previous run may have changed: the password (a story
      // resets one), the role, the home branch, and that the account is active (a
      // story deactivates one).
      const upd = await api(page, 'PUT', `/users/${user.id}`, {
        body: {
          password: PASSWORD,
          role_id: spec.role_id,
          is_active: true,
          store_id: spec.stores.length ? world.stores[spec.stores[0]].id : null,
        },
      });
      expect(upd.status, `reset ${spec.username}: ${JSON.stringify(upd.body)}`).toBe(200);
    }

    const perms = await api(page, 'PUT', `/users/${user.id}/permissions`, {
      body: {
        permissions: Object.entries(spec.permissions)
          .map(([permission_code, access_level]) => ({ permission_code, access_level })),
      },
    });
    expect(perms.status, `permissions for ${spec.username}: ${JSON.stringify(perms.body)}`).toBe(200);

    const storeIds = spec.stores.map((s) => world.stores[s].id);
    const st = await api(page, 'PUT', `/users/${user.id}/stores`, { body: { store_ids: storeIds } });
    expect(st.status, `stores for ${spec.username}`).toBe(200);

    world.users[key] = { id: user.id, username: spec.username, stores: storeIds };
  }

  // ---------------------------------------------------------------- catalogue
  const cats = (await api(page, 'GET', '/product-categories')).body.data;
  const products = (await api(page, 'GET', '/products')).body.data;

  for (const spec of CATALOGUE) {
    const category = cats.find((c) => c.code === spec.category);
    expect(category, `category ${spec.category} must exist`).toBeTruthy();

    let product = products.find((p) => p.product_code === spec.code);
    if (!product) {
      const made = await api(page, 'POST', '/products', {
        body: {
          product_code: spec.code, model_name: spec.name, brand: spec.brand,
          category_id: category.id,
          default_selling_price: spec.price,
          min_selling_price: spec.min,
          max_selling_price: spec.max,
          net_price: spec.cost,
        },
      });
      expect(made.status, `create ${spec.code}: ${JSON.stringify(made.body)}`).toBe(201);
      product = made.body.data;
    }

    // Colours. A colourless category gets its placeholder created server-side, so
    // asking for one here would be refused — which is itself a story.
    let colors = (await api(page, 'GET', `/products/${product.id}/colors`)).body.data;
    for (const name of spec.colors || []) {
      if (!colors.some((c) => c.color_name === name)) {
        await api(page, 'POST', `/products/${product.id}/colors`, { body: { color_name: name } });
      }
    }
    colors = (await api(page, 'GET', `/products/${product.id}/colors`)).body.data;

    // Variants, as one matrix call. Sizes null means the category has none and the
    // server resolves the one-size sentinel itself.
    const existing = (await api(page, 'GET', `/products/${product.id}/variants`)).body.data;
    const wanted = [];
    for (const color of colors) {
      for (const size of spec.sizes || [null]) {
        const already = existing.some((v) =>
          v.product_color_id === color.id && (size === null || v.size_eu === size));
        if (!already) wanted.push({ product_color_id: color.id, ...(size ? { size_eu: size } : {}) });
      }
    }
    if (wanted.length) {
      const made = await api(page, 'POST', `/products/${product.id}/variants/bulk`, {
        body: { variants: wanted },
      });
      expect(made.status, `variants for ${spec.code}: ${JSON.stringify(made.body)}`).toBe(201);
    }

    const variants = (await api(page, 'GET', `/products/${product.id}/variants`)).body.data;
    world.products[spec.key] = {
      id: product.id, code: spec.code, name: spec.name,
      category_id: category.id, category: spec.category,
      price: spec.price, min: spec.min, max: spec.max, cost: spec.cost,
      colors: colors.map((c) => ({ id: c.id, name: c.color_name, is_placeholder: c.is_placeholder })),
      variants: variants.map((v) => ({ id: v.id, size_eu: v.size_eu, sku: v.sku, color_id: v.product_color_id })),
    };

    // Stock in both branches, topped up rather than piled on: the stories consume it,
    // so a re-run must find the shelf full again without doubling it every time.
    for (const branch of ['A', 'B']) {
      const storeId = world.stores[branch].id;
      for (const v of variants) {
        const have = (await api(page, 'GET', '/inventory', {
          params: { store_id: storeId, variant_id: v.id, status: 'in_stock', limit: '50' },
        })).body.data.length;
        const want = 6;
        if (have < want) {
          await api(page, 'POST', '/inventory/manual', {
            body: { variant_id: v.id, store_id: storeId, cost: spec.cost, quantity: want - have,
              notes: 'story fixture' },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- customers
  const customers = (await api(page, 'GET', '/customers')).body.data;
  for (const [key, name, phone] of [
    ['regular', 'Rania Regular', '01000000101'],
    ['debtor', 'Dalia Debtor', '01000000102'],
    ['arabic', 'دنيا العربية', '01000000103'],
  ]) {
    let c = customers.find((x) => x.phone === phone);
    if (!c) {
      const made = await api(page, 'POST', '/customers', { body: { name, phone } });
      expect(made.status, `customer ${name}: ${JSON.stringify(made.body)}`).toBe(201);
      c = made.body.data;
    }
    world.customers[key] = { id: c.id, name: c.name, phone: c.phone };
  }

  // A supplier and a dealer, for the purchase and wholesale stories.
  const suppliers = (await api(page, 'GET', '/suppliers')).body.data;
  let supplier = suppliers.find((s) => s.name === 'Story Supplier');
  if (!supplier) {
    const made = await api(page, 'POST', '/suppliers', {
      body: { name: 'Story Supplier', phone: '01000000201' },
    });
    supplier = made.body.data;
  }
  world.supplier = { id: supplier.id, name: supplier.name };

  const dealers = (await api(page, 'GET', '/dealers')).body.data;
  let dealer = dealers.find((d) => d.name === 'Story Dealer');
  if (!dealer) {
    const made = await api(page, 'POST', '/dealers', {
      body: { name: 'Story Dealer', phone: '01000000202' },
    });
    if (made.status === 201) dealer = made.body.data;
  }
  if (dealer) world.dealer = { id: dealer.id, name: dealer.name };

  fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world, null, 2));
  await page.close();

  // ---------------------------------------------------------------- log each in
  // One login per user per run, saved as storage state. Logging in inside each test
  // would exhaust even the raised login limiter and make the suite's failures look
  // like missing data.
  for (const [key, u] of Object.entries(world.users)) {
    // An EXPLICITLY empty state. `browser.newContext()` inside a test picks up the
    // project's `use.storageState`, which is the admin — so /login redirected straight
    // to the dashboard and the form this was waiting for never existed.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const p = await ctx.newPage();
    await p.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
    // A fresh context has an empty HTTP cache, so the login chunk is fetched from
    // scratch. The default 15 s action timeout is not always enough for the first of
    // these, and the failure reads as "the login form does not exist".
    await p.waitForSelector('#username', { state: 'visible', timeout: 60_000 });
    await p.locator('#username').fill(u.username);
    await p.locator('#password').fill(PASSWORD);
    await p.locator('button[type="submit"]').click();
    await p.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 })
      .catch(async () => {
        const msg = await p.locator('body').innerText().catch(() => '');
        throw new Error(`${u.username} could not sign in: ${msg.slice(0, 200)}`);
      });
    await p.waitForFunction(() => !!localStorage.getItem('accessToken'), { timeout: 20_000 });
    await ctx.storageState({ path: path.join(AUTH, `${key}.json`) });
    await ctx.close();
  }

  console.log(`story world ready: ${Object.keys(world.users).length} users, ` +
    `${Object.keys(world.products).length} products, 2 branches`);
});
