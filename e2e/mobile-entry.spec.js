import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * DATA ENTRY ON A PHONE.
 *
 * The existing responsive sweep checks DOCUMENT-level horizontal overflow, so a grid
 * that scrolls sideways inside its own container passes it. That is exactly what the
 * two entry grids did: the stock sheet showed 292px of 3688px — about two of forty
 * size columns — and the variant matrix 294px of 2539px. Nothing failed, and the
 * screens were unusable on a phone anyway.
 *
 * So this asserts the thing that was actually wrong: no element inside these screens
 * hides content sideways, and everything meant to be tapped is big enough to tap.
 */

const PHONE = { width: 360, height: 740 };
test.use({ viewport: PHONE });

/** Anything that scrolls sideways inside itself, worst first. */
async function hiddenSideways(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 8 || el.clientWidth <= 50) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') continue;
      // A chip row is allowed to scroll: the chips are large, self-labelling, and it
      // is obvious there are more. Forty anonymous size columns were not.
      if (el.classList.contains('phone-chips')) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 60),
        visible: Math.round(el.clientWidth),
        content: Math.round(el.scrollWidth),
        hidden: Math.round(over),
      });
    }
    return out.sort((a, b) => b.hidden - a.hidden);
  });
}

/** Controls below the 44px both Apple and Google publish as a reliable thumb target. */
async function tinyTargets(page, within) {
  return page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return [];
    const bad = [];
    for (const el of root.querySelectorAll('button, input, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 40) {
        bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return bad;
  }, within);
}

async function worstOffender(page, within) {
  const all = (await hiddenSideways(page))
    .filter((x) => !within || x.cls.includes(within));
  return all.length
    ? `<${all[0].tag} class="${all[0].cls}"> shows ${all[0].visible}px of ${all[0].content}px — ${all[0].hidden}px hidden`
    : null;
}

let ctx = { productId: null, productCode: null, multiId: null, multiCode: null };

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const prods = await api(page, 'GET', '/products', { params: { is_active: 'true', limit: '50' } });
  const rows = prods.body.data || [];
  const pick = rows.find((p) => Number(p.variant_count) > 1) || rows[0];
  ctx.productId = pick.id;
  ctx.productCode = pick.product_code;

  // A product with SEVERAL colours, so the chip badges have something to say. An
  // earlier version took whatever came first, which had one colour, and M4 skipped
  // itself every run — a test that never runs is not a passing test.
  for (const r of rows.slice(0, 25)) {
    const full = await api(page, 'GET', `/products/${r.id}`);
    const colours = (full.body?.data?.colors || []).filter((c) => !c.is_placeholder);
    if (colours.length >= 2) { ctx.multiId = r.id; ctx.multiCode = r.product_code; break; }
  }
  await page.close();
});

test('M1 · the stock sheet grid becomes a list, with nothing hidden sideways', async ({ page }) => {
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const sheetId = page.url().split('/').pop();

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(ctx.productCode, { delay: 20 });
  const opt = page.locator('.react-select__option').first();
  await expect(opt).toBeVisible({ timeout: 15_000 });
  await opt.click();

  // The list, not the table.
  const list = page.getByTestId('phone-size-list');
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.intake-grid')).toHaveCount(0);

  // THE REGRESSION THIS FILE EXISTS FOR.
  const worst = await worstOffender(page);
  expect(worst, `something still hides content sideways: ${worst}`).toBeNull();

  // Everything on the entry list is thumb-sized.
  const tiny = await tinyTargets(page, '[data-testid="phone-size-list"]');
  expect(tiny, `controls under 40px tall: ${tiny.join(', ')}`).toEqual([]);

  await shot(page, 'phone-intake-list');
  await api(page, 'DELETE', `/stock-intakes/${sheetId}`).catch(() => {});
});

