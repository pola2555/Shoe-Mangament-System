import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Expenses and loans, through the screens.
 *
 * Two failures drove this work, and both are asserted here:
 *
 *   - The loans form could not create a loan at all. Both dropdowns read
 *     SearchableSelect's event object as if it were a raw value, so the picker showed
 *     blank after a choice and the server rejected the payload.
 *   - Every expense filter and the "Total" under them ran in the browser over a hard
 *     LIMIT 500, so both silently stopped being true past row 501.
 *
 * Rows created here are cleaned up at the end — unlike products, expenses and loans
 * can be deleted through the API.
 */

const MARK = 'E2E-EL';
let ctx = { storeId: null, categoryId: null, made: { expenses: [], loans: [], categories: [] } };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = (stores.body.data || [])[0]?.id;
  expect(ctx.storeId, 'need a store').toBeTruthy();
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  for (const id of ctx.made.expenses) await api(page, 'DELETE', `/expenses/${id}`).catch(() => {});
  for (const id of ctx.made.loans) await api(page, 'DELETE', `/loans/${id}`).catch(() => {});
  for (const id of ctx.made.categories) await api(page, 'DELETE', `/expenses/categories/${id}`).catch(() => {});
  await page.close();
});

// ---------------------------------------------------------------- expenses

test('a shop can add its own expense category, two levels deep', async ({ page }) => {
  await page.goto('/expenses');
  await page.getByTestId('open-expense-categories').click();
  const modal = page.getByTestId('expense-categories-modal');
  await expect(modal).toBeVisible();

  // The six seeded categories were the only ones that ever existed — there was no
  // endpoint to add a seventh.
  await expect(modal).toContainText('Rent');
  await expect(modal).toContainText('Salaries');

  await modal.getByTestId('add-expense-category').click();
  await modal.getByTestId('expcat-name').fill(`${MARK} Utilities`);
  await modal.getByTestId('expcat-name-ar').fill('مرافق');
  await modal.getByTestId('expcat-save').click();
  await expect(modal).toContainText(`${MARK} Utilities`, { timeout: 15_000 });

  // And a sub-category under it.
  await modal.getByTestId('add-expense-category').click();
  await modal.getByTestId('expcat-name').fill(`${MARK} Electricity`);
  await modal.locator('.react-select__control').first().click();
  await page.getByText(`${MARK} Utilities`, { exact: true }).click();
  await modal.getByTestId('expcat-save').click();
  await expect(modal).toContainText(`${MARK} Electricity`, { timeout: 15_000 });

  await shot(page, 'expense-categories');

  const cats = await api(page, 'GET', '/expenses/categories');
  const parent = cats.body.data.find((c) => c.name === `${MARK} Utilities`);
  const child = cats.body.data.find((c) => c.name === `${MARK} Electricity`);
  expect(parent, 'parent category was not created').toBeTruthy();
  expect(child.parent_id, 'child is not filed under the parent').toBe(parent.id);
  ctx.categoryId = child.id;
  // Children first: the parent cannot be deleted while it holds one.
  ctx.made.categories.push(child.id, parent.id);

  await modal.getByRole('button', { name: /close/i }).click();
});

