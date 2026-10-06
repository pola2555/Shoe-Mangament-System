import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * Receiving stock that is not a shoe, re-using what was received last time, and the
 * notification history.
 *
 * The box editor asked for an "EU" size with US/UK/CM columns whatever the product
 * was, and its generator counted whole numbers — so a sock box could not be entered at
 * all. It also asked for the same cost, count and size run every single time the same
 * product came in.
 */

const MARK = 'E2E-PN';
let ctx = { storeId: null, supplierId: null, sockProductId: null, bagProductId: null, invoiceId: null };

test.describe.configure({ mode: 'serial' });

/**
 * A product for this spec to receive stock against — reused across runs.
 *
 * It used to mint a new one every run with a timestamp in the code, and a product can
 * never be deleted (RESTRICT everywhere), so each run left two more behind. They also
 * never gain variants, because their boxes are deliberately never completed — and a
 * variant-less product sitting at the top of "newest first" broke a barcode test that
 * took whichever product came back first. Two junk rows per run is not free.
 */
async function makeProduct(page, categoryCode, name) {
  const code = `${MARK}-${categoryCode}`.slice(0, 40);
  const existing = await api(page, 'GET', '/products', { params: { search: code } });
  const found = (existing.body.data || []).find((p) => p.product_code === code);
  if (found) return found.id;

  const cats = await api(page, 'GET', '/product-categories');
  const cat = cats.body.data.find((c) => c.code === categoryCode);
  const res = await api(page, 'POST', '/products', {
    body: {
      product_code: code,
      model_name: name, category_id: cat.id, default_selling_price: 80,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (cat.has_colors) {
    await api(page, 'POST', `/products/${res.body.data.id}/colors`, { body: { color_name: 'Plain' } });
  }
  return res.body.data.id;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');

  const stores = await api(page, 'GET', '/stores');
  ctx.storeId = stores.body.data[0].id;
  const suppliers = await api(page, 'GET', '/suppliers');
  ctx.supplierId = suppliers.body.data[0]?.id;

  ctx.sockProductId = await makeProduct(page, 'socks', 'flow socks');
  ctx.bagProductId = await makeProduct(page, 'bags', 'flow bag');

  if (ctx.supplierId) {
    const inv = await api(page, 'POST', '/purchases/invoices', {
      body: {
        supplier_id: ctx.supplierId, total_amount: 100000,
        invoice_date: '2026-09-01', notes: `${MARK} flow`,
      },
    });
    if (inv.status === 201) ctx.invoiceId = inv.body.data.id;
  }
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  if (ctx.invoiceId) await api(page, 'DELETE', `/purchases/invoices/${ctx.invoiceId}`).catch(() => {});
  await page.close();
});

// ---------------------------------------------------------------- box entry

test('THE BUG: a sock box asks for sock sizes, not EU shoe sizes', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier to raise an invoice against');
  await page.goto('/');

  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.sockProductId, cost_per_item: 20, total_items: 6, destination_store_id: ctx.storeId },
  });
  expect(box.status, JSON.stringify(box.body)).toBe(201);

  await page.goto(`/purchases/${ctx.invoiceId}`);
  await page.getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();

  const picker = page.getByTestId('size-run-picker');
  await expect(picker).toBeVisible({ timeout: 20_000 });

  // A word-based size list gets chips, never a from/to range: "38 to 45" cannot
  // express Kids, Teens and Adults.
  await expect(picker.getByTestId('run-chips')).toBeVisible();
  await expect(picker.getByTestId('run-start')).toHaveCount(0);
  await expect(picker.getByTestId('run-chips')).toContainText(/kids/i);

  // And no US/UK/CM columns: a sock has no US size.
  await expect(page.locator('th', { hasText: /^US$/ })).toHaveCount(0);
  await shot(page, 'box-socks');
});

test('a bag box has no size column at all', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.bagProductId, cost_per_item: 50, total_items: 4, destination_store_id: ctx.storeId },
  });
  expect(box.status).toBe(201);

  await page.goto(`/purchases/${ctx.invoiceId}`);
  const rows = page.locator('.card', { hasText: 'flow bag' });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();

  // Nothing to generate when there is nothing to size.
  await expect(page.getByTestId('size-run-picker')).toHaveCount(0);
  await shot(page, 'box-bag');
});

// ---------------------------------------------------------------- suggestions

