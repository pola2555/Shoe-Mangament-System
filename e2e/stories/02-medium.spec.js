import { test, expect } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage, takePair, cleanup, pickOption, priceOf } from './world.js';

/**
 * MEDIUM STORIES — several steps, one person, and a consequence that outlives the step.
 *
 * The theme is money that does not settle in one motion: credit, refunds, a sale that
 * has to be undone, stock that moves between branches. Each of these leaves a trace
 * somewhere else in the system, and that trace is what is being checked.
 */

const world = loadWorld();
const claimed = new Set();
const made = { saleIds: [], expenseIds: [], loanIds: [], transferIds: [] };

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  await cleanup(api, page, made);
  await closePage(page);
});

const A = () => world.stores.A.id;
const B = () => world.stores.B.id;

// ─────────────────────────────────────────────────────── money that lingers

test('M1 · a three-item sale split across cash and card', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');

  const items = [];
  for (const key of ['shoe', 'sock', 'belt']) {
    const pair = await takePair(api, page, { storeId: A(), productId: world.products[key].id, exclude: claimed });
    items.push({ id: pair.id, sale_price: priceOf(pair, world.products[key].price) });
  }
  const total = items.reduce((n, i) => n + i.sale_price, 0);

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), items,
      payments: [
        { amount: 500, payment_method: 'cash' },
        { amount: total - 500, payment_method: 'card' },
      ],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);

  const detail = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  expect(detail.body.data.items.length).toBe(3);
  expect(detail.body.data.payments.length).toBe(2);
  expect(Number(detail.body.data.amount_due)).toBe(0);
  await closePage(page);
});

test('M2 · a walk-in cannot walk out owing money, and is told why', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.bag.id, exclude: claimed });

  const res = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(),
      items: [{ id: pair.id, sale_price: priceOf(pair, world.products.bag.price) }],
      payments: [{ amount: 100, payment_method: 'cash' }],
    },
  });
  expect(res.status).toBe(400);
  expect(String(res.body.message)).toMatch(/walk-in|in full|add the customer/i);

  // The refused sale rolled back completely — the bag is still sellable.
  const after = await api(page, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '50' } });
  expect(after.body.data.find((i) => i.id === pair.id).status).toBe('in_stock');
  claimed.delete(pair.id);
  await closePage(page);
});

test('M3 · Rania takes the shoes today and pays the rest on Friday', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier');
  await page.goto('/');
  const pair = await takePair(api, page, { storeId: A(), productId: world.products.shoe.id, exclude: claimed });
  const price = world.products.shoe.price;

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), customer_id: world.customers.regular.id,
      items: [{ id: pair.id, sale_price: price }],
      payments: [{ amount: 200, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);
  expect(Number(sale.body.data.amount_due)).toBe(price - 200);

  // What she owes shows up against her, not just against the sale.
  const balance = await api(page, 'GET', `/sales/customer-balance/${world.customers.regular.id}`);
  expect(balance.body.data.outstanding).toBeGreaterThanOrEqual(price - 200);

  // And the till warns before taking more on account. The customer is chosen through
  // the real control: the POS writes its own store/customer/cart to localStorage
  // whenever they change, so a value poked into storage gets overwritten the moment
  // the store list lands, which reads as a broken feature and is not one.
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });
  const customerField = page.locator('.pos-cart-selectors .form-group').nth(1);
  await pickOption(customerField, 'Rania');
  await expect(page.getByTestId('pos-customer-balance')).toBeVisible({ timeout: 25_000 });
  // Against what the server says she owes right now, not a hard-coded figure: other
  // stories in this file also sell to her, and a literal here would be asserting the
  // order the file happens to run in rather than the feature.
  const owed = (await api(page, 'GET', `/sales/customer-balance/${world.customers.regular.id}`,
    { params: { store_id: A() } })).body.data.outstanding;
  expect(owed).toBeGreaterThanOrEqual(price - 200);
  await expect(page.getByTestId('pos-customer-balance'))
    .toContainText(owed.toLocaleString('en-US'));
  await shot(page, 'story-customer-owes');

  // Friday: she settles.
  const settle = await api(page, 'POST', `/sales/${sale.body.data.id}/payments`, {
    body: { amount: price - 200, payment_method: 'cash' },
  });
  // 201: a payment is a record that did not exist before. (This assertion said 200
  // first — the test was wrong, not the API.)
  expect(settle.status, JSON.stringify(settle.body)).toBe(201);
  const after = await api(page, 'GET', `/sales/customer-balance/${world.customers.regular.id}`);
  expect(after.body.data.unpaid_sales.some((s) => s.id === sale.body.data.id)).toBe(false);
  await closePage(page);
});

