import { test, expect } from '@playwright/test';
import { api } from './helpers.js';

/**
 * Every page, at every width a shop actually uses.
 *
 * The failure this catches is horizontal overflow: a table or a fixed-width panel
 * wider than the viewport, so the whole page scrolls sideways and the sidebar drifts
 * off. On a phone that makes a page unusable rather than merely ugly, and it is
 * invisible at desktop width — which is where all the other tests run.
 *
 * A wide table is fine as long as IT scrolls; the document must not.
 */

const VIEWPORTS = [
  { name: 'phone', width: 360, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
];

const ROUTES = [
  ['/', 'dashboard'],
  ['/pos', 'pos'],
  ['/sales', 'sales'],
  ['/returns', 'returns'],
  ['/customers', 'customers'],
  ['/products', 'products'],
  ['/box-templates', 'box-templates'],
  ['/catalog-setup', 'catalog-setup'],
  ['/inventory', 'inventory'],
  ['/transfers', 'transfers'],
  ['/purchases', 'purchases'],
  ['/suppliers', 'suppliers'],
  ['/dealers', 'dealers'],
  ['/expenses', 'expenses'],
  ['/loans', 'loans'],
  ['/reports', 'reports'],
  ['/stores', 'stores'],
  ['/users', 'users'],
  ['/activity-log', 'activity-log'],
  ['/settings', 'settings'],
];

/**
 * How far the document scrolls sideways, and what is sticking out.
 *
 * A couple of pixels are rounding in a scrollbar-less headless browser, so the check
 * has a small tolerance; anything beyond that is a real layout break. The widest
 * offending element is reported, because "the page is too wide" is not actionable on
 * its own.
 */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    if (overflow <= 2) return { overflow, culprit: null };

    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const past = Math.round(r.right - doc.clientWidth);
      if (past > 2 && (!worst || past > worst.past)) {
        worst = {
          past,
          tag: el.tagName.toLowerCase(),
          cls: (el.className && String(el.className).slice(0, 80)) || '',
          testid: el.getAttribute('data-testid') || '',
        };
      }
    }
    return { overflow, culprit: worst };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const [route, name] of ROUTES) {
      test(`${name} fits`, async ({ page }) => {
        await page.goto(route);
        // Charts and images settle late; an early measurement reads a half-built page.
        await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
        await page.waitForTimeout(700);

        const { overflow, culprit } = await horizontalOverflow(page);
        expect(
          overflow,
          culprit
            ? `${name} overflows by ${overflow}px — widest offender <${culprit.tag} class="${culprit.cls}" data-testid="${culprit.testid}"> sticking out ${culprit.past}px`
            : `${name} overflows by ${overflow}px`
        ).toBeLessThanOrEqual(2);
      });
    }
  });
}

/**
 * The pages that are not a fixed URL, and the tabs that hold the widest tables.
 *
 * The branch comparison is ten columns and the branch price editor is seven with number
 * inputs in them — between them the widest things in the app. Neither is reachable from
 * a static route list: one needs a store id, the other is a tab.
 */
for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px) — deep pages`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('a branch page fits on every tab', async ({ page }) => {
      await page.goto('/');
      const stores = await api(page, 'GET', '/stores');
      const id = stores.body.data[0].id;

      for (const tab of ['overview', 'stock', 'staff', 'pricing']) {
        await page.goto(`/stores/${id}`);
        await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
        const button = page.getByTestId(`store-tab-${tab}`);
        if (!(await button.count())) continue;   // hidden without the permission
        await button.click();
        await page.waitForTimeout(700);

        const { overflow, culprit } = await horizontalOverflow(page);
        expect(
          overflow,
          culprit
            ? `store ${tab} tab overflows by ${overflow}px — widest offender <${culprit.tag} class="${culprit.cls}" data-testid="${culprit.testid}"> sticking out ${culprit.past}px`
            : `store ${tab} tab overflows by ${overflow}px`
        ).toBeLessThanOrEqual(2);
      }
    });

    test('the branch comparison fits', async ({ page }) => {
      await page.goto('/reports');
      await page.getByTestId('reports-tab-stores').click();
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
      await page.waitForTimeout(900);

      const { overflow, culprit } = await horizontalOverflow(page);
      expect(
        overflow,
        culprit
          ? `branch comparison overflows by ${overflow}px — widest offender <${culprit.tag} class="${culprit.cls}" data-testid="${culprit.testid}"> sticking out ${culprit.past}px`
          : `branch comparison overflows by ${overflow}px`
      ).toBeLessThanOrEqual(2);
    });

    test('the till fits with every filter row open', async ({ page }) => {
      await page.goto('/pos');
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
      const filters = page.getByTestId('pos-toggle-filters');
      if (await filters.count()) await filters.click().catch(() => {});
      await page.waitForTimeout(700);

      const { overflow, culprit } = await horizontalOverflow(page);
      expect(
        overflow,
        culprit
          ? `pos with filters overflows by ${overflow}px — widest offender <${culprit.tag} class="${culprit.cls}" data-testid="${culprit.testid}"> sticking out ${culprit.past}px`
          : `pos with filters overflows by ${overflow}px`
      ).toBeLessThanOrEqual(2);
    });
  });
}
