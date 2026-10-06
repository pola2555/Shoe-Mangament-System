import { test, expect } from '@playwright/test';
import { api, shot, businessToday } from './helpers.js';

/**
 * THE PRINT QUEUE, IN A REAL BROWSER.
 *
 * `npm run check:print-queue` already proves the rules — that a document replaces its
 * own rows so the prompt cannot double the paper, that the queue is scoped to a branch,
 * that the permission is separable from `barcodes`. None of that says a person can
 * actually do the job, and the job is a sequence of dialogs:
 *
 *     complete a box → "shall I queue these?" → the queue page → print → "did they
 *     come out?" → the printed list
 *
 * Every step of that is a place where a prop can be missing and nothing throws. So this
 * walks it, as the operator, and asserts the numbers on screen at each step.
 *
 * It also checks the two things that are invisible until somebody else logs in: that a
 * user without `print_queue` has no link and cannot reach the URL, and that the whole
 * page reads in Arabic and fits a phone.
 *
 * Nothing here uploads an image. Local dev writes to a real S3 bucket.
 */

test.describe.configure({ mode: 'serial' });

const made = { invoices: [], queue: [], users: [] };

/** A product with colours and numeric sizes, plus the first branch. */
async function world(page) {
  const stores = await api(page, 'GET', '/stores');
  const store = (stores.body.data || [])[0];

  const products = await api(page, 'GET', '/products', {
    params: { is_active: 'true', limit: '200' },
  });
  const rows = products.body.data || [];

  // Needs a colour to receive against, so pick one that has one.
  for (const p of rows) {
    const colors = await api(page, 'GET', `/products/${p.id}/colors`);
    const list = colors.body.data || [];
    const usable = list.find((c) => !c.is_placeholder) || list[0];
    if (usable) return { store, product: p, color: usable };
  }
  throw new Error('no product with a colour in the catalogue');
}

/** Receive `qty` pairs of one size through a real purchase box, and return its id. */
async function receiveBox(page, { store, product, color, size, qty }) {
  const inv = await api(page, 'POST', '/purchases/invoices', {
    body: {
      supplier_id: (await api(page, 'GET', '/suppliers')).body.data[0].id,
      total_amount: qty * 100,
      invoice_date: businessToday(),
      boxes: [{
        product_id: product.id,
        cost_per_item: 100,
        total_items: qty,
        destination_store_id: store.id,
      }],
    },
  });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  made.invoices.push(inv.body.data.id);

  const full = await api(page, 'GET', `/purchases/invoices/${inv.body.data.id}`);
  const box = (full.body.data.boxes || [])[0];
  await api(page, 'PUT', `/purchases/boxes/${box.id}/items`, {
    body: { items: [{ product_color_id: color.id, size_eu: size, quantity: qty }] },
  });
  return { invoiceId: inv.body.data.id, boxId: box.id };
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  // The queue first: its rows reference variants, and clearing them is harmless.
  for (const status of ['pending', 'done']) {
    await api(page, 'POST', '/print-queue/clear', { body: { status } }).catch(() => {});
  }
  for (const id of made.invoices) {
    await api(page, 'DELETE', `/purchases/invoices/${id}`).catch(() => {});
  }
  await page.close();
});

test('Q1 · the page explains itself and starts empty', async ({ page }) => {
  // Start from a known state so the counts later are the ones this run created.
  await page.goto('/');
  await api(page, 'POST', '/print-queue/clear', { body: { status: 'pending' } });
  await api(page, 'POST', '/print-queue/clear', { body: { status: 'done' } });

  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-explainer')).toBeVisible({ timeout: 30_000 });
  // The whole feature rests on people knowing the queue fills itself.
  await expect(page.getByTestId('pq-explainer')).toContainText(/fills itself/i);
  await expect(page.getByTestId('pq-empty')).toBeVisible();
  await shot(page, 'pq-empty');
});

let boxId;
let variantSize;

