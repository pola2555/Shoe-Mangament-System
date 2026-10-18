import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * The till, end to end: ring a sale, undo it, sell on credit, and settle.
 *
 * Two of these could not be done at all before:
 *   - a mis-rung sale had no undo; there is no DELETE on /api/sales and never was.
 *   - a regular customer could not take goods and pay later, because the server
 *     demanded that payments cover the whole total.
 *
 * Everything created here is cleaned up: the sales are voided or deleted, and the
 * stock they consumed goes back.
 */

const MARK = 'E2E-POS';
let ctx = { storeId: null, customerId: null, productId: null, itemIds: [], saleIds: [] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = stores.body.data[0].id;

  const cats = await api(page, 'GET', '/product-categories');
  const shoes = cats.body.data.find((c) => c.code === 'shoes');

  // Its own product and stock, so the test never competes with real inventory.
  const product = await api(page, 'POST', '/products', {
    body: {
      product_code: `${MARK}-${Date.now()}`, model_name: 'pos flow',
      category_id: shoes.id, default_selling_price: 300, net_price: 100,
    },
  });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  ctx.productId = product.body.data.id;

  const color = await api(page, 'POST', `/products/${ctx.productId}/colors`, {
    body: { color_name: 'POS Flow' },
  });

  for (const size of ['40', '41', '42']) {
    const v = await api(page, 'POST', `/products/${ctx.productId}/variants`, {
      body: { product_color_id: color.body.data.id, size_eu: size },
    });
    const stock = await api(page, 'POST', '/inventory/manual', {
      body: { variant_id: v.body.data.id, store_id: ctx.storeId, cost: 100, quantity: 1 },
    });
    expect(stock.status, JSON.stringify(stock.body)).toBe(201);
  }

  const customer = await api(page, 'POST', '/customers', {
    body: { name: `${MARK} Credit`, phone: `0100${Date.now()}`.slice(0, 15) },
  });
  ctx.customerId = customer.body.data?.id;

  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  for (const id of ctx.saleIds) {
    await api(page, 'POST', `/sales/${id}/void`, { body: { reason: 'test cleanup' } }).catch(() => {});
  }
  await page.close();
});

// ---------------------------------------------------------------- credit

test('a walk-in cannot walk out owing money', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const item = inv.body.data[0];

  const res = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      items: [{ id: item.id, sale_price: 300 }],
      payments: [{ amount: 50, payment_method: 'cash' }],
    },
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/walk-in|in full/i);

  // And the failed sale rolled back completely — the pair is still sellable.
  const after = await api(page, 'GET', '/inventory', { params: { variant_id: item.variant_id } });
  expect(after.body.data.find((i) => i.id === item.id).status).toBe('in_stock');
});

test('a registered customer can pay part now and the rest later', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      customer_id: ctx.customerId,
      items: [{ id: inv.body.data[0].id, sale_price: 300 }],
      payments: [{ amount: 100, payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  ctx.saleIds.push(sale.body.data.id);
  expect(sale.body.data.amount_due).toBe(200);

  const bal = await api(page, 'GET', `/sales/customer-balance/${ctx.customerId}`);
  expect(bal.body.data.outstanding).toBe(200);

  // Settling clears it.
  await api(page, 'POST', `/sales/${sale.body.data.id}/payments`, {
    body: { amount: 200, payment_method: 'cash' },
  });
  const after = await api(page, 'GET', `/sales/customer-balance/${ctx.customerId}`);
  expect(after.body.data.outstanding).toBe(0);
});

test('the checkout screen refuses credit to a walk-in, and explains', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const line = inv.body.data[0];
  expect(line, 'need stock to put in the cart').toBeTruthy();

  // The cart is seeded the way the app itself persists it. Driving the product picker
  // would make this test depend on that modal's internals, when what it is about is
  // the checkout screen's treatment of a walk-in.
  await page.addInitScript(([store, cart]) => {
    localStorage.setItem('pos_store', store);
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_customer', '');
  }, [ctx.storeId, [{ ...line, sale_price: 300 }]]);

  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });
  await page.getByRole('button', { name: /checkout/i }).click();

  // No customer selected: paying anything less than the total is not on offer.
  await expect(page.getByTestId('pos-pay-now')).toBeDisabled();
  await expect(page.getByTestId('pos-walkin-note')).toBeVisible();
  await expect(page.getByTestId('pos-on-account')).toContainText('0');
  await shot(page, 'pos-walkin-no-credit');
});

