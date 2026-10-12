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

  // Now that a MOVE is pending, the dialog says the thing that is not recoverable from
  // the result: the printed labels encode the old colour. It is raised here rather than
  // on open because the same dialog also corrects a miscount, which moves nothing and
  // invalidates no label — warning about it unconditionally would be crying wolf.
  await expect(page.getByTestId('reassign-label-warning')).toBeVisible();
  await expect(page.getByTestId('reassign-label-warning')).toContainText(/scan|reprint/i);

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

/**
 * REMOVING STOCK THAT WAS NEVER REALLY THERE.
 *
 * `check:reassign` proves the rules — pairs with history refused in words rather than
 * as a constraint violation, newest taken first, another branch untouched. What it
 * cannot prove is that the screen makes the distinction the whole thing turns on:
 * this is NOT writing stock off. Damaged and lost mean the pair existed and is gone,
 * which is shrinkage. This means it never existed at all.
 */
test('R5 · stock recorded by mistake can be deleted, and the dialog says what that means', async ({ page }) => {
  await page.goto('/');
  const before = await countsByColor(page);

  // Something to delete, so the test never eats stock another test is relying on.
  await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: ctx.variantId, store_id: ctx.storeId, cost: 150, quantity: 2 },
  });

  await openTree(page);
  await page.getByText('Fix Black', { exact: true }).first().click();
  const del = page.getByTestId(`inv-remove-${ctx.variantId}`);
  await expect(del).toBeVisible({ timeout: 15_000 });
  await del.click();

  // The distinction, on screen, before anything happens.
  const warning = page.getByTestId('remove-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/cannot be undone/i);
  await expect(warning).toContainText(/write them off instead/i);

  // A reason is required: the button stays dead without one.
  await page.getByTestId('remove-quantity').fill('2');
  await expect(page.getByTestId('remove-save')).toBeDisabled();
  await page.getByTestId('remove-reason').fill('quantity entered twice');
  await expect(page.getByTestId('remove-save')).toBeEnabled();
  await shot(page, 'inventory-remove-dialog');
  await page.getByTestId('remove-save').click();

  // Back to where it started: the two added pairs are gone, nothing else moved.
  await expect.poll(
    async () => (await countsByColor(page))['Fix Black'] || 0,
    { timeout: 20_000, message: 'the two mistaken pairs were never removed' },
  ).toBe(before['Fix Black'] || 0);
});

test('R6 · a pair with history is refused in words, not as a database error', async ({ page }) => {
  await page.goto('/');
  // Sell a pair, then void the sale. Voiding puts the pair back in stock and keeps the
  // sale line as the record of what happened — so it is in stock AND still referenced.
  // This is the case that actually turns up, and it must read as a sentence.
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, status: 'in_stock', limit: '10' },
  });
  const pair = (inv.body.data || [])[0];
  test.skip(!pair, 'nothing in stock to sell');

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      items: [{ id: pair.id, sale_price: 400 }],
      payments: [{ amount: 400, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  await api(page, 'POST', `/sales/${sale.body.data.id}/void`, { body: { reason: 'e2e' } });

  // Every pair on this variant now includes one with a sale behind it. Asking to
  // remove them all must be refused rather than half-done.
  const all = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, status: 'in_stock', limit: '50' },
  });
  const res = await api(page, 'POST', '/inventory/remove', {
    body: {
      variant_id: ctx.variantId, store_id: ctx.storeId,
      quantity: (all.body.data || []).length, reason: 'trying to remove a real pair',
    },
  });
  expect(res.status).toBe(400);
  const msg = JSON.stringify(res.body);
  expect(msg).toMatch(/history/i);
  // The thing that would otherwise leak out.
  expect(msg).not.toMatch(/constraint|violates|foreign key/i);

  // And nothing was deleted on the way to refusing.
  const after = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, variant_id: ctx.variantId, status: 'in_stock', limit: '50' },
  });
  expect((after.body.data || []).length).toBe((all.body.data || []).length);
});

test('R7 · the quantity alone can be corrected, without touching the colour or size', async ({ page }) => {
  // THE COMPLAINT THIS EXISTS FOR: the edit dialog would not save a quantity change
  // unless the colour or the size was changed too, so "there are six of these, not
  // eight" — the correction people actually reach for — could not be made at all.
  await page.goto('/');
  const before = await countsByColor(page);
  const startBlack = before['Fix Black'] || 0;
  test.skip(startBlack < 1, 'no Fix Black stock left to correct');

  await openTree(page);
  await page.getByText('Fix Black', { exact: true }).first().click();
  const edit = page.getByTestId(`inv-reassign-${ctx.variantId}`);
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await edit.click();

  const qty = page.getByTestId('reassign-quantity');
  const current = parseInt(await qty.inputValue(), 10);
  expect(current, 'the box should open showing what is there now').toBeGreaterThan(0);

  // Add one, changing NOTHING else.
  await qty.fill(String(current + 1));

  // The dialog states what it is about to do rather than leaving it to be inferred —
  // the quantity box means something different when the colour or size has changed.
  const preview = page.getByTestId('reassign-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(/added/i);

  // No label warning: the pairs stay on the variant their barcode already describes.
  await expect(page.getByTestId('reassign-label-warning')).toHaveCount(0);

  const save = page.getByTestId('reassign-save');
  await expect(save, 'a quantity-only change must be savable').toBeEnabled();
  await save.click();

  await expect.poll(
    async () => (await countsByColor(page))['Fix Black'] || 0,
    { timeout: 20_000, message: 'the added pair never appeared' },
  ).toBe(startBlack + 1);
});

test('R8 · taking the quantity down insists on a reason, then deletes', async ({ page }) => {
  // Going down destroys rows, so it asks why — the same rule the Remove dialog
  // applies, since afterwards the activity log is the only record they were here.
  await page.goto('/');
  const before = await countsByColor(page);
  const startBlack = before['Fix Black'] || 0;
  test.skip(startBlack < 2, 'need at least two Fix Black pairs to take one away');

  await openTree(page);
  await page.getByText('Fix Black', { exact: true }).first().click();
  await page.getByTestId(`inv-reassign-${ctx.variantId}`).click();

  const qty = page.getByTestId('reassign-quantity');
  const current = parseInt(await qty.inputValue(), 10);
  await qty.fill(String(current - 1));

  const preview = page.getByTestId('reassign-preview');
  await expect(preview).toBeVisible();
  await expect(preview, 'it must say the pairs are deleted, not moved')
    .toContainText(/delete|cannot be undone/i);

  const save = page.getByTestId('reassign-save');
  await expect(save, 'deleting without saying why should be blocked').toBeDisabled();
  await page.getByTestId('reassign-reason').fill('counted twice on intake');
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(
    async () => (await countsByColor(page))['Fix Black'] || 0,
    { timeout: 20_000, message: 'the pair was never removed' },
  ).toBe(startBlack - 1);
});

test('R9 · changing nothing still cannot be saved', async ({ page }) => {
  // The dialog opens pre-filled with the current quantity, so "no change" is its
  // resting state and must not be a submittable one.
  await page.goto('/');
  const before = await countsByColor(page);
  test.skip((before['Fix Black'] || 0) < 1, 'no Fix Black stock left');

  await openTree(page);
  await page.getByText('Fix Black', { exact: true }).first().click();
  await page.getByTestId(`inv-reassign-${ctx.variantId}`).click();

  await expect(page.getByTestId('reassign-save'),
    'an untouched dialog should have nothing to save').toBeDisabled();
  await expect(page.getByTestId('reassign-preview'),
    'and nothing to announce').toHaveCount(0);
});
