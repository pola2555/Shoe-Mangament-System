/**
 * THE PRINT QUEUE, ATTACKED RATHER THAN DESCRIBED.
 *
 * THE LOAD-BEARING CHECK is "answering the prompt twice does not print twice".
 *
 * Everything else in this feature is a convenience. That one is the failure that costs
 * real money and real paper: the dialog that offers to queue labels after receiving
 * stock can be answered again by a page reload, a re-opened box, or two people at two
 * tills, and a queue that simply added each time would send 120 labels to the printer
 * for a 60-pair box. So a document REPLACES its own pending rows, and this suite proves
 * it by queueing the same box three times and asserting the total never moves — while
 * a SECOND, different box for the same shoe does sum, because that really is more
 * stock.
 *
 * THE SECOND LOAD-BEARING CHECK is that the queue is not a way around store scoping. A
 * queue row names a product, a branch and a quantity, which together say what another
 * branch just received. So it is scoped like every other stock document: another
 * branch's row is a 404, and naming another branch is a 403.
 *
 * Permissions are exercised over real HTTP as four different people, because hiding a
 * button protects nothing — a client talks to the API directly.
 *
 * Nothing here uploads an image: local dev writes to a real S3 bucket.
 */

process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();

// Its own port and its own limits, so the suite never depends on — or exhausts — the
// dev server the user has running on 5000.
process.env.PORT = process.env.PQ_PORT || '5097';
process.env.API_RATE_MAX = process.env.API_RATE_MAX || '100000';
process.env.LOGIN_RATE_MAX = process.env.LOGIN_RATE_MAX || '10000';

const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const bcrypt = require('bcryptjs');
const queue = require('../src/modules/print-queue/print-queue.service');
const purchases = require('../src/modules/purchases/purchases.service');
const intakes = require('../src/modules/stock-intakes/stock-intakes.service');

require('../src/app');   // binds the listener on PORT
const BASE = `http://localhost:${process.env.PORT}/api`;

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

