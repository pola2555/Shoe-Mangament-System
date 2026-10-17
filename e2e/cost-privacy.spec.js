import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * COST IS NOT FOR THE ROOM.
 *
 * A customer who can read what a pair cost knows the margin before they open their
 * mouth, so every cost on these screens is blurred. Two ways past it: hold one value
 * to read that one, or turn the eye on while costing is the job.
 *
 * What this suite is really guarding is the pair of leaks that make a blur pointless —
 * a margin percentage beside a selling price, and a profit column beside a unit price,
 * either of which gives the cost away by arithmetic. Blurring the cost column alone
 * would look finished and protect nothing.
 *
 * It does NOT claim the figure is secret from a determined person: it is in the DOM
 * and in the API response. Who may receive it at all is the server's business
 * (middleware/priceVisibility). This is about what is readable across a counter.
 */

let ctx = { productId: null };

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const prods = await api(page, 'GET', '/products', { params: { is_active: 'true', limit: '20' } });
  const rows = prods.body.data || [];
  const withCost = rows.find((p) => p.net_price != null) || rows[0];
  ctx.productId = withCost?.id;
  await page.close();
});

test('C1 · a product cost is blurred until it is asked for', async ({ page }) => {
  test.skip(!ctx.productId, 'no product to look at');
  await page.goto(`/products/${ctx.productId}`);

  const cost = page.getByTestId('product-net-price');
  await expect(cost).toBeVisible({ timeout: 30_000 });
  // Blurred, but PRESENT: the figure is there to be revealed, not removed. A test that
  // only checked it was absent would pass on a page that simply lost the number.
  await expect(cost).toHaveAttribute('data-revealed', 'false');
  await expect(cost).not.toHaveText('');

  const filtered = await cost.evaluate((el) => getComputedStyle(el).filter);
  expect(filtered, 'the cost should actually be blurred, not just marked as such')
    .toContain('blur');

  await shot(page, 'cost-blurred');
});

test('C2 · holding a cost reveals it, and letting go hides it again', async ({ page }) => {
  test.skip(!ctx.productId, 'no product to look at');
  await page.goto(`/products/${ctx.productId}`);
  const cost = page.getByTestId('product-net-price');
  await expect(cost).toBeVisible({ timeout: 30_000 });

  const box = await cost.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The hold is deliberate, so the reveal is not instant.
  await expect(cost).toHaveAttribute('data-revealed', 'true', { timeout: 3000 });
  const shown = await cost.evaluate((el) => getComputedStyle(el).filter);
  expect(shown, 'held, it should be legible').toBe('none');

  await page.mouse.up();
  // THE POINT OF A HOLD: it cannot be left switched on.
  await expect(cost).toHaveAttribute('data-revealed', 'false');
});

test('C3 · the eye uncovers every cost on the page at once', async ({ page }) => {
  await page.goto('/products');
  const eye = page.getByTestId('cost-reveal-toggle');
  await expect(eye).toBeVisible({ timeout: 30_000 });

  const costs = page.locator('.secret-cost');
  const n = await costs.count();
  test.skip(n === 0, 'no costs listed on this page');

  await expect(costs.first()).toHaveAttribute('data-revealed', 'false');
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'true');

  // ALL of them, not the one that happens to be first.
  for (let i = 0; i < Math.min(n, 8); i += 1) {
    await expect(costs.nth(i)).toHaveAttribute('data-revealed', 'true');
  }
  await shot(page, 'cost-eye-on');

  await eye.click();
  await expect(costs.first()).toHaveAttribute('data-revealed', 'false');
});

test('C4 · the eye does not stay on when you leave the page', async ({ page }) => {
  // An eye switched on in the back office must not still be on at the counter.
  await page.goto('/products');
  const eye = page.getByTestId('cost-reveal-toggle');
  await expect(eye).toBeVisible({ timeout: 30_000 });
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/inventory');
  const eye2 = page.getByTestId('cost-reveal-toggle');
  await expect(eye2).toBeVisible({ timeout: 30_000 });
  await expect(eye2, 'costs should be hidden again on a new page')
    .toHaveAttribute('aria-pressed', 'false');
});

test('C5 · the figures that give the cost away are covered too', async ({ page }) => {
  // A margin beside a selling price, or a profit beside a unit price, IS the cost.
  // Blurring only the column headed "cost" would look finished and protect nothing.
  await page.goto('/products');
  await expect(page.getByTestId('cost-reveal-toggle')).toBeVisible({ timeout: 30_000 });

  const margins = page.locator('.product-card__margin, [class*="margin"]')
    .filter({ hasText: '%' });
  const marginCount = await margins.count();
  if (marginCount > 0) {
    // Every margin shown must sit inside a cover, or be one.
    for (let i = 0; i < Math.min(marginCount, 5); i += 1) {
      const covered = await margins.nth(i).evaluate(
        (el) => !!(el.closest('.secret-cost') || el.querySelector('.secret-cost')),
      );
      expect(covered, 'a margin percentage is on show beside the selling price').toBe(true);
    }
  }

  // And on a sale, the profit column.
  await page.goto('/sales');
  await expect(page.getByTestId('cost-reveal-toggle')).toBeVisible({ timeout: 30_000 });
  const row = page.locator('tbody tr').first();
  if (await row.count()) {
    await row.click();
    const costCells = page.locator('.secret-cost');
    // A sale that opened should cover BOTH its cost and its profit — two per line.
    if (await costCells.count()) {
      expect(await costCells.count(),
        'a sale line shows both a cost and a profit; both have to be covered')
        .toBeGreaterThanOrEqual(2);
    }
  }
});

test('C6 · an image picker offers the device, not only the camera', async ({ page }) => {
  // `capture="environment"` makes a phone open the camera and offer nothing else, so
  // a photo already on the device could not be used at all. The attribute belongs on
  // the barcode scanner, where the camera IS the point, and nowhere else.
  test.skip(!ctx.productId, 'no product to look at');
  await page.goto(`/products/${ctx.productId}`);
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });

  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  expect(n, 'the product page should offer a file input').toBeGreaterThan(0);

  for (let i = 0; i < n; i += 1) {
    const capture = await inputs.nth(i).getAttribute('capture');
    expect(capture, 'this input forces the camera and hides the device files').toBeNull();
    const accept = await inputs.nth(i).getAttribute('accept');
    expect(accept, 'it should still ask for images').toContain('image');
  }
});