test('Q2 · completing a purchase box offers its labels, and adding puts them on the queue', async ({ page }) => {
  await page.goto('/');
  const { store, product, color } = await world(page);
  variantSize = '41';
  const box = await receiveBox(page, { store, product, color, size: variantSize, qty: 4 });
  boxId = box.boxId;

  await page.goto(`/purchases/${box.invoiceId}`);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Complete the box through the real button. The app confirms with window.confirm.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /complete box/i }).first().click();

  // THE PROMPT. This is the feature's entry point — if it does not open, nothing else
  // in the queue ever happens on its own.
  const prompt = page.getByTestId('add-to-print-queue');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  // One label per pair received, offered without anybody counting.
  await expect(page.getByTestId('pq-total')).toContainText('4');
  await shot(page, 'pq-prompt');

  await page.getByTestId('pq-add').click();
  await expect(prompt).toBeHidden({ timeout: 15_000 });

  const rows = await api(page, 'GET', '/print-queue');
  expect(rows.status).toBe(200);
  const mine = (rows.body.data || []).filter((r) => r.source_id === boxId);
  expect(mine.length).toBe(1);
  expect(mine[0].quantity).toBe(4);
  made.queue.push(mine[0].id);
});

test('Q3 · answering the prompt again does not double the paper', async ({ page }) => {
  // The load-bearing rule, exercised the way it actually breaks: somebody re-opens the
  // dialog for a box they already answered.
  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-explainer')).toBeVisible({ timeout: 30_000 });

  const again = await api(page, 'POST', '/print-queue/from-source', {
    body: { source_type: 'purchase_box', source_id: boxId },
  });
  expect(again.status).toBe(201);

  const rows = await api(page, 'GET', '/print-queue');
  const mine = (rows.body.data || []).filter((r) => r.source_id === boxId);
  expect(mine.length).toBe(1);
  expect(mine[0].quantity).toBe(4);
});

test('Q4 · the queue lists what is owed, and the sidebar says how much', async ({ page }) => {
  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId('pq-row')).toHaveCount(1);
  // Where it came from is on the row — that is what makes the list readable a day later.
  await expect(page.getByTestId('pq-row').first()).toContainText(/purchase/i);

  // Same contract, from the other side: the badge is the server's count, and this run
  // put exactly 4 labels on it.
  const owed = (await api(page, 'GET', '/print-queue/summary')).body.data.labels;
  expect(owed, 'this run queued 4 labels').toBe(4);
  const badge = page.getByTestId('sidebar-print-queue-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('4');
  await shot(page, 'pq-listed');
});

test('Q5 · marking printed moves the row to the printed list, and back again', async ({ page }) => {
  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('pq-select-row').first().check();
  await page.getByTestId('pq-mark-selected').click();

  // Off the pending list...
  await expect(page.getByTestId('pq-empty')).toBeVisible({ timeout: 20_000 });

  // ...and the badge follows, without a reload. Asserted against the server's own count
  // rather than against zero: the contract is "the badge says what is owed", and a row
  // left behind by another spec would otherwise fail this as though the badge were
  // broken when it was telling the truth.
  const owed = (await api(page, 'GET', '/print-queue/summary')).body.data.labels;
  const badge = page.getByTestId('sidebar-print-queue-badge');
  if (owed === 0) await expect(badge).toBeHidden();
  else await expect(badge).toHaveText(String(owed > 99 ? '99+' : owed));

  // ...and onto the printed one.
  await page.getByTestId('pq-tab-done').click();
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, 'pq-printed');

  // A jammed run can be sent again.
  await page.getByTestId('pq-requeue').first().click();
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 20_000 });
  const rows = await api(page, 'GET', '/print-queue');
  const back = (rows.body.data || []).filter((r) => r.source_type === 'manual');
  expect(back.length).toBe(1);
  expect(back[0].quantity).toBe(4);
});

