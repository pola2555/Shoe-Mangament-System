import { test, expect } from '@playwright/test';
import { shot } from './helpers.js';

/**
 * THE MENU STAYS WHERE THE USER LEFT IT.
 *
 * The sidebar is taller than most screens — five groups, twenty-odd links — so anybody
 * working out of the bottom of it (Reports, Stores, Users, Activity log) scrolls down
 * to reach their page. It then jumped back to the top on every single click, and had
 * to be scrolled down again for the next one.
 *
 * Two separate causes, both in App.jsx, both of which tore the whole sidebar down and
 * rebuilt it:
 *   - the route error boundary was keyed on the pathname, so EVERY navigation
 *     remounted the entire tree, chrome included;
 *   - <Suspense> sat above the layout, so the first visit to any code-split page
 *     replaced the whole app with a spinner while the chunk downloaded.
 *
 * A remounted element starts at scrollTop 0. Both now live inside the layout, around
 * the page outlet only.
 *
 * The viewport is deliberately short: at a tall desktop height the menu does not
 * overflow at all and the test would pass without proving anything.
 */

const NAV = '.sidebar__nav';

test.use({ viewport: { width: 1280, height: 620 } });

test('the sidebar keeps its scroll position across navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(NAV)).toBeVisible({ timeout: 30_000 });

  const nav = page.locator(NAV);

  // The premise. If the menu fits, there is nothing to preserve and a pass would be
  // meaningless — so this fails loudly rather than skipping quietly.
  const overflow = await nav.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, 'the menu must overflow for this test to mean anything').toBeGreaterThan(40);

  // Scrolled to the bottom, which is where somebody reaching Reports or Users ends up.
  //
  // It has to be a link ALREADY IN VIEW at this position. Playwright scrolls an element
  // into view before clicking it, so clicking an off-screen link moves the menu itself
  // and the test then measures its own interference rather than the app's.
  await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const before = await nav.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await shot(page, 'sidebar-scrolled');

  const inView = async (name) => {
    const box = await page.getByRole('link', { name }).boundingBox();
    const navBox = await nav.boundingBox();
    return box && navBox && box.y >= navBox.y && box.y + box.height <= navBox.y + navBox.height;
  };
  expect(await inView(/^reports$/i), 'Reports should be visible at the bottom').toBe(true);

  // Navigate the way a person does. Reports is code-split, so this exercises the
  // Suspense path as well as the error-boundary one.
  await page.getByRole('link', { name: /^reports$/i }).click();
  await page.waitForURL(/\/reports/, { timeout: 30_000 });
  await expect(page.locator(NAV)).toBeVisible();

  const after = await nav.evaluate((el) => el.scrollTop);
  expect(after, `menu jumped from ${before} to ${after}`).toBe(before);

  // And again, to a second page — a chunk already cached takes a different path
  // through Suspense than one being fetched.
  await page.getByRole('link', { name: /^stores$/i }).click();
  await page.waitForURL(/\/stores/, { timeout: 30_000 });
  expect(await nav.evaluate((el) => el.scrollTop)).toBe(before);
  await shot(page, 'sidebar-kept-position');
});

test('the sidebar element survives navigation rather than being rebuilt', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(NAV)).toBeVisible({ timeout: 30_000 });

  // Stamp the live DOM node. If anything remounts the sidebar the stamp is gone with
  // it — a stricter statement than the scroll check, and the actual root cause.
  await page.locator(NAV).evaluate((el) => { el.dataset.stamp = 'original'; });

  await page.getByRole('link', { name: /^reports$/i }).click();
  await page.waitForURL(/\/reports/, { timeout: 30_000 });
  await expect(page.locator(NAV)).toHaveAttribute('data-stamp', 'original');

  await page.getByRole('link', { name: /^customers$/i }).click();
  await page.waitForURL(/\/customers/, { timeout: 30_000 });
  await expect(page.locator(NAV)).toHaveAttribute('data-stamp', 'original');
});

test('the position is remembered across a reload', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.locator(NAV)).toBeVisible({ timeout: 30_000 });
  const nav = page.locator(NAV);

  const overflow = await nav.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeGreaterThan(40);

  const target = Math.min(100, overflow);
  // Set via a real scroll event so the listener that persists it actually fires.
  await nav.evaluate((el, top) => { el.scrollTop = top; el.dispatchEvent(new Event('scroll')); }, target);
  await page.waitForTimeout(250);   // the write is rAF-throttled

  await page.reload();
  await expect(page.locator(NAV)).toBeVisible({ timeout: 30_000 });
  // Within a pixel or two: a reload can land with a marginally different menu height.
  const after = await page.locator(NAV).evaluate((el) => el.scrollTop);
  expect(Math.abs(after - target)).toBeLessThanOrEqual(4);
});

/*
 * NOT TESTED HERE: that a page which fails to load leaves the menu usable.
 *
 * Moving the error boundary inside the layout means a broken page now renders its
 * error inside the frame, with the menu still there to click somewhere else. Proving
 * it needs a chunk request to fail, and that cannot be simulated honestly in this
 * environment: the service worker (frontend/public/sw.js) answers the module from its
 * own cache, so no network request reaches Playwright's interception and the page
 * simply loads. A version of this test did "pass" that way, having asserted nothing.
 *
 * The boundary's placement is covered indirectly — every page in the suite renders
 * through it, and the remount test above is the behaviour that actually regressed.
 */