// ---------------------------------------------------------------- undo

test('THE GAP: a sale rung by mistake can be undone at the till', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const item = inv.body.data[0];
  expect(item, 'need stock left to sell').toBeTruthy();

  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      items: [{ id: item.id, sale_price: 300 }],
      payments: [{ amount: 300, payment_method: 'cash' }],
    },
  });
  expect(sale.status).toBe(201);
  const saleId = sale.body.data.id;

  const sold = await api(page, 'GET', '/inventory', { params: { variant_id: item.variant_id } });
  expect(sold.body.data.find((i) => i.id === item.id).status).toBe('sold');

  const voided = await api(page, 'POST', `/sales/${saleId}/void`, {
    body: { reason: 'wrong item scanned' },
  });
  expect(voided.status, JSON.stringify(voided.body)).toBe(200);

  // The pair is back on the shelf.
  const back = await api(page, 'GET', '/inventory', { params: { variant_id: item.variant_id } });
  expect(back.body.data.find((i) => i.id === item.id).status).toBe('in_stock');

  // And the sale is out of the list, but still on the record.
  const list = await api(page, 'GET', '/sales');
  expect(list.body.data.some((s) => s.id === saleId)).toBe(false);
  const withVoided = await api(page, 'GET', '/sales', { params: { include_voided: 'true' } });
  expect(withVoided.body.data.some((s) => s.id === saleId)).toBe(true);
});