test('M2 · quantities can be entered by tapping, and the running total follows', async ({ page }) => {
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const sheetId = page.url().split('/').pop();

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(ctx.productCode, { delay: 20 });
  await page.locator('.react-select__option').first().click();
  await expect(page.getByTestId('phone-size-list')).toBeVisible({ timeout: 20_000 });

  const firstRow = page.locator('.phone-size-row').first();
  const qty = firstRow.locator('input');
  const plus = firstRow.getByRole('button', { name: /add/i });

  // Minus is dead at zero rather than going negative — error prevention over an
  // error message.
  await expect(firstRow.getByRole('button', { name: /remove/i })).toBeDisabled();

  await plus.click();
  await plus.click();
  await expect(qty).toHaveValue('2');

  // The tally says where you are without scrolling anywhere.
  await expect(page.getByTestId('phone-tally')).toContainText('2');

  // Typing works too, for the box of twelve.
  await qty.fill('12');
  await expect(page.getByTestId('phone-tally')).toContainText('12');

  // And the filled row is marked, so gaps in a long run are visible.
  await expect(firstRow).toHaveClass(/phone-size-row--filled/);

  await shot(page, 'phone-intake-filled');
  await api(page, 'DELETE', `/stock-intakes/${sheetId}`).catch(() => {});
});

test('M3 · the variant matrix becomes a list too', async ({ page }) => {
  await page.goto(`/products/${ctx.productId}`);
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });

  const tab = page.getByRole('button', { name: /size variants/i });
  await tab.first().click();
  const add = page.getByRole('button', { name: /add variants/i });
  await add.first().click();

  await expect(page.getByTestId('phone-size-picker')).toBeVisible({ timeout: 20_000 });
  // The wide TABLE is not rendered at all, so there are no duplicate controls holding
  // two copies of the same selection. (`variant-matrix` is the component's outer
  // wrapper and is present in both layouts — other specs locate by it.)
  await expect(page.getByTestId('variant-matrix').locator('table')).toHaveCount(0);

  // Scoped to the picker: the product page also carries a read-only variants table,
  // which is allowed to scroll sideways so long as its first column stays put (see
  // M6). The entry control is the one that must not.
  const worst = await worstOffender(page, 'phone-');
  expect(worst, `the picker still hides content sideways: ${worst}`).toBeNull();

  // A size can be picked by tapping its whole row.
  const rows = page.locator('.phone-pick:not([disabled])');
  if (await rows.count()) {
    await rows.first().click();
    await expect(rows.first()).toHaveAttribute('data-state', 'selected');
  }
  await shot(page, 'phone-variant-picker');
});

test('M4 · the colour chips say what has already been entered against each', async ({ page }) => {
  expect(ctx.multiCode, 'no product in this database has two colours to test with').toBeTruthy();
  // Splitting the grid one colour at a time costs the overview it gave for free.
  // The badges are how that is bought back — without them the person has to remember
  // which colours are done, which is exactly what a screen should be doing.
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const sheetId = page.url().split('/').pop();

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(ctx.multiCode, { delay: 20 });
  await page.locator('.react-select__option').first().click();
  await expect(page.getByTestId('phone-size-list')).toBeVisible({ timeout: 20_000 });

  const chips = page.locator('.phone-chip');
  await expect(chips.nth(1)).toBeVisible({ timeout: 10_000 });

  // Enter against the first colour, then move to the second.
  await page.locator('.phone-size-row').first().locator('input').fill('3');
  await expect(chips.first().locator('.phone-chip__count')).toHaveText('3');

  await chips.nth(1).click();
  await expect(page.getByTestId('phone-active-color')).not.toBeEmpty();
  // The first colour keeps its badge while a different one is being filled.
  await expect(chips.first().locator('.phone-chip__count')).toHaveText('3');
  // ...and the new colour starts empty rather than inheriting the last one.
  await expect(page.locator('.phone-size-row').first().locator('input')).toHaveValue('');

  await shot(page, 'phone-colour-chips');
  await api(page, 'DELETE', `/stock-intakes/${sheetId}`).catch(() => {});
});

test('M5 · the wide layout is untouched on a desktop width', async ({ page }) => {
  // The phone layout must not leak upward: the table is faster when it fits, and a
  // list of forty sizes on a 1440px screen would be a step backwards.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/products/${ctx.productId}`);
  await page.getByRole('button', { name: /size variants/i }).first().click();
  await page.getByRole('button', { name: /add variants/i }).first().click();

  await expect(page.getByTestId('variant-matrix').locator('table')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('phone-size-picker')).toHaveCount(0);
});

