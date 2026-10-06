/*
 * Editing and deleting a dealer payment.
 *
 * THE DANGER THIS GUARDS: `dealer_payment_allocations` has ON DELETE CASCADE from
 * `dealer_payments`. So the obvious implementation — delete the payment row — removes
 * the allocation rows too and leaves `wholesale_invoices.paid_amount` still counting
 * money that is no longer recorded anywhere. The invoice reads "paid" forever while
 * the dealer's balance says they still owe it, and no screen explains the difference.
 *
 * So these checks never assert "the payment is gone". They assert the INVOICES came
 * back to exactly where they were, which is the part that can silently rot.
 *
 * Creates and cleans up its own data.
 */
process.chdir(require('path').join(__dirname, '..'));
const knex = require('knex')(require('../knexfile.js')[process.env.NODE_ENV || 'development']);
const dealers = require('../src/modules/dealers/dealers.service');
const { generateUUID } = require('../src/utils/generateCodes');

let pass = 0, fail = 0;
const made = { dealers: [], invoices: [], payments: [] };

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

/** A dealer with invoices of the given totals, oldest first. */
async function makeDealer(totals) {
  const d = await dealers.create({ name: 'ZZ Dealer ' + Date.now() + Math.floor(pass * 31 + fail) });
  made.dealers.push(d.id);
  const invoices = [];
  for (let i = 0; i < totals.length; i++) {
    const [row] = await knex('wholesale_invoices').insert({
      id: generateUUID(),
      invoice_number: `ZZWI-${Date.now()}-${i}-${Math.floor(pass * 7 + fail)}`,
      dealer_id: d.id,
      total_amount: totals[i],
      paid_amount: 0,
      status: 'pending',
      // Dated in order, a day apart, so "oldest first" is unambiguous.
      invoice_date: new Date(2026, 0, 1 + i).toISOString().slice(0, 10),
    }).returning('*');
    made.invoices.push(row.id);
    invoices.push(row);
  }
  return { dealer: d, invoices };
}

/** The (paid_amount, status) of every invoice, as a comparable string. */
async function snapshot(ids) {
  const rows = await knex('wholesale_invoices').whereIn('id', ids).orderBy('invoice_date', 'asc');
  return rows.map((r) => `${r.invoice_number}:${Number(r.paid_amount).toFixed(2)}:${r.status}`).join(' | ');
}

const USER = null;

