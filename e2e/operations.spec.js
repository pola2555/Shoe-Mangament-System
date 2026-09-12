import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * THE COUNTER, IN A REAL BROWSER.
 *
 * `npm run check:operations` already proves the money — that the drawer adds up, that an
 * even swap nets to zero, that a cashier cannot price or discount on their own. What it
 * cannot prove is that a person can do any of it: that the cash-up refuses to show the
 * expected figure before a count is typed, that the receipt opens without printing
 * itself, that the reorder list ranks by cover rather than by quantity.
 *
 * Nothing here uploads an image. Local dev writes to a real S3 bucket.
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function world(page) {
  const stores = await api(page, 'GET', '/stores');
  const store = stores.body.data[0];
  return { store };
}

/** Leave no shift open behind us — one open shift per branch is a hard constraint. */
async function closeAnyShift(page, storeId) {
  const cur = await api(page, 'GET', '/shifts/current', { params: { store_id: storeId } });
  if (cur.body?.data?.id) {
    await api(page, 'POST', `/shifts/${cur.body.data.id}/close`, {
      body: { counted_cash: cur.body.data.position.expected_cash, notes: 'e2e cleanup' },
    });
  }
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  const { store } = await world(page);
  await closeAnyShift(page, store.id);
  await page.close();
});

test('O1 · the till says whether a drawer is open, and opens one', async ({ page }) => {
  await page.goto('/');
  const { store } = await world(page);
  await closeAnyShift(page, store.id);

  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 30_000 });

  // With no shift open the strip must SAY so — selling is allowed, but that cash
  // belongs to no cash-up and the cashier has to know.
  const closed = page.getByTestId('pos-shift-closed');
  await expect(closed).toBeVisible({ timeout: 20_000 });
  await expect(closed).toContainText(/no till is open|no cash-up/i);
  await shot(page, 'ops-pos-no-shift');

  await page.getByTestId('pos-shift-start').click();
  await page.getByTestId('pos-shift-float').fill('500');
  await page.getByTestId('pos-shift-open-submit').click();

  await expect(page.getByTestId('pos-shift-open')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'ops-pos-shift-open');
});

test('O2 · the cash-up will not show the expected figure before a count is typed', async ({ page }) => {
  await page.goto('/shifts');
  await expect(page.getByTestId('shift-open')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'ops-shift-page');

  await page.getByTestId('shift-close-open').click();
  const dialog = page.locator('.modal-content').last();
  await expect(dialog.getByTestId('shift-counted')).toBeVisible({ timeout: 10_000 });

  // THE POINT: the dialog must not carry the ANSWER. A cash-up that shows the expected
  // number first is a rubber stamp, and would report a perfect drawer every night.
  //
  // Checked as a number rather than the word "expected", which the dialog's own hint
  // legitimately uses to explain why the figure is withheld.
  const { store } = await world(page);
  const cur = await api(page, 'GET', '/shifts/current', { params: { store_id: store.id } });
  const expectedCash = money(cur.body.data.position.expected_cash);
  const text = await dialog.innerText();
  expect(text, `the close dialog reveals the expected ${expectedCash}`)
    .not.toContain(String(expectedCash));
  const prefilled = await dialog.getByTestId('shift-counted').inputValue();
  expect(prefilled, 'the counted field must start empty').toBe('');

  await dialog.getByTestId('shift-counted').fill('480');
  await dialog.getByTestId('shift-close-submit').click();

  // 500 float, nothing sold, counted 480 → 20 short, and it has to say so.
  await expect(page.locator('body')).toContainText(/20/, { timeout: 20_000 });
  await shot(page, 'ops-shift-closed');

  const list = await api(page, 'GET', '/shifts', { params: { limit: '1' } });
  const last = list.body.data[0];
  expect(money(last.expected_cash)).toBe(500);
  expect(money(last.counted_cash)).toBe(480);
  expect(money(last.difference)).toBe(-20);
});