test('a voided sale reads as voided in the history, and takes no more money', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: ctx.storeId,
      items: [{ id: inv.body.data[0].id, sale_price: 300 }],
      payments: [{ amount: 300, payment_method: 'cash' }],
    },
  });
  const saleId = sale.body.data.id;
  await api(page, 'POST', `/sales/${saleId}/void`, { body: { reason: 'e2e' } });

  const again = await api(page, 'POST', `/sales/${saleId}/void`, { body: {} });
  expect(again.status).toBe(400);
  const pay = await api(page, 'POST', `/sales/${saleId}/payments`, {
    body: { amount: 10, payment_method: 'cash' },
  });
  expect(pay.status).toBe(400);

  await page.goto('/sales');
  await page.getByTestId('show-voided').check();
  const row = page.getByTestId(`sale-row-${saleId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByText(/voided/i).first()).toBeVisible();
  await shot(page, 'sales-voided-detail');
});

// ---------------------------------------------------------------- images

test('a sale shows what was sold, as a picture', async ({ page }) => {
  await page.goto('/');
  const list = await api(page, 'GET', '/sales');
  const withItems = list.body.data[0];
  if (!withItems) test.skip(true, 'no sales to look at');

  const detail = await api(page, 'GET', `/sales/${withItems.id}`);
  expect(detail.status).toBe(200);
  // The columns are there whether or not this particular product has a photo.
  expect(detail.body.data.items[0]).toHaveProperty('color_image_url');
  expect(detail.body.data.items[0]).toHaveProperty('color_image_thumb_url');

  await page.goto('/sales');
  // Wait for the row before clicking it. Clicking straight after goto() raced the
  // list's own fetch, which passed alone and failed in a full run — the shape of a
  // flake rather than a finding.
  const row = page.getByTestId(`sale-row-${withItems.id}`);
  await expect(row).toBeVisible({ timeout: 25_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: withItems.sale_number })).toBeVisible({ timeout: 20_000 });
  await shot(page, 'sale-detail-images');
});

// ---------------------------------------------------------------- size filter

test('the POS can be filtered by size', async ({ page }) => {
  await page.goto('/pos');
  await expect(page.getByTestId('pos-categories')).toBeVisible({ timeout: 25_000 });

  const cats = await api(page, 'GET', '/product-categories');
  const shoes = cats.body.data.find((c) => c.code === 'shoes');
  await page.getByTestId(`pos-category-${shoes.id}`).click();

  // Size and colour sit behind a filter toggle. Three chip rows always on screen cost
  // about 90px of the product grid on a phone, and the category row is the one a
  // cashier reaches for constantly — so that one stays out and the other two open on
  // a tap.
  await page.getByTestId('pos-toggle-filters').click();
  await expect(page.getByTestId('pos-sizes')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'pos-size-chips');

  const grid = page.locator('.pos-products-scroll');
  await page.getByTestId('pos-size-42').click();
  await expect(grid).toBeVisible();

  // Everything still listed has size 42 in stock.
  const res = await api(page, 'GET', '/inventory/summary', {
    params: { store_id: ctx.storeId, category_id: shoes.id, size_values: '42', limit: '500' },
  });
  expect(res.status).toBe(200);
  expect(res.body.data.every((r) => r.size_eu === '42')).toBe(true);
});

// ---------------------------------------------------------------- number inputs

test('scrolling a form does not silently edit a number', async ({ page }) => {
  await page.goto('/expenses');
  await page.getByTestId('add-expense').click();
  const amount = page.getByTestId('expense-amount');
  await amount.fill('1234');
  await amount.focus();

  // The browser treats a wheel over a focused number input as a value change, so on a
  // long invoice scrolling past the cost boxes rewrote money with nothing on screen to
  // say it had happened.
  await amount.hover();
  await page.mouse.wheel(0, 400);
  await page.mouse.wheel(0, -400);

  await expect(amount).toHaveValue('1234');
});

// ---------------------------------------------------------------- the price band

/**
 * One product in the shop could be added to the cart and never sold. Its floor was 90
 * and its ceiling 80 — typed into the wrong boxes — so `price >= 90 && price <= 80`
 * was unsatisfiable and Checkout stayed dead. All the till said about it was the bare
 * string "90 - 80 EGP", which means nothing unless you already know what you are
 * looking at, and which was shown only to users who could also edit the price.
 *
 * The cart is seeded through localStorage, which is how the app itself restores one —
 * and it is the only way to put a line with an impossible band on screen, now that the
 * server refuses to store one.
 */
async function seedCart(page, storeId, line) {
  await page.addInitScript(([store, cart]) => {
    localStorage.setItem('pos_store', store);
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_customer', '');
    localStorage.setItem('pos_hide_prices', '0');
  }, [storeId, [line]]);
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 25_000 });
}

test('an impossible price band says so, instead of showing two bare numbers', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const line = inv.body.data[0];
  expect(line, 'need stock to put in the cart').toBeTruthy();

  await seedCart(page, ctx.storeId, {
    ...line, sale_price: 90, min_selling_price: 90, max_selling_price: 80,
    store_min_selling_price: null, store_max_selling_price: null,
  });

  const problem = page.getByTestId('pos-price-problem-0');
  await expect(problem).toBeVisible();

  // A sentence, not "90 - 80". Both ends named, and the blame on the product.
  const text = await problem.textContent();
  expect(text).toMatch(/90/);
  expect(text).toMatch(/80/);
  expect(text).toMatch(/minimum/i);
  expect(text).toMatch(/maximum/i);
  expect(text.trim()).not.toMatch(/^90\s*-\s*80/);

  // And it is still refused, which was never the problem — only the silence was.
  await expect(page.getByRole('button', { name: /checkout/i })).toBeDisabled();
  await shot(page, 'pos-impossible-band');
});

test('the reason quotes the branch band that is actually enforced', async ({ page }) => {
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const line = inv.body.data[0];

  // A perfectly ordinary catalogue band, and a branch that prices above it. The line
  // is judged against the BRANCH numbers — as it is on the server — but the message
  // used to print the catalogue ones, so it named a range the price was already
  // inside and gave no way to work out what was wrong.
  //
  // Checked ABOVE the branch ceiling. Below the branch FLOOR is no longer refused for
  // an administrator — it is allowed, warned and recorded — so the refusal message
  // this test exists for is raised by the ceiling now. The resolution being guarded
  // (branch numbers, not catalogue) is the same either way; the half below the floor
  // is covered by the test underneath.
  await seedCart(page, ctx.storeId, {
    ...line, sale_price: 400,
    min_selling_price: 50, max_selling_price: 500,
    store_min_selling_price: 200, store_max_selling_price: 300,
  });

  const problem = page.getByTestId('pos-price-problem-0');
  await expect(problem).toBeVisible();
  const text = await problem.textContent();
  expect(text, 'it should name the branch ceiling').toMatch(/300/);
  expect(text, 'and not the catalogue one the server does not enforce').not.toMatch(/500/);
});

test('the warning under the floor quotes the branch floor too', async ({ page }) => {
  // The other half of the same resolution: an administrator under the branch floor is
  // warned rather than refused, and that warning has to name the number actually in
  // force — the branch's 200, not the catalogue's 50. Getting this wrong would tell
  // somebody they were under a floor they were comfortably above.
  await page.goto('/');
  const inv = await api(page, 'GET', '/inventory', {
    params: { store_id: ctx.storeId, product_id: ctx.productId, status: 'in_stock' },
  });
  const line = inv.body.data[0];

  await seedCart(page, ctx.storeId, {
    ...line, sale_price: 100,
    min_selling_price: 50, max_selling_price: 500,
    store_min_selling_price: 200, store_max_selling_price: 300,
  });

  // Allowed, not refused.
  await expect(page.getByTestId('pos-price-problem-0')).toHaveCount(0);

  const warning = page.getByTestId('pos-below-floor-0');
  await expect(warning).toBeVisible();
  const text = await warning.textContent();
  expect(text, 'it should name the branch floor').toMatch(/200/);
  expect(text, 'and the shortfall against it').toMatch(/100/);
  expect(text, 'not the catalogue floor the server does not enforce').not.toMatch(/\b50\b/);
});

// ---------------------------------------------------------------- the price floor

test('an admin may sell under the floor, but is warned and must confirm', async ({ page }) => {
  // IT USED TO BE A FLAT NO. The Checkout button simply went dead — for the owner
  // too, whose own floor it is — so clearing a slow line meant editing the product's
  // minimum and editing it back, which moves the floor for every till and records
  // nothing about why.
  await page.goto('/');

  const cats = await api(page, 'GET', '/product-categories');
  const made = await api(page, 'POST', '/products', {
    body: {
      product_code: `${MARK}-FLOOR-${Date.now()}`, model_name: 'floor flow',
      category_id: cats.body.data.find((c) => c.code === 'shoes').id,
      default_selling_price: 300, net_price: 100, min_selling_price: 250,
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const pid = made.body.data.id;
  const colour = await api(page, 'POST', `/products/${pid}/colors`, { body: { color_name: 'Floor Flow' } });
  const variant = await api(page, 'POST', `/products/${pid}/variants`, {
    body: { product_color_id: colour.body.data.id, size_eu: '43' },
  });
  await api(page, 'POST', '/inventory/manual', {
    body: { variant_id: variant.body.data.id, store_id: ctx.storeId, cost: 100, quantity: 1 },
  });

  await page.goto('/pos');
  const search = page.locator('.pos-search-input-wrap input[type="search"]');
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(`${MARK}-FLOOR`);
  await search.press('Enter');

  const card = page.locator('.pos-product-card').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  // The card opens a size picker — "tap a size to add it to the cart" — so the cart
  // line does not exist until a size is chosen.
  await page.getByRole('button', { name: /EU 43/i }).first().click();
  // The picker stays open so several sizes can be added in one go; it has to be shut
  // before the cart behind it can be touched.
  await page.locator('.modal-overlay, [class*="modal"]').locator('button', { hasText: /^\s*×?\s*$/ }).first()
    .click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
  await page.waitForTimeout(400);

  const priceInput = page.locator('.pos-cart-item .price-input').first();
  await expect(priceInput).toBeVisible({ timeout: 20_000 });

  // Under the floor of 250.
  await priceInput.fill('180');

  // Said on the line as it is typed, not sprung at the end.
  const warning = page.getByTestId('pos-below-floor-0');
  await expect(warning, 'going under the floor should say so on the line').toBeVisible();
  await expect(warning).toContainText('250');

  // And NOT treated as an error: the sale is allowed, so Checkout stays alive. THIS
  // IS THE REGRESSION — the button used to go dead right here.
  await expect(page.getByTestId('pos-price-problem-0')).toHaveCount(0);
  const checkout = page.locator('.pos-checkout-btn');
  await expect(checkout, 'an admin under the floor must still be able to sell').toBeEnabled();
  await shot(page, 'pos-below-floor-warned');

  // Confirmed at the moment it becomes real — after the payment is entered, not on
  // every keystroke of the price.
  let asked = null;
  page.on('dialog', async (d) => { asked = d.message(); await d.dismiss(); });
  await checkout.click();
  await page.getByTestId('pos-confirm-payment').click();
  await expect.poll(() => asked, { timeout: 10_000, message: 'it never asked' }).toBeTruthy();
  expect(asked).toMatch(/minimum/i);

  // Dismissed means dismissed.
  await page.waitForTimeout(600);
  const sales = await api(page, 'GET', '/sales', { params: { limit: '10' } });
  const sold = (sales.body.data || []).some((sale) => Math.abs(Number(sale.total_amount) - 180) < 0.01);
  expect(sold, 'saying no to the confirmation still rang the sale up').toBe(false);
});