test('the last box of a product is offered back', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const suggestion = await api(page, 'GET', '/purchases/boxes/suggestion', {
    params: { product_id: ctx.sockProductId },
  });
  expect(suggestion.status).toBe(200);
  expect(suggestion.body.data, 'a product with a box should have a suggestion').toBeTruthy();
  expect(parseFloat(suggestion.body.data.cost_per_item)).toBe(20);
  expect(suggestion.body.data.total_items).toBe(6);

  const none = await api(page, 'GET', '/purchases/boxes/suggestion', {
    params: { product_id: '00000000-0000-0000-0000-000000000000' },
  });
  expect(none.status).toBe(200);
  expect(none.body.data).toBeNull();
});

test('a box can be duplicated, items and all, without inventing stock', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');

  const boxes = await api(page, 'GET', `/purchases/invoices/${ctx.invoiceId}`);
  const original = boxes.body.data.boxes.find((b) => b.product_id === ctx.sockProductId);
  expect(original).toBeTruthy();

  const copy = await api(page, 'POST', `/purchases/boxes/${original.id}/duplicate`);
  expect(copy.status, JSON.stringify(copy.body)).toBe(201);
  expect(copy.body.data.detail_status).not.toBe('complete');
  expect(parseFloat(copy.body.data.cost_per_item)).toBe(parseFloat(original.cost_per_item));
  expect(copy.body.data.total_items).toBe(original.total_items);

  await api(page, 'DELETE', `/purchases/boxes/${copy.body.data.id}`);
});

// ---------------------------------------------------------------- notifications

test('the bell can be cleared without losing the history', async ({ page }) => {
  await page.goto('/');

  const before = await api(page, 'GET', '/notifications/history', { params: { limit: '5' } });
  expect(before.status).toBe(200);
  expect(before.body).toHaveProperty('pagination');

  const cleared = await api(page, 'POST', '/notifications/clear');
  expect(cleared.status).toBe(200);

  const unread = await api(page, 'GET', '/notifications');
  expect(unread.body.data.length).toBe(0);

  // Clearing archives; it does not delete. Anything that was there is still findable.
  const after = await api(page, 'GET', '/notifications/history', { params: { limit: '100' } });
  expect(after.body.pagination.total).toBeGreaterThanOrEqual(before.body.pagination.total);
});

test('history filters by date, and deleting needs a range', async ({ page }) => {
  await page.goto('/');

  const future = await api(page, 'GET', '/notifications/history', { params: { from: '2099-01-01' } });
  expect(future.body.pagination.total).toBe(0);

  // The only call that loses anything refuses to run without being told what to lose.
  const unbounded = await api(page, 'DELETE', '/notifications');
  expect(unbounded.status).toBe(400);
  expect(JSON.stringify(unbounded.body)).toMatch(/date range/i);
});

test('the notifications panel shows history with date filters', async ({ page }) => {
  await page.goto('/');
  await page.locator('.sidebar__bell').click();
  await expect(page.getByTestId('notif-tab-history')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('notif-tab-history').click();
  await expect(page.getByTestId('notif-from')).toBeVisible();
  await expect(page.getByTestId('notif-to')).toBeVisible();
  await expect(page.getByTestId('notif-delete-range')).toBeDisabled();
  await shot(page, 'notifications-history');
});

// ---------------------------------------------------------------- sidebar

test('sidebar groups collapse, persist, and reopen on the active page', async ({ page }) => {
  await page.goto('/');
  const group = page.getByTestId('sidebar-group-sidebar.purchases_finance');
  await expect(group).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('link', { name: /suppliers/i })).toBeVisible();
  await group.click();
  await expect(page.getByRole('link', { name: /suppliers/i })).toHaveCount(0);

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: /suppliers/i })).toHaveCount(0);
  await shot(page, 'sidebar-collapsed-group');

  // But a collapsed group can never hide the page you are actually on.
  await page.goto('/expenses');
  await expect(page.getByRole('link', { name: /expenses/i })).toBeVisible({ timeout: 15_000 });
});

// ---------------------------------------------------------------- dropdowns

/**
 * THE COLOUR LIST WAS CUT OFF INSIDE A SCROLLBAR NOBODY COULD SEE.
 *
 * Each colour group in the box editor is wrapped in `overflow-x: auto`, because the
 * row inside it is 600px wide and has to scroll sideways on a narrow screen. CSS does
 * not allow `overflow-x: auto` alongside `overflow-y: visible` — the browser promotes
 * the vertical axis to `auto` as well. So the dropdown, rendered inline, was clipped a
 * line or two down and the only way to reach the rest was a scrollbar most people
 * never noticed.
 *
 * A z-index could never have fixed this: z-index decides what draws on top, not what
 * gets clipped. The menu now renders through a portal on document.body.
 *
 * This measures the geometry rather than trusting the markup — the bug was entirely
 * about where pixels landed, and the menu was always present in the DOM.
 */