test('Q6 · the print dialog opens with the copies the queue owes, not the stock on hand', async ({ page }) => {
  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('pq-print-all').click();

  // The label dialog is lazy-loaded; wait for its own controls.
  await expect(page.getByTestId('label-size')).toBeVisible({ timeout: 30_000 });
  // "Match queue" only exists when the dialog was opened from the queue — it is the
  // visible proof it is reading the queue's numbers rather than inventory's.
  await expect(page.getByTestId('label-match-queue')).toBeVisible();
  // Scoped to the dialog: the "To print" tab carries the same count in its pill, so
  // an unscoped match is ambiguous rather than wrong.
  const dialog = page.locator('.modal-content').filter({ has: page.getByTestId('label-size') });
  await expect(dialog.getByRole('button', { name: /^print 4 label/i })).toBeVisible();
  await shot(page, 'pq-print-dialog');
});

test('Q6b · after printing, the "did they come out?" question is on top and answerable', async ({ page }) => {
  // Every overlay in the app shares one z-index, so which of two lands on top comes
  // down to document order — and the print dialog portals into <body>, AFTER the
  // confirm dialog, which renders inline in #root. The question was therefore drawn
  // behind the dialog that asked it: in the DOM, invisible, impossible to answer.
  //
  // Asserted by clicking it rather than by reading a z-index, because "on top" only
  // means anything if the button actually receives the click.
  await page.goto('/print-queue');
  await expect(page.getByTestId('pq-row').first()).toBeVisible({ timeout: 30_000 });

  const before = (await api(page, 'GET', '/print-queue/summary')).body.data.labels;
  expect(before, 'nothing owed, so there is nothing to print').toBeGreaterThan(0);

  await page.getByTestId('pq-print-all').click();
  await expect(page.getByTestId('label-size')).toBeVisible({ timeout: 30_000 });

  // window.print() is a no-op under automation, so this reaches onPrinted normally.
  const dialog = page.locator('.modal-content').filter({ has: page.getByTestId('label-size') });
  await dialog.getByRole('button', { name: /^print \d+ label/i }).click();

  const confirmBox = page.getByTestId('confirm-dialog');
  await expect(confirmBox).toBeVisible({ timeout: 15_000 });
  await shot(page, 'pq-mark-printed-confirm');

  // The real test: the button takes the click instead of the print overlay swallowing
  // it. Playwright's actionability check fails outright if something covers it.
  await confirmBox.getByRole('button', { name: /mark printed/i }).click();
  await expect(confirmBox).toBeHidden({ timeout: 15_000 });

  const after = (await api(page, 'GET', '/print-queue/summary')).body.data.labels;
  expect(after, 'answering the question did not record the print').toBe(0);
});