/** Today, as the SHOP reckons it — not as UTC does. See the note in check-intake.js. */
function businessToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

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
  assert(r.status === 200, `login ${username} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.accessToken || r.body.data.access_token || r.body.data.token;
}

/** Create-or-reset a scratch user with exactly these permissions and branches. */
async function scratchUser({ username, permissions, storeIds, level = 'write' }) {
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
      store_id: storeIds[0] || null,
      is_active: true,
    }).returning('*');
  } else {
    await knex('users').where('id', user.id).update({
      password_hash: hash, is_active: true, store_id: storeIds[0] || null, hidden_pages: '[]',
    });
  }
  await knex('user_permissions').where('user_id', user.id).del();
  if (permissions.length) {
    await knex('user_permissions').insert(
      permissions.map((p) => ({ user_id: user.id, permission_code: p, access_level: level }))
    );
  }
  await knex('user_stores').where('user_id', user.id).del();
  if (storeIds.length) {
    await knex('user_stores').insert(storeIds.map((s) => ({ user_id: user.id, store_id: s })));
  }
  return { ...user, password };
}

const ADMIN_SCOPE = {};                 // sees everything
const sum = (rows) => rows.reduce((n, r) => n + Number(r.quantity), 0);

async function main() {
  const adminUser = await knex('users').where('username', 'admin').first();
  assert(adminUser, 'no admin user');

  const today = businessToday();

  // ---- the world, reused between runs -------------------------------------
  async function ensureStore(name) {
    let s = await knex('stores').where('name', name).first();
    if (!s) [s] = await knex('stores').insert({ name, is_active: true }).returning('*');
    else if (!s.is_active) await knex('stores').where('id', s.id).update({ is_active: true });
    return s;
  }
  const storeA = await ensureStore('CHK printq branch A');
  const storeB = await ensureStore('CHK printq branch B');

  let supplier = await knex('suppliers').where('name', 'CHK printq supplier').first();
  if (!supplier) {
    [supplier] = await knex('suppliers').insert({ name: 'CHK printq supplier' }).returning('*');
  }

  const category = await knex('product_categories').where('code', 'shoes').first()
    || await knex('product_categories').first();

  const CODE = 'CHK-PQ-1';
  let product = await knex('products').where('product_code', CODE).first();
  if (!product) {
    [product] = await knex('products').insert({
      product_code: CODE, brand: 'CHKPQ', model_name: 'Print Queue Test Shoe',
      category_id: category.id, default_selling_price: 700,
      min_selling_price: 0, max_selling_price: 100000, is_active: true,
    }).returning('*');
  }
  let color = await knex('product_colors').where({ product_id: product.id, color_name: 'Black' }).first();
  if (!color) {
    [color] = await knex('product_colors')
      .insert({ product_id: product.id, color_name: 'Black' }).returning('*');
  }

  /**
   * Wipe everything this suite has ever made. Run at the START as well as the end: the
   * assertions here are exact ("the total never moves off 5"), and a crashed earlier run
   * that left stock behind turns a real pass into a confusing failure about a number
   * that was right.
   */
  async function resetWorld() {
    const variantIds = await knex('product_variants').where('product_id', product.id).pluck('id');
    if (variantIds.length) {
      await knex('print_queue_items').whereIn('variant_id', variantIds).del();

      // A pair may have been SOLD since the last run — the browser suite picks products
      // out of the catalogue and this one is in it — and sale_items references
      // inventory_items with RESTRICT. So the sale goes first, or the delete below
      // fails with a foreign-key error that reads like a bug in the queue.
      const itemIds = await knex('inventory_items').whereIn('variant_id', variantIds).pluck('id');
      if (itemIds.length) {
        const lineIds = await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('id');
        if (lineIds.length) {
          await knex('customer_return_items').whereIn('sale_item_id', lineIds).del();
        }
        const saleIds = [...new Set(await knex('sale_items').whereIn('inventory_item_id', itemIds).pluck('sale_id'))];
        if (saleIds.length) {
          await knex('sale_items').whereIn('sale_id', saleIds).del();
          await knex('sale_payments').whereIn('sale_id', saleIds).del();
          await knex('exchanges').whereIn('new_sale_id', saleIds).del().catch(() => {});
          await knex('sales').whereIn('id', saleIds).del();
        }
        await knex('cost_corrections').whereIn('inventory_item_id', itemIds).del().catch(() => {});
        await knex('inventory_items').whereIn('id', itemIds).del();
      }
    }
    await knex('print_queue_items').whereIn('store_id', [storeA.id, storeB.id]).del();

    const sheetIds = await knex('stock_intakes').whereIn('store_id', [storeA.id, storeB.id]).pluck('id');
    if (sheetIds.length) {
      await knex('inventory_items').whereIn('intake_id', sheetIds).del();
      await knex('stock_intake_lines').whereIn('intake_id', sheetIds).del();
      await knex('stock_intakes').whereIn('id', sheetIds).del();
    }

    const invIds = await knex('purchase_invoices').where('supplier_id', supplier.id).pluck('id');
    if (invIds.length) {
      const boxIds = await knex('purchase_invoice_boxes').whereIn('invoice_id', invIds).pluck('id');
      if (boxIds.length) {
        await knex('inventory_items').whereIn('invoice_box_id', boxIds).del();
        await knex('box_items').whereIn('invoice_box_id', boxIds).del();
        await knex('purchase_invoice_boxes').whereIn('id', boxIds).del();
      }
      await knex('supplier_payment_allocations').whereIn('invoice_id', invIds).del();
      await knex('purchase_invoices').whereIn('id', invIds).del();
    }
  }
  await resetWorld();

  // ---- two documents that put stock on two shelves -------------------------
  async function receiveBox({ store, items, cost = 400 }) {
    const total = items.reduce((n, i) => n + i.quantity, 0);
    const invoice = await purchases.createInvoice({
      supplier_id: supplier.id, total_amount: total * cost, invoice_date: today,
      boxes: [{ product_id: product.id, cost_per_item: cost, total_items: total, destination_store_id: store.id }],
    }, adminUser.id);
    const box = (await knex('purchase_invoice_boxes').where('invoice_id', invoice.id))[0];
    await purchases.setBoxItems(box.id, items.map((i) => ({
      product_color_id: color.id, size_eu: i.size, quantity: i.quantity,
    })));
    await purchases.completeBox(box.id);
    return box;
  }

  const boxA = await receiveBox({ store: storeA, items: [{ size: '41', quantity: 3 }, { size: '42', quantity: 2 }] });

  const sheet = await intakes.create({
    store_id: storeB.id, supplier_id: supplier.id, reason: 'opening', intake_date: today,
    lines: [{ product_id: product.id, product_color_id: color.id, size_eu: '41', quantity: 4, unit_cost: 350 }],
  }, adminUser.id);
  await intakes.post(sheet.id, adminUser.id);

  console.log('');
  console.log('what a document created:');

  await check('a purchase box offers exactly the pairs it put on the shelf', async () => {
    const p = await queue.sourceLines({ source_type: 'purchase_box', source_id: boxA.id, ...ADMIN_SCOPE });
    assert(p.store_id === storeA.id, 'the branch is not the box destination');
    assert(p.rows.length === 2, `${p.rows.length} sizes, expected 2`);
    const byQty = Object.fromEntries(p.rows.map((r) => [r.size_eu, r.created_qty]));
    assert(byQty['41'] === 3 && byQty['42'] === 2, `quantities ${JSON.stringify(byQty)}`);
    assert(p.rows.every((r) => r.barcode), 'a row came back with no barcode to print');
    return `${p.source_ref}, 41x3 + 42x2`;
  });

  await check('a stock intake offers its pairs, at its own branch', async () => {
    const p = await queue.sourceLines({ source_type: 'stock_intake', source_id: sheet.id, ...ADMIN_SCOPE });
    assert(p.store_id === storeB.id, 'the branch is not the sheet branch');
    assert(p.rows.length === 1 && p.rows[0].created_qty === 4, JSON.stringify(p.rows.map((r) => r.created_qty)));
    return `${p.source_ref}, 41x4`;
  });

  console.log('');
  console.log('THE LOAD-BEARING ONE — answering the prompt twice must not print twice:');

  await check('queueing a box puts one label on the queue per pair', async () => {
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxA.id }, adminUser.id, ADMIN_SCOPE);
    const rows = await queue.list({ store_id: storeA.id });
    assert(rows.length === 2, `${rows.length} rows`);
    assert(sum(rows) === 5, `${sum(rows)} labels, expected 5`);
    return '5 labels across 2 sizes';
  });

  await check('queueing the SAME box twice more leaves 5, not 15', async () => {
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxA.id }, adminUser.id, ADMIN_SCOPE);
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxA.id }, adminUser.id, ADMIN_SCOPE);
    const rows = await queue.list({ store_id: storeA.id });
    assert(rows.length === 2, `${rows.length} rows after three adds`);
    assert(sum(rows) === 5, `${sum(rows)} labels after three adds, expected 5`);
    return 'three adds, still 5';
  });

  let boxB;
  await check('a SECOND box of the same shoe does add — that really is more stock', async () => {
    boxB = await receiveBox({ store: storeA, items: [{ size: '41', quantity: 2 }] });
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxB.id }, adminUser.id, ADMIN_SCOPE);
    const rows = await queue.list({ store_id: storeA.id });
    assert(sum(rows) === 7, `${sum(rows)} labels, expected 7`);
    const fortyOnes = rows.filter((r) => r.size_eu === '41');
    assert(fortyOnes.length === 2, `size 41 is in ${fortyOnes.length} row(s), expected 2 — one per document`);
    return '5 + 2 = 7, and size 41 is two rows, one per invoice';
  });

  await check('a hand-made add cannot queue labels the document never created', async () => {
    const other = await knex('product_variants').where('product_id', product.id).whereNot('size_eu', '41').first();
    const before = sum(await queue.list({ store_id: storeA.id }));
    await queue.addFromSource({
      source_type: 'purchase_box', source_id: boxB.id,
      items: [{ variant_id: other.id, quantity: 99 }],
    }, adminUser.id, ADMIN_SCOPE).catch(() => null);
    const after = await queue.list({ store_id: storeA.id });
    const rogue = after.find((r) => r.variant_id === other.id && r.source_id === boxB.id);
    assert(!rogue, 'a variant the box never created got onto the queue');
    return `filtered out; total ${before} -> ${sum(after)}`;
  });

  console.log('');
  console.log('adding by hand:');

  let manualRow;
  await check('a manual add SUMS — pressing add twice asks for more labels', async () => {
    const v41 = (await knex('product_variants').where({ product_id: product.id, size_eu: '41' }).first());
    await queue.add({ store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 3 }] }, adminUser.id);
    await queue.add({ store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 2 }] }, adminUser.id);
    const rows = await queue.list({ store_id: storeA.id });
    const manual = rows.filter((r) => r.source_type === 'manual');
    assert(manual.length === 1, `${manual.length} manual rows, expected them to merge into 1`);
    assert(manual[0].quantity === 5, `manual quantity ${manual[0].quantity}, expected 5`);
    manualRow = manual[0];
    // And the document rows are untouched by it.
    assert(sum(rows) === 12, `${sum(rows)} total, expected 7 + 5`);
    return '3 + 2 = 5 in one row; the invoice rows unchanged';
  });

  await check('naming the same variant twice in one request is collapsed, not rejected', async () => {
    const v42 = await knex('product_variants').where({ product_id: product.id, size_eu: '42' }).first();
    const rows = await queue.add({
      store_id: storeA.id,
      items: [{ variant_id: v42.id, quantity: 1 }, { variant_id: v42.id, quantity: 2 }],
    }, adminUser.id);
    assert(rows.length === 1, `${rows.length} rows`);
    assert(Number(rows[0].quantity) === 3, `quantity ${rows[0].quantity}, expected 3`);
    await knex('print_queue_items').where('id', rows[0].id).del();
    return '1 + 2 = 3';
  });

  await check('queueing nothing at all is refused, not silently ignored', async () => {
    const v41 = await knex('product_variants').where({ product_id: product.id, size_eu: '41' }).first();
    let msg = null;
    try {
      await queue.add({ store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 0 }] }, adminUser.id);
    } catch (e) { msg = e.message; }
    assert(msg, 'a request for zero labels was accepted');
    return msg;
  });

  console.log('');
  console.log('what goes to the printer:');

  await check('copies are the labels OWED, summed across every row for that size', async () => {
    const rows = await queue.list({ store_id: storeA.id });
    const ids = rows.map((r) => r.id);
    const labels = await queue.labels({ ids, store_id: storeA.id });
    const by = Object.fromEntries(labels.map((l) => [l.size_eu, l.copies]));
    // size 41: 3 (box A) + 2 (box B) + 5 (manual) = 10. size 42: 2 (box A).
    assert(by['41'] === 10, `size 41 copies ${by['41']}, expected 10`);
    assert(by['42'] === 2, `size 42 copies ${by['42']}, expected 2`);
    const l41 = labels.find((l) => l.size_eu === '41');
    assert(l41.queue_ids.length === 3, `${l41.queue_ids.length} queue rows named, expected 3`);
    assert(l41.barcode && l41.price_code, 'the label payload is missing barcode or price code');
    return '41 -> 10 copies from 3 rows, 42 -> 2';
  });

  await check('a selection of one row asks for only that row', async () => {
    const labels = await queue.labels({ ids: [manualRow.id], store_id: storeA.id });
    assert(labels.length === 1 && labels[0].copies === 5, JSON.stringify(labels.map((l) => l.copies)));
    return '5';
  });

  console.log('');
  console.log('printing, and a roll that runs out:');

  await check('a partial print leaves the remainder on the queue', async () => {
    const res = await queue.markPrinted([{ id: manualRow.id, quantity: 2 }], adminUser.id, { store_id: storeA.id });
    assert(res.labels === 2, `${res.labels} labels recorded`);
    const row = await queue.getById(manualRow.id, { store_id: storeA.id });
    assert(row.status === 'pending', `status ${row.status}`);
    assert(row.printed_qty === 2 && row.remaining === 3, `${row.printed_qty}/${row.quantity}`);
    return '2 of 5 printed, 3 still owed';
  });

  await check('finishing it moves the row off the queue', async () => {
    await queue.markPrinted([{ id: manualRow.id }], adminUser.id, { store_id: storeA.id });
    const row = await queue.getById(manualRow.id, { store_id: storeA.id });
    assert(row.status === 'done', `status ${row.status}`);
    assert(row.printed_qty === 5 && row.completed_at, 'printed count or completion time missing');
    const pending = await queue.list({ store_id: storeA.id });
    assert(!pending.some((r) => r.id === manualRow.id), 'a finished row is still on the pending list');
    return '5 of 5, completed';
  });

  await check('marking a finished row again does nothing — it cannot print itself twice', async () => {
    const res = await queue.markPrinted([{ id: manualRow.id, quantity: 4 }], adminUser.id, { store_id: storeA.id });
    assert(res.labels === 0, `${res.labels} extra labels recorded`);
    const row = await queue.getById(manualRow.id, { store_id: storeA.id });
    assert(row.printed_qty === 5, `printed_qty drifted to ${row.printed_qty}`);
    return 'no change';
  });

  await check('asking to mark more than is owed is capped, never negative', async () => {
    const rows = await queue.list({ store_id: storeA.id });
    const target = rows.find((r) => r.size_eu === '42');
    const res = await queue.markPrinted([{ id: target.id, quantity: 999 }], adminUser.id, { store_id: storeA.id });
    const row = await queue.getById(target.id, { store_id: storeA.id });
    assert(res.labels === target.quantity, `recorded ${res.labels}, owed ${target.quantity}`);
    assert(row.printed_qty === row.quantity, `${row.printed_qty}/${row.quantity}`);
    return `999 asked, ${res.labels} recorded`;
  });

  await check('a printed row can be queued again, as a fresh request', async () => {
    const [again] = await queue.requeue(manualRow.id, adminUser.id, { store_id: storeA.id });
    assert(again.status === 'pending' && Number(again.quantity) === 5, JSON.stringify(again));
    assert(again.id !== manualRow.id, 'it reused the finished row instead of making a new one');
    const old = await queue.getById(manualRow.id, { store_id: storeA.id });
    assert(old.status === 'done', 'requeue changed the finished row');
    await knex('print_queue_items').where('id', again.id).del();
    return '5 labels back on the queue; the printed row untouched';
  });

  await check('a reprint still says which delivery it is for', async () => {
    // Otherwise the reprinted row reads "Added by hand" with nothing to connect it to
    // the invoice it belongs to, which is the one thing that makes the list readable.
    const boxE = await receiveBox({ store: storeA, items: [{ size: '43', quantity: 1 }] });
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxE.id }, adminUser.id, ADMIN_SCOPE);
    const [src] = (await queue.list({ store_id: storeA.id })).filter((r) => r.source_id === boxE.id);
    assert(src.source_ref, 'the queued row carries no reference');
    await queue.markPrinted([{ id: src.id }], adminUser.id, { store_id: storeA.id });
    const [again] = await queue.requeue(src.id, adminUser.id, { store_id: storeA.id });
    assert(again.source_type === 'manual', `source_type ${again.source_type}`);
    assert(again.source_ref === src.source_ref, `reference lost: ${again.source_ref}`);
    await knex('print_queue_items').where('id', again.id).del();
    return src.source_ref;
  });

  console.log('');
  console.log('editing and clearing:');

  await check('cutting a quantity below what already printed clamps both, and FINISHES the row', async () => {
    // The clamp was the easy half. The row also has to leave the queue: one left
    // `pending` owing nothing can never be completed — markPrinted computes zero and
    // does nothing — so it sits on the To-print list for ever, contributing 0 to a badge
    // that then reads "0" beside a list that is not empty.
    const v41 = await knex('product_variants').where({ product_id: product.id, size_eu: '41' }).first();
    const [row] = await queue.add({ store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 10 }] }, adminUser.id);
    await queue.markPrinted([{ id: row.id, quantity: 6 }], adminUser.id, { store_id: storeA.id });
    const after = await queue.update(row.id, { quantity: 4 }, { store_id: storeA.id });
    assert(after.quantity === 4 && after.printed_qty === 4, `${after.printed_qty}/${after.quantity}`);
    assert(after.remaining === 0, `remaining ${after.remaining}`);
    assert(after.status === 'done', `status ${after.status} — a row owing nothing is stuck on the queue`);
    const pending = await queue.list({ store_id: storeA.id });
    assert(!pending.some((r) => r.id === row.id), 'it is still on the To-print list');
    await knex('print_queue_items').where('id', row.id).del();
    return '10 with 6 printed, cut to 4 -> 4/4, done';
  });

  await check('re-queueing a document keeps what has already been printed', async () => {
    // The other way to double the paper. Replacing a document's rows by deleting and
    // re-inserting would reset printed_qty, so a box queued at 20 and printed to 6,
    // then re-offered, would owe 20 again — and those first 6 would come out twice.
    const boxC = await receiveBox({ store: storeA, items: [{ size: '42', quantity: 8 }] });
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxC.id }, adminUser.id, ADMIN_SCOPE);
    const [row] = (await queue.list({ store_id: storeA.id })).filter((r) => r.source_id === boxC.id);
    await queue.markPrinted([{ id: row.id, quantity: 5 }], adminUser.id, { store_id: storeA.id });

    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxC.id }, adminUser.id, ADMIN_SCOPE);
    const again = (await queue.list({ store_id: storeA.id })).filter((r) => r.source_id === boxC.id);
    assert(again.length === 1, `${again.length} rows after re-queueing`);
    assert(again[0].id === row.id, 'the row was replaced rather than updated');
    assert(again[0].quantity === 8, `quantity ${again[0].quantity}`);
    assert(again[0].printed_qty === 5, `printed_qty reset to ${again[0].printed_qty} — those 5 would print twice`);
    assert(again[0].remaining === 3, `remaining ${again[0].remaining}`);
    return '8 with 5 printed, re-offered -> still 5 printed, 3 owed';
  });

  await check('re-queueing drops a size the operator took out of the run', async () => {
    // Replace still means replace: a size deselected the second time must go, or the
    // dialog would be unable to correct a mistake.
    const boxD = await receiveBox({ store: storeA, items: [{ size: '41', quantity: 2 }, { size: '42', quantity: 2 }] });
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxD.id }, adminUser.id, ADMIN_SCOPE);
    const first = (await queue.list({ store_id: storeA.id })).filter((r) => r.source_id === boxD.id);
    assert(first.length === 2, `${first.length} rows`);

    const keep = first.find((r) => r.size_eu === '41');
    await queue.addFromSource({
      source_type: 'purchase_box', source_id: boxD.id,
      items: [{ variant_id: keep.variant_id, quantity: 2 }],
    }, adminUser.id, ADMIN_SCOPE);
    const second = (await queue.list({ store_id: storeA.id })).filter((r) => r.source_id === boxD.id);
    assert(second.length === 1 && second[0].size_eu === '41', JSON.stringify(second.map((r) => r.size_eu)));
    return '2 sizes queued, re-offered with 1 -> 1 row';
  });

  await check('marking part of a run records part of it, not all of it', async () => {
    // What the post-receive dialog does when somebody lowers the copies because the
    // roll is nearly out. Sending the row with no quantity would mark the whole run.
    const v42 = await knex('product_variants').where({ product_id: product.id, size_eu: '42' }).first();
    const [row] = await queue.add({ store_id: storeA.id, items: [{ variant_id: v42.id, quantity: 20 }] }, adminUser.id);
    const res = await queue.markPrinted([{ id: row.id, quantity: 5 }], adminUser.id, { store_id: storeA.id });
    const after = await queue.getById(row.id, { store_id: storeA.id });
    assert(res.labels === 5, `recorded ${res.labels}`);
    assert(after.status === 'pending' && after.remaining === 15, `${after.printed_qty}/${after.quantity}`);
    await knex('print_queue_items').where('id', row.id).del();
    return '5 of 20 recorded, 15 still owed';
  });

  await check('removing a row takes it off the queue', async () => {
    const v42 = await knex('product_variants').where({ product_id: product.id, size_eu: '42' }).first();
    const [row] = await queue.add({ store_id: storeA.id, items: [{ variant_id: v42.id, quantity: 1 }] }, adminUser.id);
    await queue.remove(row.id, { store_id: storeA.id });
    const gone = await knex('print_queue_items').where('id', row.id).first();
    assert(!gone, 'the row survived');
    return 'gone';
  });

  await check('clear defaults to the printed list and leaves outstanding work alone', async () => {
    const pendingBefore = await queue.list({ store_id: storeA.id });
    const doneBefore = await queue.list({ store_id: storeA.id, status: 'done' });
    assert(doneBefore.length > 0, 'nothing printed yet, so this proves nothing');
    const res = await queue.clear({ store_id: storeA.id });
    const pendingAfter = await queue.list({ store_id: storeA.id });
    const doneAfter = await queue.list({ store_id: storeA.id, status: 'done' });
    assert(doneAfter.length === 0, `${doneAfter.length} printed rows survived`);
    assert(pendingAfter.length === pendingBefore.length, 'clearing history took outstanding work with it');
    return `${res.removed} printed rows cleared, ${pendingAfter.length} still owed`;
  });

  await check('the badge counts what is owed, not what was asked for', async () => {
    const rows = await queue.list({ store_id: storeA.id });
    const owed = rows.reduce((n, r) => n + r.remaining, 0);
    const s = await queue.summary({ store_id: storeA.id });
    assert(s.items === rows.length, `${s.items} items, ${rows.length} rows`);
    assert(s.labels === owed, `${s.labels} labels, ${owed} owed`);
    return `${s.items} items / ${s.labels} labels`;
  });

  // ------------------------------------------------------------------ HTTP
  console.log('');
  console.log('over HTTP, as four different people:');

  // Make sure both branches have something on the queue for the scoping checks.
  await queue.addFromSource({ source_type: 'stock_intake', source_id: sheet.id }, adminUser.id, ADMIN_SCOPE);

  const noPerm = await scratchUser({ username: 'chk_pq_none', permissions: ['inventory'], storeIds: [storeA.id] });
  const reader = await scratchUser({ username: 'chk_pq_read', permissions: ['print_queue'], storeIds: [storeA.id], level: 'read' });
  const printer = await scratchUser({ username: 'chk_pq_write', permissions: ['print_queue'], storeIds: [storeA.id] });
  const barcoder = await scratchUser({ username: 'chk_pq_barcodes', permissions: ['barcodes', 'inventory'], storeIds: [storeA.id] });

  const tNone = await login(noPerm.username, noPerm.password);
  const tRead = await login(reader.username, reader.password);
  const tWrite = await login(printer.username, printer.password);
  const tBarcode = await login(barcoder.username, barcoder.password);

  await check('without the permission the queue is a 403, not an empty page', async () => {
    const r = await api(tNone, 'GET', '/print-queue');
    assert(r.status === 403, `status ${r.status}`);
    return r.body?.message?.slice(0, 60);
  });

  await check('`barcodes` alone does NOT open the queue — it is a separate job', async () => {
    const r = await api(tBarcode, 'GET', '/print-queue');
    assert(r.status === 403, `status ${r.status} — the two permissions are entangled`);
    return 'minting barcodes and holding the queue are separable';
  });

  await check('read-only can look at the queue but cannot add to it', async () => {
    const get = await api(tRead, 'GET', '/print-queue');
    assert(get.status === 200, `GET ${get.status}`);
    const v41 = await knex('product_variants').where({ product_id: product.id, size_eu: '41' }).first();
    const post = await api(tRead, 'POST', '/print-queue', {
      store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 1 }],
    });
    assert(post.status === 403, `POST ${post.status}`);
    return 'GET 200, POST 403';
  });

  await check('read-only cannot mark anything printed or clear the list', async () => {
    const rows = await api(tRead, 'GET', '/print-queue');
    const id = rows.body.data[0]?.id;
    assert(id, 'nothing on the queue to try against');
    const mark = await api(tRead, 'POST', '/print-queue/mark-printed', { items: [{ id }] });
    const clear = await api(tRead, 'POST', '/print-queue/clear', {});
    const del = await api(tRead, 'DELETE', `/print-queue/${id}`);
    assert(mark.status === 403 && clear.status === 403 && del.status === 403,
      `${mark.status}/${clear.status}/${del.status}`);
    return 'mark 403, clear 403, delete 403';
  });

  await check('a long selection goes through, where a URL would not', async () => {
    // "Print everything" names every row. An id is 37 characters, so a few hundred rows
    // is past nginx's default 8 KB request line and comes back as a bare 414 with
    // nothing on screen to explain it. The POST twin is the same read with the
    // selection in the body.
    const all = await api(tWrite, 'GET', '/print-queue');
    const ids = (all.body.data || []).map((r) => r.id);
    assert(ids.length > 0, 'nothing queued, so this proves nothing');
    const post = await api(tWrite, 'POST', '/print-queue/labels', { ids });
    assert(post.status === 200, `POST /labels -> ${post.status} ${JSON.stringify(post.body).slice(0, 120)}`);
    const get = await api(tWrite, 'GET', `/print-queue/labels?ids=${ids.join(',')}`);
    assert(get.status === 200, `GET /labels -> ${get.status}`);
    assert(JSON.stringify(post.body.data) === JSON.stringify(get.body.data),
      'the two forms of the same read disagree');
    return `${ids.length} rows, both forms identical`;
  });

  await check('a malformed id is refused in words, not as a database cast error', async () => {
    const r = await api(tWrite, 'GET', '/print-queue/labels?ids=not-a-uuid');
    assert(r.status === 400, `status ${r.status}`);
    assert(/queue row ids/i.test(r.body?.message || ''), `message: ${r.body?.message}`);
    return r.body.message;
  });

  await check('reading labels is not recorded as having queued any', async () => {
    // /labels has to be a POST for length, and every POST is audited by default. An
    // entry saying somebody queued labels each time they opened the print dialog would
    // describe something that did not happen.
    const before = await knex('activity_log').where('module', 'print_queue').count('id as n').first();
    const all = await api(tWrite, 'GET', '/print-queue');
    await api(tWrite, 'POST', '/print-queue/labels', { ids: (all.body.data || []).map((r) => r.id) });
    await new Promise((r) => setTimeout(r, 200));   // the logger is fire-and-forget
    const after = await knex('activity_log').where('module', 'print_queue').count('id as n').first();
    assert(Number(before.n) === Number(after.n), `${Number(after.n) - Number(before.n)} log rows for a read`);
    return 'no log entry';
  });

  await check('the printer can do the job end to end', async () => {
    const list = await api(tWrite, 'GET', '/print-queue');
    assert(list.status === 200, `list ${list.status}`);
    const v42 = await knex('product_variants').where({ product_id: product.id, size_eu: '42' }).first();
    const add = await api(tWrite, 'POST', '/print-queue', {
      store_id: storeA.id, items: [{ variant_id: v42.id, quantity: 2 }],
    });
    assert(add.status === 201, `add ${add.status} ${JSON.stringify(add.body)}`);
    const id = add.body.data[0].id;
    const labels = await api(tWrite, 'GET', `/print-queue/labels?ids=${id}`);
    assert(labels.status === 200 && labels.body.data[0].copies === 2, JSON.stringify(labels.body).slice(0, 120));
    const mark = await api(tWrite, 'POST', '/print-queue/mark-printed', { items: [{ id }] });
    assert(mark.status === 200 && mark.body.data.labels === 2, JSON.stringify(mark.body));
    await knex('print_queue_items').where('id', id).del();
    return 'add -> labels -> mark printed';
  });

  console.log('');
  console.log('THE SECOND LOAD-BEARING ONE — the queue is not a way round branch scoping:');

  await check("branch A's printer never sees branch B's queue", async () => {
    const r = await api(tWrite, 'GET', '/print-queue');
    assert(r.status === 200, `status ${r.status}`);
    const leaked = r.body.data.filter((x) => x.store_id === storeB.id);
    assert(leaked.length === 0, `${leaked.length} rows from the other branch`);
    assert(r.body.data.length > 0, 'branch A has nothing queued, so this proves nothing');
    return `${r.body.data.length} rows, all branch A`;
  });

  await check('naming the other branch is refused, not quietly ignored', async () => {
    const r = await api(tWrite, 'GET', `/print-queue?store_id=${storeB.id}`);
    assert(r.status === 403, `status ${r.status}`);
    return r.body?.message?.slice(0, 60);
  });

  await check("a row in the other branch is a 404 — its existence is not confirmed", async () => {
    const other = await knex('print_queue_items').where('store_id', storeB.id).first();
    assert(other, 'branch B has nothing queued, so this proves nothing');
    const patch = await api(tWrite, 'PATCH', `/print-queue/${other.id}`, { quantity: 1 });
    const del = await api(tWrite, 'DELETE', `/print-queue/${other.id}`);
    const mark = await api(tWrite, 'POST', '/print-queue/mark-printed', { items: [{ id: other.id }] });
    assert(patch.status === 404, `patch ${patch.status}`);
    assert(del.status === 404, `delete ${del.status}`);
    assert(mark.status === 404, `mark ${mark.status}`);
    const still = await knex('print_queue_items').where('id', other.id).first();
    assert(still && Number(still.printed_qty) === 0, "the other branch's row was changed anyway");
    return 'patch/delete/mark all 404, and the row is untouched';
  });

  await check("the other branch's labels come back empty, not printable", async () => {
    const other = await knex('print_queue_items').where('store_id', storeB.id).first();
    const r = await api(tWrite, 'GET', `/print-queue/labels?ids=${other.id}`);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.data.length === 0, `${r.body.data.length} labels for another branch's queue`);
    return 'no rows';
  });

  await check('adding obeys exactly the same branch rule as listing', async () => {
    // The two used to be decided by different helpers. `userHasStoreAccess` treats a
    // non-empty assigned_stores as the whole answer and ignores users.store_id, while
    // `resolveStoreScope` unions them — so a user whose home branch was not among their
    // user_stores rows would see that branch on the queue and be refused when adding to
    // it. Same question, two answers.
    const homeOnly = await scratchUser({
      username: 'chk_pq_home', permissions: ['print_queue'], storeIds: [],
    });
    // A home branch on the user row, and deliberately NO user_stores row for it.
    await knex('users').where('id', homeOnly.id).update({ store_id: storeA.id });
    await knex('user_stores').where('user_id', homeOnly.id).del();
    const token = await login(homeOnly.username, homeOnly.password);

    const seen = await api(token, 'GET', '/print-queue');
    assert(seen.status === 200, `list -> ${seen.status}`);

    const v41 = await knex('product_variants').where({ product_id: product.id, size_eu: '41' }).first();
    const add = await api(token, 'POST', '/print-queue', {
      store_id: storeA.id, items: [{ variant_id: v41.id, quantity: 1 }],
    });
    assert(add.status === 201, `add to the branch they can list -> ${add.status} ${JSON.stringify(add.body)}`);
    await knex('print_queue_items').where('id', add.body.data[0].id).del();

    // And the other branch is still refused.
    const other = await api(token, 'POST', '/print-queue', {
      store_id: storeB.id, items: [{ variant_id: v41.id, quantity: 1 }],
    });
    assert(other.status === 403, `add to another branch -> ${other.status}`);
    return 'lists it, so can add to it; the other branch still 403';
  });

  await check("re-queueing a document never touches another branch's rows", async () => {
    // The replace step deletes by document id. A document only lands in one branch, so
    // this cannot fire today — but an unscoped DELETE keyed on a caller-supplied id is
    // the shape of a cross-branch wipe, and the guard is asserted rather than assumed.
    const before = await queue.list({ store_id: storeB.id });
    assert(before.length > 0, 'branch B has nothing queued, so this proves nothing');
    await queue.addFromSource({ source_type: 'purchase_box', source_id: boxA.id }, adminUser.id, ADMIN_SCOPE);
    const after = await queue.list({ store_id: storeB.id });
    assert(after.length === before.length, `branch B went from ${before.length} to ${after.length} rows`);
    return `branch B untouched at ${after.length} rows`;
  });

  await check("the other branch's document cannot be queued from", async () => {
    const r = await api(tWrite, 'POST', '/print-queue/from-source', {
      source_type: 'stock_intake', source_id: sheet.id,
    });
    assert(r.status === 403, `status ${r.status}`);
    return r.body?.message?.slice(0, 60);
  });

  await check('the badge counts one branch only', async () => {
    const mine = await api(tWrite, 'GET', '/print-queue/summary');
    const all = await queue.summary(ADMIN_SCOPE);
    assert(mine.status === 200, `status ${mine.status}`);
    assert(mine.body.data.labels < all.labels, `branch A ${mine.body.data.labels} vs everything ${all.labels}`);
    return `branch A ${mine.body.data.labels} of ${all.labels}`;
  });

  await check('hiding the page is honest: the API still answers, because the permission is the control', async () => {
    await knex('users').where('id', printer.id).update({ hidden_pages: JSON.stringify(['/print-queue']) });
    const token = await login(printer.username, printer.password);
    const r = await api(token, 'GET', '/print-queue');
    await knex('users').where('id', printer.id).update({ hidden_pages: '[]' });
    assert(r.status === 200, `status ${r.status} — hiding a page must not be mistaken for a lock`);
    return 'menu tidied, nothing locked';
  });

  // ---- leave nothing behind ------------------------------------------------
  await resetWorld();

  console.log('');
  console.log(`  ${passed} passed, ${failed} failed`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await knex.destroy(); } catch { /* already closed */ }
  process.exit(1);
});