test('M4 · Karim rings the wrong pair and Mona undoes it', async ({ browser }) => {
  const cashier = await pageAs(browser, 'cashier');
  await cashier.goto('/');
  const pair = await takePair(api, cashier, { storeId: A(), productId: world.products.shoe.id, exclude: claimed });

  const sale = await api(cashier, 'POST', '/sales', {
    body: {
      store_id: A(),
      items: [{ id: pair.id, sale_price: priceOf(pair, world.products.shoe.price) }],
      payments: [{ amount: priceOf(pair, world.products.shoe.price), payment_method: 'cash' }],
    },
  });
  expect(sale.status).toBe(201);
  const saleId = sale.body.data.id;

  // Karim himself cannot: voiding money is not his to do.
  const refused = await api(cashier, 'POST', `/sales/${saleId}/void`, { body: { reason: 'wrong pair' } });
  expect(refused.status, 'a cashier must not be able to void').toBe(403);
  await closePage(cashier);

  // Mona can.
  const manager = await pageAs(browser, 'manager');
  await manager.goto('/');
  const voided = await api(manager, 'POST', `/sales/${saleId}/void`, { body: { reason: 'wrong pair scanned' } });
  expect(voided.status, JSON.stringify(voided.body)).toBe(200);

  // The pair is back on the shelf and the sale is out of the list but still on record.
  const back = await api(manager, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '50' } });
  expect(back.body.data.find((i) => i.id === pair.id).status).toBe('in_stock');
  const list = await api(manager, 'GET', '/sales');
  expect(list.body.data.some((s) => s.id === saleId)).toBe(false);
  const withVoided = await api(manager, 'GET', '/sales', { params: { include_voided: 'true' } });
  expect(withVoided.body.data.some((s) => s.id === saleId)).toBe(true);
  claimed.delete(pair.id);
  await closePage(manager);
});

test('M5 · a customer brings one item back and is refunded for it alone', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  const items = [];
  for (const key of ['sock', 'belt']) {
    const pair = await takePair(api, page, { storeId: A(), productId: world.products[key].id, exclude: claimed });
    items.push({ id: pair.id, sale_price: priceOf(pair, world.products[key].price), key });
  }
  const total = items.reduce((n, i) => n + i.sale_price, 0);

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), customer_id: world.customers.regular.id,
      items: items.map((i) => ({ id: i.id, sale_price: i.sale_price })),
      payments: [{ amount: total, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);

  const detail = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  const beltLine = detail.body.data.items.find((i) => Number(i.sale_price) === world.products.belt.price);
  expect(beltLine).toBeTruthy();

  const ret = await api(page, 'POST', '/returns/customer', {
    body: {
      sale_id: sale.body.data.id, store_id: A(),
      refund_method: 'cash', reason: 'wrong size',
      items: [{ sale_item_id: beltLine.id, refund_amount: world.products.belt.price }],
    },
  });
  expect(ret.status, JSON.stringify(ret.body)).toBe(201);

  // Only the belt came back. The socks stayed sold.
  const after = await api(page, 'GET', `/sales/${sale.body.data.id}`);
  expect(Number(after.body.data.refunded_amount)).toBe(world.products.belt.price);

  // And a sale with a return against it can no longer be voided — doing both would
  // reverse it twice.
  const void2 = await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'should refuse' } });
  expect(void2.status, 'voiding a returned sale must be refused').toBe(400);
  expect(String(void2.body.message)).toMatch(/return/i);
  // It is therefore not cleanable by voiding; drop it from the cleanup list.
  made.saleIds = made.saleIds.filter((id) => id !== sale.body.data.id);
  await closePage(page);
});