test('the total under the table describes the filter, not the page', async ({ page }) => {
  await page.goto('/');
  // Three expenses of 100 in one category, so the arithmetic is unambiguous.
  for (let i = 0; i < 3; i++) {
    const res = await api(page, 'POST', '/expenses', {
      body: {
        store_id: ctx.storeId, category_id: ctx.categoryId, amount: 100,
        description: `${MARK} bill ${i}`, expense_date: '2026-06-15',
        payment_method: 'cash', paid_to: `${MARK} Vendor`,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ctx.made.expenses.push(res.body.data.id);
  }

  // One page of two rows, but the total must still describe all three.
  const page1 = await api(page, 'GET', '/expenses', { params: { search: MARK, limit: '2' } });
  expect(page1.body.data.length).toBe(2);
  expect(page1.body.pagination.total).toBe(3);
  expect(page1.body.summary.total).toBe(300);

  await page.goto('/expenses');
  await page.getByTestId('expense-search').fill(MARK);
  await expect(page.getByTestId('expense-total')).toContainText('300', { timeout: 20_000 });
  await expect(page.getByTestId('expense-showing')).toContainText('3');
  await shot(page, 'expenses-filtered');
});

test('an expense can be edited instead of deleted and retyped', async ({ page }) => {
  await page.goto('/expenses');
  await page.getByTestId('expense-search').fill(`${MARK} bill 0`);
  const row = page.getByTestId(`expense-row-${ctx.made.expenses[0]}`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  // There was no edit at all — the page offered only ✕, so fixing a typo destroyed the
  // record and its audit trail.
  await page.getByTestId(`edit-expense-${ctx.made.expenses[0]}`).click();
  const form = page.getByTestId('expense-form');
  await expect(form).toBeVisible();
  await form.getByTestId('expense-amount').fill('175.50');
  await form.getByTestId('expense-paid-to').fill(`${MARK} Corrected`);
  await form.getByTestId('expense-save').click();

  await expect(row).toContainText('175.5', { timeout: 20_000 });
  await expect(row).toContainText(`${MARK} Corrected`);

  const check = await api(page, 'GET', `/expenses/${ctx.made.expenses[0]}`);
  expect(parseFloat(check.body.data.amount)).toBe(175.5);
});

test('a recurring cost is listed as due and posts on a click', async ({ page }) => {
  await page.goto('/');
  const made = await api(page, 'POST', '/expenses/recurring', {
    body: {
      store_id: ctx.storeId, category_id: ctx.categoryId, amount: 2500,
      description: `${MARK} rent`, frequency: 'monthly',
      next_date: '2026-06-01', payment_method: 'cash',
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const tplId = made.body.data.id;

  await page.goto('/expenses');
  await page.getByTestId('expenses-tab-recurring').click();
  const row = page.getByTestId(`recurring-row-${tplId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(/due now/i);
  await shot(page, 'recurring-due');

  // Nothing posts by itself — there is no scheduler, and booking rent without a person
  // deciding it went out would be worse than a reminder.
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`post-recurring-${tplId}`).click();

  await expect(row).not.toContainText(/due now/i, { timeout: 20_000 });

  const posted = await api(page, 'GET', '/expenses', { params: { search: `${MARK} rent` } });
  expect(posted.body.pagination.total).toBe(1);
  const expense = posted.body.data[0];
  expect(parseFloat(expense.amount)).toBe(2500);
  expect(expense.recurring_id).toBe(tplId);
  ctx.made.expenses.push(expense.id);

  // The schedule advanced by exactly one month, from the date that was DUE.
  const after = await api(page, 'GET', '/expenses/recurring');
  const tpl = after.body.data.find((r) => r.id === tplId);
  expect(String(tpl.next_date).slice(0, 10)).toBe('2026-07-01');

  await api(page, 'DELETE', `/expenses/recurring/${tplId}`);
});

test('a budget shows what is left, and what is over', async ({ page }) => {
  await page.goto('/expenses');
  await page.getByTestId('expenses-tab-budgets').click();
  await expect(page.getByTestId('budget-table')).toBeVisible({ timeout: 20_000 });

  // June 2026, the month the seeded expenses fall in.
  await page.getByTestId('budget-month').fill('2026-06');
  const input = page.getByTestId(`budget-input-${ctx.categoryId}`);
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill('1000');
  await input.blur();

  const row = page.getByTestId(`budget-row-${ctx.categoryId}`);
  await expect(row).toBeVisible();
  await shot(page, 'budgets');

  const res = await api(page, 'GET', '/expenses/budgets', {
    params: { store_id: ctx.storeId, period_month: '2026-06-01' },
  });
  const budgetRow = res.body.data.rows.find((r) => r.category_id === ctx.categoryId);
  expect(budgetRow.budget).toBe(1000);
  // 175.50 + 100 + 100 from the tests above.
  expect(budgetRow.actual).toBeCloseTo(375.5, 2);
  expect(budgetRow.variance).toBeCloseTo(624.5, 2);

  await api(page, 'PUT', '/expenses/budgets', {
    body: { store_id: ctx.storeId, category_id: ctx.categoryId, period_month: '2026-06-01', amount: 0 },
  });
});

// ---------------------------------------------------------------- loans

test('THE BUG: a loan can actually be created from the form', async ({ page }) => {
  await page.goto('/loans');
  await page.getByTestId('add-loan').click();
  const form = page.getByTestId('loan-form');
  await expect(form).toBeVisible();

  // "Someone else" — a borrower who is not a system user, which the API used to refuse
  // outright even though the table has always had a free-text name for it.
  await form.getByTestId('borrower-mode-other').click();
  await form.getByTestId('borrower-name').fill(`${MARK} Customer`);
  await form.getByTestId('loan-amount').fill('1200');
  await form.getByTestId('loan-due-date').fill('2026-06-01');
  await form.getByTestId('loan-save').click();

  const row = page.locator('[data-testid^="loan-row-"]').filter({ hasText: `${MARK} Customer` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await shot(page, 'loan-created');

  const list = await api(page, 'GET', '/loans', { params: { search: MARK } });
  const loan = list.body.data.find((l) => l.borrower_name === `${MARK} Customer`);
  expect(loan, 'the loan was not created').toBeTruthy();
  expect(loan.borrower_user_id).toBeNull();
  ctx.made.loans.push(loan.id);
});

test('a loan past its due date reads as overdue', async ({ page }) => {
  await page.goto('/loans');
  const row = page.locator('[data-testid^="loan-row-"]').filter({ hasText: `${MARK} Customer` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // 2026-06-01 is in the past, so this is overdue — derived from the date on every
  // read, never stored, so it cannot be stale.
  await expect(row).toContainText(/overdue/i);

  await page.getByTestId('loan-overdue-only').check();
  await expect(row).toBeVisible({ timeout: 20_000 });

  const totals = await api(page, 'GET', '/loans/outstanding');
  expect(totals.body.data.overdue).toBeGreaterThanOrEqual(1200);
  expect(totals.body.data.overdue_count).toBeGreaterThanOrEqual(1);
});

test('an instalment plan splits the loan and settles oldest-first', async ({ page }) => {
  await page.goto('/loans');
  const row = page.locator('[data-testid^="loan-row-"]').filter({ hasText: `${MARK} Customer` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  const detail = page.getByTestId('loan-detail');
  await expect(detail).toBeVisible();
  await detail.getByTestId('plan-count').fill('3');
  await detail.getByTestId('save-plan').click();

  await expect(detail.getByTestId('installment-1')).toBeVisible({ timeout: 20_000 });
  await expect(detail.getByTestId('installment-3')).toBeVisible();
  await shot(page, 'loan-installments');

  // Pay the first instalment exactly.
  await detail.getByTestId('add-loan-payment').click();
  await detail.getByTestId('payment-amount').fill('400');
  await detail.getByTestId('payment-save').click();

  await expect(detail.getByTestId('installment-1')).toContainText(/settled/i, { timeout: 20_000 });
  await expect(detail.getByTestId('installment-3')).not.toContainText(/settled/i);

  const loanId = ctx.made.loans[0];
  const full = await api(page, 'GET', `/loans/${loanId}`);
  const sum = full.body.data.installments.reduce((n, i) => n + parseFloat(i.amount), 0);
  expect(sum, 'the schedule must sum to the loan exactly').toBeCloseTo(1200, 2);
  expect(full.body.data.status).toBe('partial');
});

test('a loan cannot be overpaid, or deleted with payments against it', async ({ page }) => {
  await page.goto('/');
  const loanId = ctx.made.loans[0];

  const over = await api(page, 'POST', `/loans/${loanId}/payments`, {
    body: { amount: 99999, payment_date: '2026-06-10' },
  });
  expect(over.status).toBe(400);
  expect(JSON.stringify(over.body)).toMatch(/exceeds remaining/i);

  const del = await api(page, 'DELETE', `/loans/${loanId}`);
  expect(del.status).toBe(400);
  expect(JSON.stringify(del.body)).toMatch(/payment/i);

  // Clear the payment so afterAll can remove the loan.
  const full = await api(page, 'GET', `/loans/${loanId}`);
  for (const p of full.body.data.payments) {
    await api(page, 'DELETE', `/loans/${loanId}/payments/${p.id}`);
  }
});

test('the dashboard surfaces overdue loans and recurring costs that are due', async ({ page }) => {
  await page.goto('/');
  const data = await api(page, 'GET', '/reports/dashboard-admin');
  expect(data.status).toBe(200);
  expect(Array.isArray(data.body.data.overdue_loans)).toBe(true);
  expect(Array.isArray(data.body.data.due_recurring)).toBe(true);
  expect(data.body.data.overdue_loans.some((l) => l.borrower_name === `${MARK} Customer`)).toBe(true);

  await expect(page.getByTestId('overdue-loans-tile')).toBeVisible({ timeout: 25_000 });
  await shot(page, 'dashboard-overdue');
});