test('the colour dropdown is not clipped by the scrolling row around it', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier to raise an invoice against');
  await page.goto('/');

  // ENOUGH COLOURS TO MAKE A TALL LIST.
  //
  // With one colour the menu is ~70px and fits inside the group whatever the overflow
  // says, so a one-colour fixture tests nothing — an earlier version of this test
  // passed happily against the unfixed code for exactly that reason. A real shop
  // carries a dozen colours, the list hits react-select's 300px ceiling, and that is
  // when it runs past the bottom of the scrolling group.
  const palette = ['Crimson', 'Navy', 'Olive', 'Mustard', 'Teal',
    'Maroon', 'Lilac', 'Charcoal', 'Sand', 'Rose', 'Mint'];
  for (const name of palette) {
    await api(page, 'POST', `/products/${ctx.sockProductId}/colors`, { body: { color_name: name } })
      .catch(() => {});
  }

  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.sockProductId, cost_per_item: 20, total_items: 6, destination_store_id: ctx.storeId },
  });
  expect(box.status, JSON.stringify(box.body)).toBe(201);

  await page.goto(`/purchases/${ctx.invoiceId}`);
  await page.getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();

  // The colour picker, by its placeholder — the only select in the group row.
  const control = page.locator('.react-select__control').filter({ hasText: /color name/i }).first();
  await expect(control).toBeVisible({ timeout: 20_000 });
  await control.click();

  const menu = page.locator('.react-select__menu');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.react-select__option').first()).toBeVisible();

  // Is any ancestor clipping it? Walk up from the menu to the first element whose
  // computed overflow is not `visible`, and compare the two rectangles. Before the
  // fix that ancestor was the colour group's own scrolling div and the menu hung well
  // past its bottom edge; now the menu sits on body and nothing clips it.
  const verdict = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      const clips = [cs.overflow, cs.overflowX, cs.overflowY]
        .some((v) => v && v !== 'visible');
      if (clips) {
        const pr = p.getBoundingClientRect();
        return {
          clipper: p.className || p.tagName,
          hiddenBelow: Math.round(r.bottom - pr.bottom),
          hiddenAbove: Math.round(pr.top - r.top),
        };
      }
      p = p.parentElement;
    }
    return { clipper: null, hiddenBelow: 0, hiddenAbove: 0 };
  });

  expect(
    verdict.hiddenBelow,
    `the menu is cut off ${verdict.hiddenBelow}px below "${verdict.clipper}"`,
  ).toBeLessThanOrEqual(0);
  expect(verdict.hiddenAbove).toBeLessThanOrEqual(0);

  // The whole menu is on screen, top and bottom.
  //
  // Note this is NOT the same as "every option is visible": a dozen colours exceed
  // react-select's own 300px ceiling and the list scrolls inside itself, which is
  // ordinary and plainly visible. The complaint was about the OUTER clip — a menu cut
  // off by a container whose scrollbar you could not see.
  const onScreen = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), belowFold: Math.round(r.bottom - window.innerHeight) };
  });
  expect(onScreen.top, 'the menu starts above the top of the window').toBeGreaterThanOrEqual(0);
  expect(onScreen.belowFold, 'the menu runs past the bottom of the window').toBeLessThanOrEqual(0);

  await shot(page, 'box-colour-dropdown');

  // And a colour can actually be chosen.
  await page.locator('.react-select__option').first().click();
  await expect(menu).toHaveCount(0);
});

// ---------------------------------------------------------------- colour previews

/**
 * A COLOUR IS EASIER TO RECOGNISE AS A PICTURE THAN AS A WORD.
 *
 * Receiving a delivery means matching what is physically in the box against a name in
 * a list — and whoever is unpacking did not choose the names. "Olive" and "Sand" are
 * a guess as words and obvious as photographs.
 *
 * Nothing here uploads an image: local dev writes to a real S3 bucket. The photo path
 * is exercised by injecting image rows into the product response, which is exactly the
 * shape `products.getById` returns (it calls attachColorImages), so the component is
 * fed the real thing without a byte going near the bucket.
 */