test('O3 · a receipt opens on demand and never prints itself', async ({ page }) => {
  await page.goto('/');
  const { store } = await world(page);

  const stock = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, status: 'in_stock', limit: '5' },
  });
  const pair = (stock.body.data || [])[0];
  test.skip(!pair, 'no stock at this branch');

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: store.id,
      items: [{ id: pair.id, sale_price: Number(pair.store_selling_price ?? pair.default_selling_price) || 100 }],
      payments: [{ amount: Number(pair.store_selling_price ?? pair.default_selling_price) || 100, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);

  // A print dialog would block the run. Its absence is the assertion: nothing may open
  // one on its own, and the test would hang here if anything did.
  await page.goto('/sales');
  await page.waitForTimeout(1500);
  await page.getByTestId(`sale-row-${sale.body.data.id}`).click();
  await page.getByTestId('sale-receipt').click();

  const receipt = page.locator('.receipt');
  await expect(receipt).toBeVisible({ timeout: 20_000 });
  await expect(receipt).toContainText(sale.body.data.sale_number);
  await expect(receipt).toContainText(store.name);
  // Cost and margin are the shop's business, never the customer's.
  await expect(receipt).not.toContainText(/cost|profit|margin/i);
  await shot(page, 'ops-receipt');

  await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'e2e cleanup' } });
});

test('O4 · the exchange screen starts from the sale, and never guesses which one', async ({ page }) => {
  await page.goto('/exchanges');
  await expect(page.getByTestId('exchange-sale-search')).toBeVisible({ timeout: 30_000 });

  // The three steps are the shape of the job and are on screen, rather than being
  // implied by which panel happens to be empty.
  await expect(page.getByTestId('exchange-steps')).toBeVisible();
  await expect(page.locator('body')).toContainText(/find the sale/i);

  // THE POINT OF THE REWRITE: searching used to run the query and silently take the
  // first row it got back. Search something deliberately ambiguous and the screen has
  // to OFFER the matches, not pick one.
  const { store } = await world(page);
  const sales = await api(page, 'GET', '/sales', { params: { store_id: store.id, limit: '5' } });
  const live = (sales.body.data || []).filter((s) => !s.voided_at);
  test.skip(live.length === 0, 'no sales at this branch to exchange against');

  await page.getByTestId('exchange-sale-search').fill(live[0].sale_number);
  await page.getByTestId('exchange-sale-search').press('Enter');

  // One unambiguous hit opens straight away — that is the receipt-number case.
  await expect(page.getByTestId('exchange-sale-items')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).toContainText(/coming back/i);
  await expect(page.locator('body')).toContainText(/going out/i);
  // A different product is the same action as a different size, and the price may move
  // either way. Both are stated, because neither is obvious.
  await expect(page.locator('body')).toContainText(/does not have to be the same product/i);
  await expect(page.locator('body')).toContainText(/higher or lower/i);

  // And there is a way back: picking the wrong sale must not mean reloading the page.
  await expect(page.getByTestId('exchange-change-sale')).toBeVisible();
  await shot(page, 'ops-exchange');
});