test('Q7 · posting a stock entry sheet offers its labels too', async ({ page }) => {
  await page.goto('/');
  const { store, product, color } = await world(page);

  const sheet = await api(page, 'POST', '/stock-intakes', {
    body: {
      store_id: store.id,
      reason: 'opening',
      intake_date: businessToday(),
      lines: [{
        product_id: product.id,
        product_color_id: color.id,
        size_eu: '43',
        quantity: 2,
        unit_cost: 120,
        cost_is_estimated: true,
      }],
    },
  });
  expect(sheet.status).toBe(201);
  const id = sheet.body.data.id;

  await page.goto(`/stock-intakes/${id}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: /post .* create the stock/i }).first().click();

  const prompt = page.getByTestId('add-to-print-queue');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pq-total')).toContainText('2');
  await shot(page, 'pq-prompt-intake');

  // Dismissing must add nothing — the offer is an offer.
  const before = await api(page, 'GET', '/print-queue');
  await page.getByTestId('pq-not-now').click();
  await expect(prompt).toBeHidden();
  const after = await api(page, 'GET', '/print-queue');
  expect((after.body.data || []).length).toBe((before.body.data || []).length);

  // Clean up the sheet's stock so the run leaves nothing behind.
  await api(page, 'POST', `/stock-intakes/${id}/reverse`, { body: { reason: 'e2e cleanup' } });
  await api(page, 'DELETE', `/stock-intakes/${id}`);
});

test('Q8 · a person without the permission has no link and cannot reach the URL', async ({ browser }) => {
  const admin = await browser.newPage();
  await admin.goto('/');

  // Somebody who can receive stock but has not been given the queue.
  const username = 'e2e_pq_none';
  const password = 'Scratch!2345';
  const users = await api(admin, 'GET', '/users');
  let user = (users.body.data || []).find((u) => u.username === username);
  if (!user) {
    const made2 = await api(admin, 'POST', '/users', {
      body: {
        username, password, email: `${username}@example.com`,
        full_name: 'E2E no queue', role_id: 3,
      },
    });
    expect(made2.status, JSON.stringify(made2.body)).toBe(201);
    user = made2.body.data;
  } else {
    await api(admin, 'PUT', `/users/${user.id}`, { body: { password, is_active: true } });
  }
  made.users.push(user.id);
  await api(admin, 'PUT', `/users/${user.id}/permissions`, {
    body: { permissions: [{ code: 'inventory', access_level: 'write' }, { code: 'products', access_level: 'read' }] },
  });

  // An empty storage state, deliberately: the project ships the admin session, and a
  // context that inherits it is redirected off /login before the form ever renders.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20_000 });

  // No link in the menu...
  await expect(page.getByRole('link', { name: /print queue/i })).toHaveCount(0);

  // ...and typing the address goes nowhere. The permission is the control; this is the
  // menu and the address bar agreeing with it.
  await page.goto('/print-queue');
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe('/');
  await shot(page, 'pq-no-permission');

  // And the API refuses it too, which is the part that actually matters.
  const denied = await api(page, 'GET', '/print-queue');
  expect(denied.status).toBe(403);

  await ctx.close();
  await api(admin, 'DELETE', `/users/${user.id}`).catch(() => {});
  await admin.close();
});

test('Q9 · nothing is untranslated, in either language, and it fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });

  for (const locale of ['en', 'ar']) {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle').catch(() => {});
    // Through Settings, not localStorage: AuthContext pushes the user's server-side
    // preference over a hand-set value on every load.
    const select = page.locator('select').filter({ hasText: /english|العربية/i }).first();
    if (await select.count()) {
      await select.selectOption(locale).catch(() => {});
      await page.waitForTimeout(800);
    }

    for (const tab of ['pending', 'done']) {
      await page.goto('/print-queue');
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.getByTestId(`pq-tab-${tab}`).click().catch(() => {});
      await page.waitForTimeout(900);

      const raw = await page.evaluate(() => {
        const found = new Set();
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
          const t = n.textContent.trim();
          if (/^[a-z_]+\.[a-z0-9_.]+$/.test(t)) found.add(t);
        }
        return [...found];
      });
      expect(raw, `${locale}/${tab} has untranslated keys`).toEqual([]);

      const braces = await page.evaluate(() =>
        (document.body.innerText.match(/\{[a-z_]+\}/g) || []).slice(0, 5));
      expect(braces, `${locale}/${tab} has unfilled placeholders`).toEqual([]);

      const { overflow, culprit } = await page.evaluate(() => {
        const d = document.documentElement;
        const over = d.scrollWidth - d.clientWidth;
        if (over <= 2) return { overflow: over, culprit: null };
        let worst = null;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          const past = Math.round(r.right - d.clientWidth);
          if (r.width && past > 2 && (!worst || past > worst.past)) {
            worst = { past, tag: el.tagName, cls: String(el.className).slice(0, 60) };
          }
        }
        return { overflow: over, culprit: worst };
      });
      expect(overflow, `${locale}/${tab} overflows by ${overflow}px — ${JSON.stringify(culprit)}`)
        .toBeLessThanOrEqual(2);
    }

    await shot(page, `pq-phone-${locale}`);
  }

  // Leave the session in English for whatever runs next.
  await page.goto('/settings');
  const select = page.locator('select').filter({ hasText: /english|العربية/i }).first();
  if (await select.count()) await select.selectOption('en').catch(() => {});
});