// ─────────────────────────────────────────────────────── stock on the move

test('M6 · Samir ships stock and the receiving branch confirms it, not him', async ({ browser }) => {
  const stock = await pageAs(browser, 'stockkeeper');
  await stock.goto('/');

  // He works in branch B, so that is what he can send from.
  const pair = await takePair(api, stock, { storeId: B(), productId: world.products.shoe.id, exclude: claimed });

  const transfer = await api(stock, 'POST', '/transfers', {
    body: { from_store_id: B(), to_store_id: A(), item_ids: [pair.id], notes: 'story transfer' },
  });
  expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
  const id = transfer.body.data.id;

  const shipped = await api(stock, 'POST', `/transfers/${id}/ship`);
  expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);

  // In flight, the pair belongs to neither shelf.
  const midway = await api(stock, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '100' } });
  expect(midway.body.data.find((i) => i.id === pair.id).status).not.toBe('in_stock');

  // He cannot sign for it at the far end. That is the whole point of two steps: the
  // branch that receives the goods is the one that says they arrived.
  const selfReceive = await api(stock, 'POST', `/transfers/${id}/receive`);
  expect(selfReceive.status, 'the sender must not be able to confirm arrival').toBe(403);
  await closePage(stock);

  // Mona works in both branches, so she can sign for it at A.
  const manager = await pageAs(browser, 'manager');
  await manager.goto('/');
  const received = await api(manager, 'POST', `/transfers/${id}/receive`);
  expect(received.status, JSON.stringify(received.body)).toBe(200);

  const arrived = await api(manager, 'GET', '/inventory', { params: { variant_id: pair.variant_id, limit: '100' } });
  const row = arrived.body.data.find((i) => i.id === pair.id);
  expect(row.status).toBe('in_stock');
  expect(row.store_id, 'the pair now belongs to the receiving branch').toBe(A());
  claimed.delete(pair.id);
  await closePage(manager);
});

test('M7 · a branch sets its own price and the till charges it', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto(`/stores/${A()}`);
  await page.getByTestId('store-tab-pricing').click();
  await expect(page.getByTestId('store-prices-table')).toBeVisible({ timeout: 25_000 });

  const productId = world.products.sock.id;
  const set = await api(page, 'PUT', `/stores/${A()}/prices/${productId}`, {
    body: { selling_price: 72, min_selling_price: 60, max_selling_price: 90 },
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);

  // The till reads the branch price for A and the catalogue price for B.
  const inA = await api(page, 'GET', '/inventory', {
    params: { store_id: A(), product_id: productId, status: 'in_stock', limit: '1' },
  });
  expect(Number(inA.body.data[0].store_selling_price)).toBe(72);
  const inB = await api(page, 'GET', '/inventory', {
    params: { store_id: B(), product_id: productId, status: 'in_stock', limit: '1' },
  });
  expect(inB.body.data[0].store_selling_price).toBeNull();

  // And the branch band is what the sale is judged against: 55 is inside the
  // catalogue band (50-80) but below this branch's floor of 60.
  const pair = await takePair(api, page, { storeId: A(), productId, exclude: claimed });
  const tooLow = await api(page, 'POST', '/sales', {
    body: { store_id: A(), items: [{ id: pair.id, sale_price: 55 }],
      payments: [{ amount: 55, payment_method: 'cash' }] },
  });
  expect(tooLow.status, 'the branch floor must be enforced, not just the catalogue one').toBe(400);
  claimed.delete(pair.id);

  await api(page, 'PUT', `/stores/${A()}/prices/${productId}`, { body: { selling_price: null } });
  await closePage(page);
});

// ─────────────────────────────────────────────────────── money going out

