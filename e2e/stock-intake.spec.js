import { test, expect } from '@playwright/test';
import { api, shot, businessToday } from './helpers.js';

/**
 * ENTERING STOCK THE SHOP ALREADY OWNS, IN A REAL BROWSER.
 *
 * The service-level suite (`npm run check:intake`) already proves the money: that a
 * real invoice replaces a guess, that reported profit moves by exactly the difference
 * and comes back exactly on undo, and that a real cost is never rewritten. What it
 * cannot prove is that a person can actually do any of it — that the grid renders for
 * a shoe AND for a sock, that the guess is marked on screen, that Post is a separate
 * act from Save, and that the reports page says out loud when profit is provisional.
 *
 * Nothing here uploads an image. Local dev writes to a real S3 bucket.
 */


/** The scratch world, reused across runs so nothing accumulates. */
async function world(page) {
  const stores = await api(page, 'GET', '/stores');
  const store = stores.body.data[0];

  const products = await api(page, 'GET', '/products', { params: { is_active: 'true', limit: '200' } });
  const rows = products.body.data || [];
  // A product with colours and numeric sizes, and one with word sizes — the grid has to
  // serve both, and the sock is where "every product is a shoe" used to show up.
  const shoe = rows.find((p) => /shoe/i.test(p.model_name) || /shoe/i.test(p.category_name_en || ''))
    || rows[0];
  const sock = rows.find((p) => /sock/i.test(p.model_name) || /sock/i.test(p.category_name_en || ''));

  return { store, shoe, sock };
}

test.describe.configure({ mode: 'serial' });

const made = { sheets: [] };

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  for (const id of made.sheets) {
    await api(page, 'POST', `/stock-intakes/${id}/reverse`, { body: { reason: 'e2e cleanup' } }).catch(() => {});
    await api(page, 'DELETE', `/stock-intakes/${id}`).catch(() => {});
  }
  await page.close();
});

test('S1 · a sheet can be started, filled from a grid, and creates nothing until posted', async ({ page }) => {
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'intake-list');

  const { store, shoe } = await world(page);

  // Stock for this product BEFORE anything, so "a draft creates nothing" is measured
  // rather than assumed.
  const before = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, product_id: shoe.id, status: 'in_stock', limit: '500' },
  });
  const beforeCount = (before.body.data || []).length;

  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const id = page.url().split('/').pop();
  made.sheets.push(id);

  await expect(page.getByText(/^Draft$/i).first()).toBeVisible();

  // Pick the product through the real control. The cost hint fires on selection.
  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(shoe.product_code, { delay: 20 });
  const option = page.locator('.react-select__option').first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();

  // The colour x size grid must appear with real cells.
  const cells = page.locator('.intake-cell');
  await expect(cells.first()).toBeVisible({ timeout: 20_000 });
  expect(await cells.count()).toBeGreaterThan(0);
  await shot(page, 'intake-grid');

  // A cost is required; fill one and type two quantities.
  await page.locator('input[type="number"]').first().fill('250');

  // The hint ticks "I know this cost" whenever the system already holds an invoiced
  // cost for the product — correct, and exactly why it has to be unticked here: this
  // suite is about the GUESS path, which is what opening stock actually is.
  const known = page.locator('.intake-known input[type="checkbox"]');
  if (await known.isChecked()) await known.uncheck();
  await expect(page.locator('.intake-add')).toContainText(/marked as a guess/i);

  await cells.nth(0).fill('2');
  if (await cells.count() > 1) await cells.nth(1).fill('1');

  await page.getByRole('button', { name: /add to sheet/i }).click();
  const linesTable = page.getByTestId('intake-lines');
  await expect(linesTable).toBeVisible({ timeout: 10_000 });
  // The line must say on its face that its cost is a guess.
  await expect(linesTable).toContainText(/guess/i);

  // Saving a DRAFT must still create no stock. This is the whole point of the split.
  await page.getByRole('button', { name: /save draft/i }).click();
  await expect(page.getByTestId('intake-lines')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);

  const afterDraft = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, product_id: shoe.id, status: 'in_stock', limit: '500' },
  });
  expect((afterDraft.body.data || []).length, 'a draft must not create stock').toBe(beforeCount);
});

test('S2 · posting creates the stock, and the pairs are marked as a guess', async ({ page }) => {
  await page.goto(`/stock-intakes/${made.sheets[0]}`);
  const { store, shoe } = await world(page);

  const before = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, product_id: shoe.id, status: 'in_stock', limit: '500' },
  });
  const beforeCount = (before.body.data || []).length;

  await page.getByRole('button', { name: /post/i }).first().click();
  await expect(page.getByText(/^Posted$/i).first()).toBeVisible({ timeout: 25_000 });
  await shot(page, 'intake-posted');

  const after = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, product_id: shoe.id, status: 'in_stock', limit: '500' },
  });
  expect((after.body.data || []).length, 'posting must create the stock').toBeGreaterThan(beforeCount);

  // Every pair it made carries the guessed-cost mark.
  const sheet = await api(page, 'GET', `/stock-intakes/${made.sheets[0]}`);
  expect(sheet.body.data.status).toBe('posted');
  expect(sheet.body.data.estimated_units).toBeGreaterThan(0);

  // And it appears on the list WITH its totals. The list runs its own grouped
  // aggregate, and a broken one there fails silently behind a toast while every other
  // assertion on this page still passes.
  await page.goto('/stock-intakes');
  const row = page.getByTestId(`intake-row-${made.sheets[0]}`);
  await expect(row).toBeVisible({ timeout: 25_000 });
  await expect(row).toContainText(/posted/i);
  await expect(row, 'the list must show the sheet totals').toContainText(/EGP/);
  await expect(row, 'and how many of its pairs rest on a guess').toContainText(/guessed/i);
});

