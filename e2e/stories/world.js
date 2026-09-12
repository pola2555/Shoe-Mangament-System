import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';

/** The world stories.setup.js built. */
export function loadWorld() {
  const file = path.join(process.cwd(), 'e2e', '.stories', 'world.json');
  if (!fs.existsSync(file)) {
    throw new Error('e2e/.stories/world.json missing — the stories-setup project has not run.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A page logged in as one of the cast.
 *
 * Storage state rather than a login per test: even the raised login limiter would be
 * exhausted by sixty stories each signing in, and the failure looks like missing data
 * rather than like a rate limit.
 */
export async function pageAs(browser, who, opts = {}) {
  const ctx = await browser.newContext({
    storageState: path.join(process.cwd(), 'e2e', '.auth', `${who}.json`),
    ...opts,
  });
  const page = await ctx.newPage();
  page._storyContext = ctx;
  return page;
}

export async function closePage(page) {
  await page._storyContext?.close();
}

/**
 * One in-stock pair of a product in a branch, excluding anything already claimed.
 *
 * Stories consume stock, so picking "the first row" twice in one file hands the same
 * physical pair to two sales — which then fails for a reason that has nothing to do
 * with what the story was testing.
 */
export async function takePair(api, page, { storeId, productId, exclude = new Set(), size }) {
  const res = await api(page, 'GET', '/inventory', {
    params: { store_id: storeId, product_id: productId, status: 'in_stock', limit: '200' },
  });
  const pair = (res.body.data || []).find((i) =>
    !exclude.has(i.id) && (size === undefined || i.size_eu === size));
  expect(pair, `no free pair of ${productId} left in ${storeId}`).toBeTruthy();
  exclude.add(pair.id);
  return pair;
}

/**
 * What the till would actually charge for this pair.
 *
 * The BRANCH price wins over the catalogue price, and since PLAN 3 only somebody with
 * `price_override` may charge anything else. So a story that hard-codes the catalogue
 * figure is refused the moment a branch sets its own — which is the feature working,
 * not the story failing. `takePair` returns the inventory row, and that row already
 * carries both.
 */
export function priceOf(pair, fallback) {
  const value = pair?.store_selling_price ?? pair?.default_selling_price;
  return value === null || value === undefined ? fallback : Number(value);
}

/** Ring a sale straight through the API, for stories whose subject is what happens next. */
export async function ringSale(api, page, { storeId, items, customerId, payments, discount }) {
  return api(page, 'POST', '/sales', {
    body: {
      store_id: storeId,
      ...(customerId ? { customer_id: customerId } : {}),
      ...(discount ? { discount_amount: discount } : {}),
      items,
      payments: payments || [{
        amount: items.reduce((n, i) => n + i.sale_price, 0) - (discount || 0),
        payment_method: 'cash',
      }],
    },
  });
}

/** Undo everything a story created, so the next run starts where this one did. */
export async function cleanup(api, page, { saleIds = [], expenseIds = [], loanIds = [], transferIds = [] }) {
  for (const id of saleIds) {
    await api(page, 'POST', `/sales/${id}/void`, { body: { reason: 'story cleanup' } }).catch(() => {});
  }
  for (const id of transferIds) {
    await api(page, 'POST', `/transfers/${id}/cancel`).catch(() => {});
  }
  for (const id of expenseIds) {
    await api(page, 'DELETE', `/expenses/${id}`).catch(() => {});
  }
  for (const id of loanIds) {
    await api(page, 'DELETE', `/loans/${id}`).catch(() => {});
  }
}

/**
 * Pick an option in one of the app's SearchableSelects (react-select underneath).
 *
 * Driving the real control rather than writing the value into localStorage: the POS
 * persists its own store/customer/cart on a timer of its own, so a value poked into
 * storage is liable to be overwritten by the app a moment later — which looks exactly
 * like a bug in the feature under test and is not one.
 */
export async function pickOption(scope, text) {
  await scope.locator('.react-select__control').first().click();
  await scope.page().keyboard.type(text, { delay: 20 });
  const option = scope.page().locator('.react-select__option').first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}
