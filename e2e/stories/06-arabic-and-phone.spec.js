import { test, expect, devices } from '@playwright/test';
import { api, shot } from '../helpers.js';
import { loadWorld, pageAs, closePage, takePair, cleanup, priceOf } from './world.js';

/**
 * THE SHOP IN ARABIC, AND THE SHOP ON A PHONE.
 *
 * Two audiences that are easy to break without noticing, because nobody developing in
 * English on a laptop sees either. The Arabic side is not only translation: the whole
 * layout mirrors, so a hard-coded `paddingLeft` indents the wrong side and a size
 * written "EU 42" has to come out of the shop's own Arabic size list.
 */

const world = loadWorld();
const claimed = new Set();
const made = { saleIds: [] };

test.describe.configure({ mode: 'serial' });

const A = () => world.stores.A.id;

/** Switch the signed-in user's language through Settings, the way a person would. */
async function setLanguage(page, lang) {
  await page.goto('/settings');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: lang === 'ar' ? /العربية|arabic/i : /english/i }).first().click();
  await page.waitForTimeout(800);
}

test.afterAll(async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');
  await cleanup(api, page, made);
  // Leave the account in English, however this file ended.
  await setLanguage(page, 'en');
  await closePage(page);
});

// ─────────────────────────────────────────────────────── Arabic

test('A1 · Mona switches to Arabic and the whole shop turns around', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await setLanguage(page, 'ar');

  for (const route of ['/', '/pos', '/inventory', '/expenses', '/reports', '/stores', '/sales']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(900);

    const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
    expect(dir, `${route} must mirror in Arabic`).toBe('rtl');

    // A raw dotted key on screen is an untranslated string. It is the only way a
    // missing translation shows up at all.
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

    // And no unfilled {placeholder} left in a sentence.
    const braces = await page.evaluate(() => (document.body.innerText.match(/\{[a-z_]+\}/g) || []).slice(0, 5));
    expect(braces, `${route} has unfilled placeholders`).toEqual([]);
  }
  await shot(page, 'story-arabic-reports');
  await closePage(page);
});

test('A2 · a sock reads as its Arabic size, not as its stored code', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await setLanguage(page, 'ar');

  // The sock sizes are stored as KIDS/ADULTS and have Arabic labels on the size list.
  // The screen must show the label, not the code.
  const rows = await api(page, 'GET', '/inventory', {
    params: { store_id: A(), product_id: world.products.sock.id, status: 'in_stock', limit: '20' },
  });
  expect(rows.body.data.length).toBeGreaterThan(0);
  const withLabel = rows.body.data.find((r) => r.size_label_ar);
  expect(withLabel, 'the API must carry the Arabic size label').toBeTruthy();

  // The inventory page opens as a collapsed Product -> Colour -> Size tree, so the
  // sizes are not on screen until the product is opened. Searching narrows it to the
  // sock first, which is what a person would do anyway.
  await page.goto('/inventory');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.locator('input[type="text"]').first().fill('Story Sock');
  await page.waitForTimeout(1500);

  const productRow = page.locator('tr', { hasText: 'Story Sock' }).first();
  await expect(productRow).toBeVisible({ timeout: 20_000 });
  await productRow.click();
  await page.waitForTimeout(600);
  // Colour, then size.
  const colourRow = page.locator('tr', { hasText: 'Grey' }).first();
  if (await colourRow.count()) { await colourRow.click(); await page.waitForTimeout(600); }

  const body = await page.locator('body').innerText();
  expect(body, 'the Arabic size label should be on screen, not the stored code')
    .toContain(withLabel.size_label_ar);

  // The raw code may appear INSIDE a SKU — STORY-SOCK-GRE-ADULTS is the identifier
  // and is meant to be stable and language-free. What must not happen is a cell whose
  // whole content is the bare code, because that is a size being shown unformatted.
  const cells = await page.locator('td').allInnerTexts();
  const bare = cells.map((c) => c.trim()).filter((c) => c === withLabel.size_eu);
  expect(bare, `a cell shows the raw size code "${withLabel.size_eu}" instead of its label`).toEqual([]);
  await shot(page, 'story-arabic-sizes');
  await closePage(page);
});