test('S3 · a posted sheet cannot be edited, and says so', async ({ page }) => {
  await page.goto(`/stock-intakes/${made.sheets[0]}`);
  await expect(page.getByText(/^Posted$/i).first()).toBeVisible({ timeout: 25_000 });

  // The add-stock panel is gone entirely — not merely disabled, since a control that
  // looks live and then 400s is worse than one that is not there.
  await expect(page.locator('.intake-add')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /save draft/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /reverse this sheet/i })).toBeVisible();

  const res = await api(page, 'PUT', `/stock-intakes/${made.sheets[0]}`, { body: { notes: 'nope' } });
  expect(res.status, 'the server must refuse too, not just the screen').toBe(400);
});

test('S4 · the guess shows up on the reports page as a note under the profit', async ({ page }) => {
  // Navigate first: api() reads the token out of localStorage, which about:blank has no
  // access to at all.
  await page.goto('/');
  const { store, shoe } = await world(page);

  // Sell one of the guessed pairs so the period actually contains estimated profit.
  const stock = await api(page, 'GET', '/inventory', {
    params: { store_id: store.id, product_id: shoe.id, status: 'in_stock', limit: '500' },
  });
  const pair = (stock.body.data || []).find((i) => i.cost_is_estimated);
  expect(pair, 'no guessed pair to sell').toBeTruthy();

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: store.id,
      items: [{ id: pair.id, sale_price: Number(shoe.default_selling_price) || 500 }],
      payments: [{ amount: Number(shoe.default_selling_price) || 500, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);

  const today = businessToday();
  const basis = await api(page, 'GET', '/reports/cost-basis', {
    params: { startDate: today, endDate: today, store_id: store.id },
  });
  expect(basis.status).toBe(200);
  expect(basis.body.data.estimated_items).toBeGreaterThan(0);

  await page.goto('/reports');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  const note = page.getByTestId('cost-basis-note');
  await expect(note, 'the reports page must say the profit is provisional').toBeVisible({ timeout: 25_000 });
  await expect(note).toContainText(/estimated cost/i);
  await shot(page, 'intake-reports-note');

  // Put the sale back so the run leaves nothing behind.
  await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'e2e cleanup' } });
});

test('S5 · a sock offers its own size words, not shoe numbers', async ({ page }) => {
  await page.goto('/stock-intakes');
  const { sock } = await world(page);
  test.skip(!sock, 'no word-sized product in this catalogue');

  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  made.sheets.push(page.url().split('/').pop());

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(sock.product_code, { delay: 20 });
  await expect(page.locator('.react-select__option').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.react-select__option').first().click();

  await expect(page.locator('.intake-cell').first()).toBeVisible({ timeout: 20_000 });

  // The size headers must come from the sock's own list. A shoe's EU numbers appearing
  // here is the exact assumption the categories work removed everywhere else.
  const headers = await page.locator('.intake-grid thead th').allInnerTexts();
  const sizeHeaders = headers.slice(1).map((h) => h.trim()).filter(Boolean);
  expect(sizeHeaders.length).toBeGreaterThan(0);
  expect(sizeHeaders.join(' '), 'a sock must not be sized in EU numbers').not.toMatch(/\bEU\s*4\d/);
  await shot(page, 'intake-sock-sizes');
});

test('S6 · the "still a guess" tab lists what has not been confirmed', async ({ page }) => {
  await page.goto('/stock-intakes');
  await page.getByTestId('intake-tab-estimated').click();
  await page.waitForTimeout(1500);

  const body = await page.locator('.tab-content').innerText();
  // Either it lists products, or it says plainly that nothing is a guess. A blank
  // panel would read as a broken screen.
  expect(body.trim().length, 'the tab must say something').toBeGreaterThan(10);
  await shot(page, 'intake-still-a-guess');

  const rows = await api(page, 'GET', '/stock-intakes/estimated');
  expect(rows.status).toBe(200);
  expect(Array.isArray(rows.body.data)).toBe(true);
});

test('S7 · the corrections tab exists and is readable', async ({ page }) => {
  await page.goto('/stock-intakes');
  await page.getByTestId('intake-tab-corrections').click();
  await page.waitForTimeout(1200);
  const body = await page.locator('.tab-content').innerText();
  expect(body.trim().length).toBeGreaterThan(10);
  await shot(page, 'intake-corrections');
});

test('S8 · nothing on these screens is untranslated or overflows on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });

  for (const route of ['/stock-intakes', `/stock-intakes/${made.sheets[0]}`]) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    // A raw dotted key on screen is a missing translation, and it is the only way one
    // ever shows up.
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
  await shot(page, 'intake-phone');
});