// 1x1 PNG. Enough for the browser to decode and lay out; nothing is fetched.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Give every colour on every product `n` images, on the way to the browser. */
async function withColorImages(page, n = 2) {
  await page.route('**/api/products/*', async (route) => {
    const res = await route.fetch();
    let body;
    try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
    const colors = body?.data?.colors;
    if (Array.isArray(colors)) {
      for (const c of colors) {
        c.images = Array.from({ length: n }, (_, i) => ({
          id: `stub-${c.id}-${i}`, image_url: PIXEL, thumb_url: PIXEL,
          is_primary: i === 0, sort_order: i,
        }));
      }
    }
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

async function openSockBoxEditor(page) {
  const box = await api(page, 'POST', `/purchases/invoices/${ctx.invoiceId}/boxes`, {
    body: { product_id: ctx.sockProductId, cost_per_item: 20, total_items: 6, destination_store_id: ctx.storeId },
  });
  expect(box.status, JSON.stringify(box.body)).toBe(201);
  await page.goto(`/purchases/${ctx.invoiceId}`);
  await page.getByRole('button', { name: /^\+?\s*(edit|box items)/i }).first().click();
}

test('every colour in the picker carries a thumbnail', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier to raise an invoice against');
  await page.goto('/');
  await withColorImages(page, 2);
  await openSockBoxEditor(page);

  const control = page.locator('.react-select__control').filter({ hasText: /color name/i }).first();
  await expect(control).toBeVisible({ timeout: 20_000 });
  await control.click();

  const options = page.locator('.react-select__option');
  await expect(options.first()).toBeVisible({ timeout: 10_000 });

  // Every option that names a real colour shows one. The placeholder row ("Color
  // Name...") carries no colour and correctly has none.
  const named = options.filter({ hasNot: page.locator('text=/^Color Name\.\.\.$/') });
  const count = await named.count();
  expect(count).toBeGreaterThan(0);
  let withThumb = 0;
  for (let i = 0; i < count; i++) {
    if (await named.nth(i).locator('.color-thumb').count()) withThumb++;
  }
  expect(withThumb, `${withThumb} of ${count} options had a thumbnail`).toBe(count);
  await shot(page, 'box-colour-options');
});

test('picking a colour shows a larger preview of it', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');
  await withColorImages(page, 3);
  await openSockBoxEditor(page);

  // Nothing chosen yet, so no preview — an empty tile beside an empty select is noise.
  await expect(page.locator('.color-thumb--lg')).toHaveCount(0);

  const control = page.locator('.react-select__control').filter({ hasText: /color name/i }).first();
  await control.click();
  await page.locator('.react-select__option').nth(1).click();

  const preview = page.locator('.color-thumb--lg').first();
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview).toHaveClass(/color-thumb--photo/);

  // It is a real square with a real image in it, not a collapsed span.
  const box = await preview.boundingBox();
  expect(box.width).toBeGreaterThan(40);
  expect(box.height).toBeGreaterThan(40);
  await expect(preview.locator('img')).toHaveAttribute('src', PIXEL);

  // Three images, one shown: the badge says there are more without opening anything.
  await expect(preview.locator('.color-thumb__more')).toHaveText('+2');
  await shot(page, 'box-colour-preview');
});

test('a colour with no photo gets a deliberate placeholder, not a hole', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  // No stubbing: the fixture's colours have neither an image nor a hex, which is the
  // state most of a real catalogue starts in. It must read as "no photo yet" rather
  // than as something that failed to load.
  await page.goto('/');
  await openSockBoxEditor(page);

  const control = page.locator('.react-select__control').filter({ hasText: /color name/i }).first();
  await expect(control).toBeVisible({ timeout: 20_000 });
  await control.click();
  await page.locator('.react-select__option').nth(1).click();

  const preview = page.locator('.color-thumb--lg').first();
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview).toHaveClass(/color-thumb--empty/);
  // Its initial, so the tile still says which colour it stands for.
  await expect(preview).not.toBeEmpty();
  const box = await preview.boundingBox();
  expect(box.width).toBeGreaterThan(40);
  await shot(page, 'box-colour-placeholder');
});

test('typing still filters the list now that options are pictures', async ({ page }) => {
  test.skip(!ctx.invoiceId, 'no supplier');
  await page.goto('/');
  await withColorImages(page, 1);
  await openSockBoxEditor(page);

  const control = page.locator('.react-select__control').filter({ hasText: /color name/i }).first();
  await control.click();
  const all = await page.locator('.react-select__option').count();

  // Search runs on the option's label, which stays a plain string even though the row
  // is rendered as a picture. Easy to break by moving the name into the renderer.
  await page.keyboard.type('Crim', { delay: 20 });
  const filtered = page.locator('.react-select__option');
  await expect(filtered.first()).toBeVisible();
  expect(await filtered.count()).toBeLessThan(all);
  await expect(filtered.first()).toContainText(/crimson/i);
});