test('M8 · Mona budgets for a month and watches the actual eat into it', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/expenses');

  const cats = await api(page, 'GET', '/expenses/categories', { params: { is_active: 'true' } });
  const category = cats.body.data.find((c) => c.is_active);
  test.skip(!category, 'no expense category to budget against');

  const month = `${new Date().toLocaleDateString('en-CA').slice(0, 8)}01`;
  const budget = await api(page, 'PUT', '/expenses/budgets', {
    body: { store_id: A(), category_id: category.id, period_month: month, amount: 5000 },
  });
  expect(budget.status, JSON.stringify(budget.body)).toBe(200);

  const before = await api(page, 'GET', '/expenses/budgets', {
    params: { store_id: A(), period_month: month },
  });
  const rowBefore = before.body.data.rows.find((r) => r.category_id === category.id);
  expect(Number(rowBefore.budget)).toBe(5000);

  const spend = await api(page, 'POST', '/expenses', {
    body: { store_id: A(), category_id: category.id, amount: 1250,
      expense_date: new Date().toLocaleDateString('en-CA'), description: 'Story budget test' },
  });
  expect(spend.status).toBe(201);
  made.expenseIds.push(spend.body.data.id);

  const after = await api(page, 'GET', '/expenses/budgets', {
    params: { store_id: A(), period_month: month },
  });
  const rowAfter = after.body.data.rows.find((r) => r.category_id === category.id);
  expect(Number(rowAfter.actual)).toBeGreaterThanOrEqual(1250);
  expect(Number(rowAfter.variance)).toBe(Number(rowAfter.budget) - Number(rowAfter.actual));
  await shot(page, 'story-budget');
  await closePage(page);
});

test('M9 · the same spend, split by branch, adds up to the same total', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/expenses');
  await expect(page.getByTestId('expenses-table')).toBeVisible({ timeout: 25_000 });

  const split = await api(page, 'GET', '/expenses/by-store');
  const list = await api(page, 'GET', '/expenses', { params: { limit: '1' } });
  expect(Math.abs(split.body.data.total - list.body.summary.total)).toBeLessThan(0.01);

  // Narrowing to one branch gives that branch's own figure, not a share of the total.
  const first = split.body.data.stores[0];
  const scoped = await api(page, 'GET', '/expenses', { params: { limit: '1', store_id: first.store_id } });
  expect(Math.abs(scoped.body.summary.total - first.total)).toBeLessThan(0.01);
  await closePage(page);
});

test('M10 · a loan to someone who does not work here, repaid in instalments', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/loans');

  const today = new Date().toLocaleDateString('en-CA');
  const loan = await api(page, 'POST', '/loans', {
    body: {
      borrower_name: 'Hassan the Driver', borrower_phone: '01000000301',
      amount: 3000, loan_date: today, store_id: A(),
      notes: 'story loan', installments: 3, installment_start: today,
    },
  });
  expect(loan.status, JSON.stringify(loan.body)).toBe(201);
  made.loanIds.push(loan.body.data.id);

  const detail = await api(page, 'GET', `/loans/${loan.body.data.id}`);
  expect(detail.body.data.installments.length).toBe(3);
  // Split to the penny, with the remainder on the first.
  const sum = detail.body.data.installments.reduce((n, i) => n + Number(i.amount), 0);
  expect(Math.abs(sum - 3000)).toBeLessThan(0.01);

  const pay = await api(page, 'POST', `/loans/${loan.body.data.id}/payments`, {
    body: { amount: 1000, payment_date: today, payment_method: 'cash' },
  });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);

  const after = await api(page, 'GET', `/loans/${loan.body.data.id}`);
  expect(Number(after.body.data.paid_amount)).toBe(1000);
  expect(after.body.data.status).toBe('partial');

  // Repaying more than is owed is refused.
  const over = await api(page, 'POST', `/loans/${loan.body.data.id}/payments`, {
    body: { amount: 99999, payment_date: today, payment_method: 'cash' },
  });
  expect(over.status).toBe(400);
  await shot(page, 'story-loan');
  await closePage(page);
});

test('M11 · scrolling a long form does not quietly rewrite a number', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/expenses');
  await page.getByTestId('add-expense').click();
  const amount = page.getByTestId('expense-amount');
  await amount.fill('4321');
  await amount.focus();
  await amount.hover();
  await page.mouse.wheel(0, 600);
  await page.mouse.wheel(0, -600);
  await expect(amount).toHaveValue('4321');
  await closePage(page);
});