test('A2b · no screen carries a hard-coded language of its own', async ({ browser }) => {
  // The Word export button was written in Arabic, so an English toolbar had one
  // Arabic label in the middle of it. A string that ignores the language setting is
  // invisible to whoever speaks the other one.
  const page = await pageAs(browser, 'manager');
  await setLanguage(page, 'en');

  const ARABIC = /[؀-ۿ]/;
  for (const route of ['/', '/pos', '/inventory', '/expenses', '/reports', '/stores', '/sales', '/products']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(900);

    // Data can legitimately be Arabic — a customer called دنيا. Only the chrome is
    // checked: buttons, headings, labels and table headers.
    const chrome = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, label, th, h1, h2, h3, .form-label, .tab')) {
        const t = (el.textContent || '').trim();
        if (t) out.push(t);
      }
      return out;
    });
    const arabic = chrome.filter((t) => ARABIC.test(t));
    expect(arabic, `${route} has Arabic hard-coded into an English screen`).toEqual([]);
  }
  await closePage(page);
});

test('A3 · a whole sale, in Arabic, from the till', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await setLanguage(page, 'ar');

  const pair = await takePair(api, page, { storeId: A(), productId: world.products.shoe.id, exclude: claimed });
  const sale = await api(page, 'POST', '/sales', {
    body: {
      store_id: A(), customer_id: world.customers.arabic.id,
      items: [{ id: pair.id, sale_price: priceOf(pair, world.products.shoe.price) }],
      payments: [{ amount: priceOf(pair, world.products.shoe.price), payment_method: 'cash' }],
    },
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  made.saleIds.push(sale.body.data.id);

  await page.goto('/sales');
  await page.waitForTimeout(1500);
  await page.getByTestId(`sale-row-${sale.body.data.id}`).click();
  await expect(page.getByRole('heading', { name: sale.body.data.sale_number })).toBeVisible({ timeout: 20_000 });

  const modal = await page.locator('.modal-content').innerText();
  expect(modal, "the customer's Arabic name must render").toContain(world.customers.arabic.name);
  expect(modal, 'the stand-in colour must not leak, in any language').not.toMatch(/Standard/);
  await shot(page, 'story-arabic-sale');
  await closePage(page);
});

test('A4 · the till in Arabic still filters by size and colour', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await setLanguage(page, 'ar');

  await page.goto('/pos');
  await expect(page.getByTestId('pos-categories')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('pos-toggle-filters').click();
  await expect(page.getByTestId('pos-colors')).toBeVisible({ timeout: 20_000 });

  // The chip rows scroll sideways rather than pushing the page wide — in a mirrored
  // layout the direction of that scroll is the one people get wrong.
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(overflow, 'the Arabic till must not scroll sideways').toBeLessThanOrEqual(2);
  await shot(page, 'story-arabic-till');
  await closePage(page);
});

// ─────────────────────────────────────────────────────── on a phone

test('A5 · Karim serves a customer standing up, on a phone', async ({ browser }) => {
  const page = await pageAs(browser, 'cashier', { ...devices['Pixel 7'] });
  await page.goto('/pos');
  await expect(page.getByTestId('pos-scan-strip')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'story-phone-till');

  // The products and cart are separate tabs on a phone, and both must be reachable.
  await expect(page.locator('.pos-mobile-tabs')).toBeVisible();
  await page.getByRole('button', { name: /cart/i }).first().click();
  await expect(page.locator('.pos-cart-panel')).toBeVisible();

  // Nothing overflows sideways at 412px, which is where a page becomes unusable
  // rather than merely cramped.
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(overflow, 'the phone till must not scroll sideways').toBeLessThanOrEqual(2);
  await closePage(page);
});

test('A6 · the branch pages hold together on a phone', async ({ browser }) => {
  const page = await pageAs(browser, 'manager', { ...devices['Pixel 7'] });

  for (const route of ['/stores', `/stores/${A()}`, '/reports', '/expenses']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);
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
  await shot(page, 'story-phone-branch');
  await closePage(page);
});

test('A7 · a label still prints correctly for a belt and a knife', async ({ browser }) => {
  const page = await pageAs(browser, 'manager');
  await page.goto('/');

  for (const key of ['belt', 'tool']) {
    const labels = await api(page, 'GET', '/barcodes/labels', {
      params: { product_id: world.products[key].id, store_id: A() },
    });
    expect(labels.status).toBe(200);
    expect(labels.body.data.length, `${key} must have labels`).toBeGreaterThan(0);

    for (const row of labels.body.data) {
      // A belt is measured in cm and a knife has no size at all. Neither may come out
      // claiming an EU shoe size, and neither may print the stand-in colour.
      if (key === 'belt') {
        expect(row.size_prefix || '', 'a belt is not sized in EU').not.toBe('EU');
      }
      if (key === 'tool') {
        expect(row.color_is_placeholder, 'a knife carries the stand-in colour').toBe(true);
      }
      expect(String(row.price_code), 'the price is coded, never plain').toMatch(/[A-Z]/);
      expect(String(row.barcode)).toMatch(/^\d{13}$/);
    }
  }
  await closePage(page);
});