(async () => {
  console.log('THE DANGER: allocations cascade, so deleting a payment the obvious way');
  console.log('leaves every invoice it settled still claiming to be paid.');
  console.log('');
  console.log('deleting a payment:');

  await check('a payment settles the oldest invoices first', async () => {
    const { dealer, invoices } = await makeDealer([100, 200, 300]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 250, payment_method: 'cash',
      payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);
    const after = await snapshot(invoices.map((i) => i.id));
    if (!/:100\.00:paid/.test(after)) throw new Error('the oldest invoice was not settled: ' + after);
    if (!/:150\.00:partial/.test(after)) throw new Error('the second was not part-paid: ' + after);
    if (!/:0\.00:pending/.test(after)) throw new Error('the third should be untouched: ' + after);
    return after;
  });

  await check('deleting it puts every invoice back exactly', async () => {
    const { dealer, invoices } = await makeDealer([100, 200, 300]);
    const ids = invoices.map((i) => i.id);
    const before = await snapshot(ids);

    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 250, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    const during = await snapshot(ids);
    if (during === before) throw new Error('the payment changed nothing');

    const res = await dealers.deletePayment(p.id);

    // The state of the invoices FIRST. It is the thing that silently rots; asserting
    // the count ahead of it makes a naive implementation fail on the wrong line.
    const after = await snapshot(ids);
    if (after !== before) throw new Error(`invoices did not return.\n    before: ${before}\n    after:  ${after}`);
    if (res.reopened_invoices !== 2) throw new Error(`expected 2 invoices reopened, got ${res.reopened_invoices}`);
    return 'byte-identical to before the payment';
  });

  await check('and the dealer balance returns with them', async () => {
    const { dealer, invoices } = await makeDealer([400]);
    const start = (await dealers.getById(dealer.id)).balance;

    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 400, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    const mid = (await dealers.getById(dealer.id)).balance;
    if (mid !== 0) throw new Error(`a fully paid dealer should owe 0, got ${mid}`);

    await dealers.deletePayment(p.id);
    const end = (await dealers.getById(dealer.id)).balance;
    if (end !== start) throw new Error(`balance did not return: ${start} -> ${end}`);

    // THE BALANCE ALONE PROVES NOTHING. It is computed from dealer_payments, so it
    // comes back correct the moment the payment row disappears — even when every
    // invoice is left still claiming to be paid. That mismatch is exactly the bug,
    // and only the invoice itself shows it.
    const inv = await knex('wholesale_invoices').where('id', invoices[0].id).first();
    if (Number(inv.paid_amount) !== 0 || inv.status !== 'pending') {
      throw new Error(`the invoice still claims ${inv.paid_amount} paid (${inv.status}) while the dealer owes ${end}`);
    }
    // And no allocation rows were orphaned.
    const orphans = await knex('dealer_payment_allocations').where('payment_id', p.id);
    if (orphans.length) throw new Error(`${orphans.length} allocation row(s) left behind`);
    return `${start} -> ${mid} -> ${end}`;
  });

  await check('a payment that settled nothing deletes cleanly too', async () => {
    // All credit, no invoices. The reversal loop must cope with having nothing to undo.
    const { dealer } = await makeDealer([]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 500, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    if (p.unallocated_credit !== 500) throw new Error(`expected 500 in credit, got ${p.unallocated_credit}`);
    const res = await dealers.deletePayment(p.id);
    if (res.reopened_invoices !== 0) throw new Error('reopened something that did not exist');
    const gone = await knex('dealer_payments').where('id', p.id).first();
    if (gone) throw new Error('the payment survived');
  });

  await check('deleting a payment that is already gone is a 404, not a crash', async () => {
    let status = null;
    try { await dealers.deletePayment(generateUUID()); } catch (e) { status = e.statusCode || e.status; }
    if (status !== 404) throw new Error('expected 404, got ' + status);
  });

  console.log('');
  console.log('editing the amount:');

  await check('lowering it releases what it had over-settled', async () => {
    const { dealer, invoices } = await makeDealer([100, 200]);
    const ids = invoices.map((i) => i.id);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 300, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);
    let after = await snapshot(ids);
    if (!/:100\.00:paid/.test(after) || !/:200\.00:paid/.test(after)) {
      throw new Error('both should start fully paid: ' + after);
    }

    await dealers.updatePayment(p.id, { total_amount: 150 });
    after = await snapshot(ids);
    if (!/:100\.00:paid/.test(after)) throw new Error('the first should still be paid: ' + after);
    if (!/:50\.00:partial/.test(after)) throw new Error('the second should drop to 50: ' + after);
    return after;
  });

  await check('raising it settles further down the queue', async () => {
    const { dealer, invoices } = await makeDealer([100, 200]);
    const ids = invoices.map((i) => i.id);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 50, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);

    const res = await dealers.updatePayment(p.id, { total_amount: 300 });
    const after = await snapshot(ids);
    if (!/:100\.00:paid/.test(after) || !/:200\.00:paid/.test(after)) {
      throw new Error('300 should clear both: ' + after);
    }
    if (res.unallocated_credit !== 0) throw new Error('nothing should be left over');
    return after;
  });

  await check('raising it past what is owed becomes credit, not an overpaid invoice', async () => {
    const { dealer, invoices } = await makeDealer([100]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 50, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);

    const res = await dealers.updatePayment(p.id, { total_amount: 400 });
    if (res.unallocated_credit !== 300) throw new Error(`expected 300 credit, got ${res.unallocated_credit}`);
    const inv = await knex('wholesale_invoices').where('id', invoices[0].id).first();
    if (Number(inv.paid_amount) !== 100) throw new Error(`invoice over-paid to ${inv.paid_amount}`);
    if (inv.status !== 'paid') throw new Error('status wrong: ' + inv.status);
    return '100 applied, 300 held as credit';
  });

  await check('editing to the same amount changes nothing', async () => {
    const { dealer, invoices } = await makeDealer([100, 200]);
    const ids = invoices.map((i) => i.id);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 250, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);
    const before = await snapshot(ids);
    await dealers.updatePayment(p.id, { total_amount: 250 });
    const after = await snapshot(ids);
    if (after !== before) throw new Error(`a no-op edit moved the books.\n    ${before}\n    ${after}`);
    return before;
  });

  await check('the other fields can be corrected without touching the money', async () => {
    const { dealer, invoices } = await makeDealer([100]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 60, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);
    const before = await snapshot(invoices.map((i) => i.id));

    const res = await dealers.updatePayment(p.id, {
      payment_method: 'instapay', reference_no: 'REF-123', notes: 'corrected',
    });
    if (res.payment_method !== 'instapay') throw new Error('method not changed');
    if (res.reference_no !== 'REF-123') throw new Error('reference not changed');
    if (Number(res.total_amount) !== 60) throw new Error('amount changed when it should not have');
    const after = await snapshot(invoices.map((i) => i.id));
    if (after !== before) throw new Error('the invoices moved on a non-money edit');
    return 'method, reference and notes only';
  });

  await check('editing a payment that does not exist is a 404', async () => {
    let status = null;
    try { await dealers.updatePayment(generateUUID(), { total_amount: 10 }); } catch (e) { status = e.statusCode || e.status; }
    if (status !== 404) throw new Error('expected 404, got ' + status);
  });

  console.log('');
  console.log('never writing a nonsense figure:');

  await check('paid_amount can never be driven below zero', async () => {
    const { dealer, invoices } = await makeDealer([100]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 100, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    // Somebody edits the invoice down underneath the payment — drift this guard exists
    // for. Reversing must clamp rather than write a negative.
    await knex('wholesale_invoices').where('id', invoices[0].id).update({ paid_amount: 40 });
    await dealers.deletePayment(p.id);
    const inv = await knex('wholesale_invoices').where('id', invoices[0].id).first();
    if (Number(inv.paid_amount) < 0) throw new Error(`paid_amount went negative: ${inv.paid_amount}`);
    if (inv.status !== 'pending') throw new Error('status should fall back to pending, got ' + inv.status);
    return `clamped to ${Number(inv.paid_amount).toFixed(2)}, pending`;
  });

  await check('the screen is told what each payment is settling', async () => {
    const { dealer } = await makeDealer([100, 200]);
    const p = await dealers.createPayment({
      dealer_id: dealer.id, total_amount: 250, payment_method: 'cash', payment_date: '2026-02-01',
    }, USER);
    made.payments.push(p.id);
    const d = await dealers.getById(dealer.id);
    const row = d.payments.find((x) => x.id === p.id);
    if (!row) throw new Error('the payment is not listed');
    if (row.allocations.length !== 2) throw new Error(`expected 2 allocations, got ${row.allocations.length}`);
    if (row.allocated_amount !== 250) throw new Error('allocated total wrong: ' + row.allocated_amount);
    if (row.unallocated_amount !== 0) throw new Error('unallocated wrong: ' + row.unallocated_amount);

    const one = await dealers.getPaymentById(p.id);
    if (one.allocations.length !== 2) throw new Error('getPaymentById disagrees');
    return '2 invoices, 250 applied, 0 held';
  });

  // ---------------------------------------------------------------- cleanup
  for (const id of made.payments) await knex('dealer_payments').where('id', id).del().catch(() => {});
  await knex('dealer_payments').whereIn('dealer_id', made.dealers).del();
  await knex('wholesale_invoices').whereIn('id', made.invoices).del();
  await knex('dealers').whereIn('id', made.dealers).del();

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  await knex.destroy();
  process.exit(1);
});