test('M6 · a read table that scrolls keeps its first column in view', async ({ page }) => {
  // Read tables are allowed to scroll sideways — squeezing eight columns into 360px
  // is worse. What is not allowed is losing track of WHICH ROW you are reading, so
  // the identifying first cell stays put while the rest moves under it.
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: /inventory/i }).first()).toBeVisible({ timeout: 30_000 });

  const container = page.locator('.table-container').first();
  await expect(container).toBeVisible({ timeout: 20_000 });
  const over = await container.evaluate((el) => el.scrollWidth - el.clientWidth);
  test.skip(over <= 8, 'this table already fits — nothing to pin');

  const firstCell = container.locator('tbody tr td:first-child').first();
  await expect(firstCell).toBeVisible();
  const before = await firstCell.evaluate((el) => Math.round(el.getBoundingClientRect().left));

  await container.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(250);

  const after = await firstCell.evaluate((el) => Math.round(el.getBoundingClientRect().left));
  expect(Math.abs(after - before), `the first column scrolled away (${before} -> ${after})`).toBeLessThanOrEqual(2);
  await expect(firstCell).toBeInViewport();
  await shot(page, 'phone-sticky-first-column');
});

test('M7 · only the sizes this product carries are offered, with the rest one tap away', async ({ page }) => {
  // A shoe category lists 41 sizes and a product usually stocks six. Offering all 41
  // means scrolling past thirty-five irrelevant rows for every colour, which on a
  // phone is most of the work.
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const sheetId = page.url().split('/').pop();

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(ctx.productCode, { delay: 20 });
  await page.locator('.react-select__option').first().click();
  await expect(page.getByTestId('phone-size-list')).toBeVisible({ timeout: 20_000 });

  const rows = page.locator('.phone-size-row');
  const shortlisted = await rows.count();

  const more = page.getByTestId('phone-show-all-sizes');
  if (await more.count()) {
    // The shortlist is genuinely shorter, and the rest are reachable.
    await expect(more).toContainText(/\d+/);
    await more.click();
    await expect(page.getByTestId('phone-show-all-sizes')).toHaveCount(0);
    expect(await rows.count(), 'showing all did not reveal more sizes').toBeGreaterThan(shortlisted);
  } else {
    // No shortlist possible — a product with no variants yet. The full list is then
    // correct, and the toggle rightly does not appear.
    expect(shortlisted).toBeGreaterThan(0);
  }

  await shot(page, 'phone-size-shortlist');
  await api(page, 'DELETE', `/stock-intakes/${sheetId}`).catch(() => {});
});

test('M8 · a number already typed is never hidden by the shortlist', async ({ page }) => {
  // The shortlist must never swallow somebody's work. A size typed into while the
  // full list was open has to survive collapsing back to the shortlist — otherwise
  // the number is still in the sheet but nowhere on screen, which is the worst of
  // both: invisible and about to be posted.
  await page.goto('/stock-intakes');
  await expect(page.getByTestId('intake-tab-sheets')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /new sheet/i }).click();
  await page.waitForURL(/\/stock-intakes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const sheetId = page.url().split('/').pop();

  await page.locator('.react-select__control').last().click();
  await page.keyboard.type(ctx.productCode, { delay: 20 });
  await page.locator('.react-select__option').first().click();
  await expect(page.getByTestId('phone-size-list')).toBeVisible({ timeout: 20_000 });

  const more = page.getByTestId('phone-show-all-sizes');
  test.skip(!(await more.count()), 'this product stocks every size — nothing is hidden');

  const shortRows = await page.locator('.phone-size-row').count();
  await more.click();

  // A size outside the shortlist: the last one, which the shortlist did not include.
  const rows = page.locator('.phone-size-row');
  const last = rows.last();
  const outsiderLabel = (await last.locator('.phone-size-row__label').textContent()).trim();
  await last.locator('input').fill('4');

  // Collapse back.
  await page.getByTestId('phone-show-fewer-sizes').click();
  await expect(page.getByTestId('phone-show-all-sizes')).toBeVisible();

  // The shortlist grew by exactly that one size, and the number is still on screen.
  const nowRows = page.locator('.phone-size-row');
  expect(await nowRows.count(), 'the typed size was dropped from the shortlist')
    .toBe(shortRows + 1);
  const kept = nowRows.filter({ hasText: outsiderLabel });
  await expect(kept).toHaveCount(1);
  await expect(kept.locator('input')).toHaveValue('4');

  await shot(page, 'phone-shortlist-keeps-entry');
  await api(page, 'DELETE', `/stock-intakes/${sheetId}`).catch(() => {});
});
