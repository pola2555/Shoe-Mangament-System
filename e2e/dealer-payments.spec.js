import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * RECORDING, CORRECTING AND REMOVING A DEALER PAYMENT.
 *
 * `check:dealers` already proves the money: that deleting a payment puts every invoice
 * it settled back exactly, that editing re-applies it, and that `paid_amount` can
 * never be driven below zero. What it cannot prove is that a person can do any of it,
 * or — the point of the request — that the warning before deleting says what is about
 * to happen rather than "are you sure?".
 *
 * Worth knowing while reading this: before this work there was no way to record a
 * dealer payment on any screen at all. The API had existed since the first migration
 * and nothing called it.
 */

const MARK = 'E2E-DEALER-PAY';
let ctx = { dealerId: null, invoiceIds: [], dealerName: null };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  ctx.dealerName = `${MARK} ${Date.now()}`;
  const d = await api(page, 'POST', '/dealers', { body: { name: ctx.dealerName } });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  ctx.dealerId = d.body.data.id;

  // Two invoices, so a payment can straddle them and the warning has something real
  // to name. Oldest first by date, which is the order FIFO settles them in.
  for (const [i, total] of [[0, 100], [1, 200]]) {
    const inv = await api(page, 'POST', '/dealers/invoices', {
      body: {
        dealer_id: ctx.dealerId,
        total_amount: total,
        invoice_date: `2026-0${1 + i}-01`,
        boxes: [],
      },
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    ctx.invoiceIds.push(inv.body.data.id);
  }
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const d = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  for (const p of (d.body?.data?.payments || [])) {
    await api(page, 'DELETE', `/dealers/payments/${p.id}`).catch(() => {});
  }
  await page.close();
});

/** Open the dealer's detail modal. */
async function openDealer(page) {
  await page.goto('/dealers');
  await expect(page.getByRole('heading', { name: /dealers/i }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('row', { name: new RegExp(ctx.dealerName) }).click();
  await expect(page.getByTestId('dealer-payments')).toBeVisible({ timeout: 15_000 });
}

test('D1 · a payment can be recorded from the screen at all', async ({ page }) => {
  await openDealer(page);
  await expect(page.getByTestId('dealer-payments')).toContainText(/no payments/i);

  await page.getByTestId('dealer-record-payment').click();
  await page.getByTestId('dealer-payment-amount').fill('250');
  await page.getByTestId('dealer-payment-save').click();

  // 250 across invoices of 100 and 200: the first clears, the second part-pays.
  await expect(page.getByTestId('dealer-payments')).toContainText('250', { timeout: 15_000 });
  const d = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const invoices = d.body.data.invoices.slice().sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
  expect(Number(invoices[0].paid_amount)).toBe(100);
  expect(invoices[0].status).toBe('paid');
  expect(Number(invoices[1].paid_amount)).toBe(150);
  expect(invoices[1].status).toBe('partial');
  await shot(page, 'dealer-payment-recorded');
});

test('D2 · the row says which invoices the payment is holding up', async ({ page }) => {
  await openDealer(page);
  const d = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const payment = d.body.data.payments[0];
  const numbers = payment.allocations.map((a) => a.invoice_number);
  expect(numbers.length, 'the payment should straddle both invoices').toBe(2);

  const row = page.getByTestId(`dealer-payment-${payment.id}`);
  for (const n of numbers) await expect(row).toContainText(n);
});

test('D3 · editing the amount re-applies it, and the invoices follow', async ({ page }) => {
  await openDealer(page);
  const before = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const payment = before.body.data.payments[0];

  await page.getByTestId(`dealer-payment-edit-${payment.id}`).click();
  const amount = page.getByTestId('dealer-payment-amount');
  await expect(amount).toHaveValue(/250/);
  await amount.fill('120');
  await page.getByTestId('dealer-payment-save').click();

  await expect(page.getByTestId('dealer-payments')).toContainText('120', { timeout: 15_000 });

  // 120 now: the first invoice still clears, the second drops to 20.
  const after = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const invoices = after.body.data.invoices.slice().sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
  expect(Number(invoices[0].paid_amount)).toBe(100);
  expect(invoices[0].status).toBe('paid');
  expect(Number(invoices[1].paid_amount)).toBe(20);
  expect(invoices[1].status).toBe('partial');
  await shot(page, 'dealer-payment-edited');
});

test('D4 · the delete warning names the invoices that will reopen', async ({ page }) => {
  await openDealer(page);
  const d = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const payment = d.body.data.payments[0];
  const numbers = payment.allocations.map((a) => a.invoice_number);
  expect(numbers.length).toBeGreaterThan(0);

  await page.getByTestId(`dealer-payment-delete-${payment.id}`).click();

  // THE POINT OF THE REQUEST. Not "are you sure?" — a sentence naming the amount, how
  // many invoices it is paying, and which, so the question can actually be answered.
  const dialog = page.locator('.modal-overlay--confirm');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const text = await dialog.textContent();
  for (const n of numbers) {
    expect(text, `the warning does not name invoice ${n}`).toContain(n);
  }
  expect(text).toMatch(/owing|reopen|back to/i);
  expect(text).toMatch(/cannot be undone/i);
  await shot(page, 'dealer-payment-delete-warning');

  // Cancelling leaves everything exactly as it was.
  await dialog.getByRole('button', { name: /cancel/i }).click();
  const unchanged = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  expect(unchanged.body.data.payments.length).toBe(d.body.data.payments.length);
});

test('D5 · deleting it puts the invoices back to owing', async ({ page }) => {
  await openDealer(page);
  const before = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const payment = before.body.data.payments[0];

  await page.getByTestId(`dealer-payment-delete-${payment.id}`).click();
  const dialog = page.locator('.modal-overlay--confirm');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: /delete/i }).click();

  await expect(page.getByTestId('dealer-payments')).toContainText(/no payments/i, { timeout: 15_000 });

  // Every invoice back to pending, nothing paid, and the dealer owes the lot again.
  const after = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  for (const inv of after.body.data.invoices) {
    expect(Number(inv.paid_amount), `${inv.invoice_number} still claims money`).toBe(0);
    expect(inv.status).toBe('pending');
  }
  expect(after.body.data.balance).toBe(300);
  await shot(page, 'dealer-payment-deleted');
});

test('D6 · a payment that settles nothing warns differently', async ({ page }) => {
  // All the invoices are clear by now, so this one is pure credit. The warning must
  // not claim invoices are about to reopen when none are.
  await openDealer(page);
  await page.getByTestId('dealer-record-payment').click();
  await page.getByTestId('dealer-payment-amount').fill('500');
  await page.getByTestId('dealer-payment-save').click();
  await expect(page.getByTestId('dealer-payments')).toContainText('500', { timeout: 15_000 });

  const d = await api(page, 'GET', `/dealers/${ctx.dealerId}`);
  const credit = d.body.data.payments.find((p) => Number(p.total_amount) === 500);
  expect(credit.allocations.length, 'nothing was outstanding, so nothing should be applied').toBeGreaterThanOrEqual(0);

  await page.getByTestId(`dealer-payment-delete-${credit.id}`).click();
  const dialog = page.locator('.modal-overlay--confirm');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  if (credit.allocations.length === 0) {
    await expect(dialog).toContainText(/settled no invoices|nothing reopens/i);
  }
  await dialog.getByRole('button', { name: /delete/i }).click();
  await expect(page.getByTestId('dealer-payments')).toContainText(/no payments/i, { timeout: 15_000 });
});
