import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * FIXING STOCK THAT WAS BOOKED IN UNDER THE WRONG COLOUR.
 *
 * `check:reassign` already proves the rules: that a sold pair never moves, that cost
 * and history survive, that oldest goes first, that another branch is untouched. What
 * it cannot prove is that somebody can actually do it from the inventory screen, and —
 * the thing the request was about — that the stock then APPEARS UNDER THE RIGHT
 * COLOUR in the tree afterwards.
 */

const MARK = 'E2E-REASSIGN';
let ctx = { storeId: null, productId: null, productCode: null, blackId: null, navyId: null, variantId: null };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = stores.body.data[0].id;

  const cats = await api(page, 'GET', '/product-categories');
  const shoes = cats.body.data.find((c) => c.code === 'shoes');

  // Reused across runs: a product can never be deleted (RESTRICT everywhere), so
  // minting one per run leaves junk behind that other specs then trip over.
  ctx.productCode = `${MARK}-FIX`;
  const existing = await api(page, 'GET', '/products', { params: { search: ctx.productCode } });
  const found = (existing.body.data || []).find((p) => p.product_code === ctx.productCode);

  if (found) {
    ctx.productId = found.id;
  } else {
    const res = await api(page, 'POST', '/products', {
      body: {
        product_code: ctx.productCode, model_name: 'reassign me',
        category_id: shoes.id, default_selling_price: 400, net_price: 150,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ctx.productId = res.body.data.id;
  }

  const colors = await api(page, 'GET', `/products/${ctx.productId}/colors`);
  const have = colors.body.data || [];
  const ensure = async (name) => {
    const hit = have.find((c) => c.color_name === name);
    if (hit) return hit.id;
    const r = await api(page, 'POST', `/products/${ctx.productId}/colors`, { body: { color_name: name } });
    return r.body.data.id;
  };
  ctx.blackId = await ensure('Fix Black');
  ctx.navyId = await ensure('Fix Navy');

  // One variant, Black 40, with stock on it.
  const variants = await api(page, 'GET', `/products/${ctx.productId}/variants`);
  let v = (variants.body.data || []).find(
    (x) => x.product_color_id === ctx.blackId && String(x.size_eu) === '40',
  );
  if (!v) {
    const r = await api(page, 'POST', `/products/${ctx.productId}/variants`, {
      body: { product_color_id: ctx.blackId, size_eu: '40' },
    });
    v = r.body.data;
  }
  ctx.variantId = v.id;

  // At least 3 on Black 40 to work with. Deliberately NOT "exactly 3": every
  // assertion below is a DELTA, so whatever a previous run left behind is harmless.
  // An earlier version reset the counts instead and got them wrong, which made the
  // test fail for reasons that had nothing to do with the feature.
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, status: 'in_stock', limit: '200' },
  });
  const short = 3 - (inv.body.data || []).length;
  if (short > 0) {
    await api(page, 'POST', '/inventory/manual', {
      body: { variant_id: ctx.variantId, store_id: ctx.storeId, cost: 150, quantity: short },
    });
  }

  await page.close();
});

/** In-stock pairs of this product at this branch, per colour name. */
async function countsByColor(page) {
  const res = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock', limit: '500' },
  });
  const out = {};
  for (const r of (res.body.data || [])) {
    out[r.color_name] = (out[r.color_name] || 0) + 1;
  }
  return out;
}

/** The inventory tree, expanded down to this product's size rows. */
async function openTree(page) {
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: /inventory/i }).first()).toBeVisible({ timeout: 30_000 });
  // Narrow to our product so the tree is small and unambiguous.
  const search = page.locator('input[type="search"], input[placeholder*="earch" i]').first();
  await search.fill(ctx.productCode);
  await page.waitForTimeout(900);              // the search is debounced
  await page.getByText(ctx.productCode).first().click();   // expand the product
}