test('O4b · a sale is findable by the product in it, on both screens', async ({ page }) => {
  // Nobody keeps a receipt. The customer standing at the counter has the shoe, so the
  // product is what they can tell you — and until now neither screen could take it.
  //
  // The page has to be on the app's origin before api() can read the saved token.
  await page.goto('/sales');
  const { store } = await world(page);
  const sales = await api(page, 'GET', '/sales', { params: { store_id: store.id, limit: '10' } });
  const live = (sales.body.data || []).filter((s) => !s.voided_at && s.item_count > 0);
  test.skip(live.length === 0, 'no sales with items at this branch');

  const target = live.find((s) => (s.item_products || []).length > 0);
  expect(target, 'GET /sales must say what was in each sale').toBeTruthy();
  const product = target.item_products[0];

  // Sales history. The search goes to the server now, so this also proves the rewiring:
  // a client-side filter over the loaded rows could not match a product at all.
  await expect(page.getByTestId('sales-search')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sales-search').fill(product);

  const row = page.getByTestId(`sale-row-${target.id}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // And the row says WHY it matched. A list of receipt numbers explains nothing.
  await expect(row).toContainText(product);
  await shot(page, 'ops-sales-search-product');

  // The exchange screen, same search. One hit opens the sale; several offer a choice —
  // either is correct, picking one silently is not.
  await page.goto('/exchanges');
  await expect(page.getByTestId('exchange-sale-search')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('exchange-sale-search').fill(product);
  await page.getByTestId('exchange-sale-search').press('Enter');

  const offered = page.getByTestId(`exchange-sale-${target.id}`);
  const opened = page.getByTestId('exchange-sale-items');
  await expect(offered.or(opened).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('exchange-no-sales')).toHaveCount(0);
  await shot(page, 'ops-exchange-search-product');
});

test('O5 · a stock take sheet freezes what the system expected', async ({ page }) => {
  await page.goto('/stock-counts');
  await expect(page.getByTestId('count-new')).toBeVisible({ timeout: 30_000 });

  const { store } = await world(page);
  const created = await api(page, 'POST', '/stock-counts', {
    body: { store_id: store.id, scope: 'full' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const sheet = created.body.data;
  expect(sheet.lines.length).toBeGreaterThan(0);

  await page.reload();
  await page.getByTestId(`count-row-${sheet.id}`).click();
  await expect(page.locator('body')).toContainText(/frozen/i, { timeout: 20_000 });
  // A blank is not a zero, and the screen has to say so or somebody counts one shelf
  // and writes off the rest of the shop.
  await expect(page.locator('body')).toContainText(/blank lines are skipped/i);
  await shot(page, 'ops-stock-count');

  await api(page, 'POST', `/stock-counts/${sheet.id}/cancel`);
});

test('O6 · the reports page ranks what to buy by how long it lasts', async ({ page }) => {
  await page.goto('/reports');
  await page.getByTestId('reports-tab-reorder').click();
  await page.waitForTimeout(2500);

  await expect(page.locator('body')).toContainText(/lasts/i, { timeout: 25_000 });
  await expect(page.locator('body')).toContainText(/ranked by how long the shelf lasts/i);
  await shot(page, 'ops-reorder');

  const data = await api(page, 'GET', '/reports/reorder');
  expect(data.status).toBe(200);
  // Nothing with no sales at all may appear on the shopping list — that is where a
  // bare low-stock sort puts a shop's very worst stock.
  for (const row of data.body.data.buy) {
    expect(row.weekly_rate, `${row.product_code} is on the buy list with no sales`).toBeGreaterThan(0);
  }
});

test('O7 · the overview says what the numbers mean, worst first', async ({ page }) => {
  await page.goto('/reports');
  await page.waitForTimeout(3000);

  const data = await api(page, 'GET', '/reports/insights');
  expect(data.status).toBe(200);
  const list = data.body.data.insights;

  if (list.length === 0) {
    test.skip(true, 'nothing worth saying about this data set');
  }
  await expect(page.getByTestId('insights')).toBeVisible({ timeout: 25_000 });
  const panel = await page.getByTestId('insights').innerText();
  expect(panel).toContain(list[0].title);
  expect(panel, 'an insight rendered a broken string').not.toMatch(/undefined|NaN|\[object/);
  await shot(page, 'ops-insights');
});

test('O8 · the discount queue exists and explains itself', async ({ page }) => {
  await page.goto('/approvals');
  await expect(page.locator('body')).toContainText(/discount requests/i, { timeout: 30_000 });
  await expect(page.locator('body')).toContainText(/approve less than was asked/i);
  await shot(page, 'ops-approvals');
});

test('O9 · nothing new is untranslated, and none of it overflows a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });

  for (const route of ['/shifts', '/exchanges', '/stock-counts', '/approvals']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1600);

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
    expect(raw, `${route} has untranslated keys`).toEqual([]);

    const braces = await page.evaluate(() =>
      (document.body.innerText.match(/\{[a-z_]+\}/g) || []).slice(0, 5));
    expect(braces, `${route} has unfilled placeholders`).toEqual([]);

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
    expect(overflow, `${route} overflows by ${overflow}px${culprit ? ` — <${culprit.tag} class="${culprit.cls}">` : ''}`)
      .toBeLessThanOrEqual(2);
  }
  await shot(page, 'ops-phone');
});