test('R1 · stock booked under the wrong colour can be corrected from the tree', async ({ page }) => {
  await page.goto('/');
  // Measured before and after. An earlier version asserted absolute counts and so
  // passed on stock a previous run had already moved — it reported success while the
  // move under test had silently failed.
  ctx.before = await countsByColor(page);

  await openTree(page);

  // Expand the colour it is wrongly under.
  await page.getByText('Fix Black', { exact: true }).first().click();
  const edit = page.getByTestId(`inv-reassign-${ctx.variantId}`);
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await shot(page, 'inventory-before-fix');
  await edit.click();

  // The dialog says the two things that are not recoverable from the result: that only
  // in-stock pairs move, and that the printed labels are now wrong.
  await expect(page.getByTestId('reassign-label-warning')).toBeVisible();
  await expect(page.getByTestId('reassign-label-warning')).toContainText(/scan|reprint/i);

  // Pick the colour it should have been.
  //
  // Scoped to the dialog: the inventory page carries its own store and category
  // selects, so a bare `.react-select__control` finds the store filter behind the
  // overlay instead. The OPTIONS are matched at page level on purpose — the menu is
  // portalled onto document.body so it cannot be clipped, and is therefore not inside
  // .modal-content at all.
  const control = page.locator('.modal-content .react-select__control').first();
  await control.click();
  await page.locator('.react-select__option').filter({ hasText: 'Fix Navy' }).first().click();

  await page.getByTestId('reassign-quantity').fill('2');
  await page.getByTestId('reassign-reason').fill('booked in as Black by mistake');
  await shot(page, 'inventory-fix-dialog');
  await page.getByTestId('reassign-save').click();

  // Exactly two pairs changed colour: two fewer Black, two more Navy.
  const wantNavy = (ctx.before['Fix Navy'] || 0) + 2;
  await expect.poll(
    async () => (await countsByColor(page))['Fix Navy'] || 0,
    { timeout: 20_000, message: 'the two pairs never arrived on Navy' },
  ).toBe(wantNavy);

  const after = await countsByColor(page);
  expect(after['Fix Black'] || 0, 'Black should be down by exactly two').toBe((ctx.before['Fix Black'] || 0) - 2);
  ctx.afterNavy = after['Fix Navy'];
});

test('R2 · the tree now shows it under the colour it belongs to', async ({ page }) => {
  // A page with an origin first: api() reads the token out of localStorage, which a
  // fresh tab sitting on about:blank is not allowed to touch.
  await page.goto('/');
  // The request, in its own words: "it moves to the color section it's supposed to be
  // in". Asserted on the SUMMARY, which is what the tree is built from.
  const res = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, search: ctx.productCode, limit: '200' },
  });
  const mine = (res.body.data || []).filter((r) => r.product_id === ctx.productId);
  const navy = mine.find((r) => r.color_name === 'Fix Navy');
  expect(navy, 'nothing is listed under the new colour').toBeTruthy();
  expect(Number(navy.quantity)).toBe(ctx.afterNavy);
  // And the id the dialog needs to prefill itself next time.
  expect(navy.product_color_id).toBeTruthy();

  await openTree(page);
  await expect(page.getByText('Fix Navy', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, 'inventory-after-fix');
});

test('R3 · the corrected stock carries a new barcode, and labels are offered', async ({ page }) => {
  await page.goto('/');
  const res = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, search: ctx.productCode, limit: '200' },
  });
  const navy = (res.body.data || []).find(
    (r) => r.product_id === ctx.productId && r.color_name === 'Fix Navy',
  );
  // A fresh variant, with its own barcode — the moved pairs' old labels encode the
  // colour they used to be, which is why this has to exist to print.
  expect(navy.barcode, 'the new variant has no barcode to print').toBeTruthy();
  expect(String(navy.barcode)).toHaveLength(13);
  expect(navy.variant_id).not.toBe(ctx.variantId);
});

test('R4 · a sold pair is never moved', async ({ page }) => {
  await page.goto('/');
  // Sell the one Black pair that is left.
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, status: 'in_stock', limit: '10' },
  });
  const pair = (inv.body.data || [])[0];
  test.skip(!pair, 'nothing left in stock to sell');

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      items: [{ id: pair.id, sale_price: 400 }],
      payments: [{ amount: 400, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);

  // Now there is nothing in stock on Black 40 — so a correction has nothing to move
  // and must say so rather than reaching for the sold pair.
  const res = await api(page, 'POST', '/inventory/reassign', {
    body: { variant_id: ctx.variantId, store_id: ctx.storeId, product_color_id: ctx.navyId },
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/no pairs in stock/i);

  // And the sold pair still points at what was actually sold.
  const still = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, limit: '50' },
  });
  const sold = (still.body.data || []).find((i) => i.id === pair.id);
  expect(sold, 'the sold pair left its original variant').toBeTruthy();

  // Put it back so the fixture is reusable.
  await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'e2e cleanup' } });
});
