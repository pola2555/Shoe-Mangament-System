import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { login, ADMIN, api } from './helpers.js';

export const STATE_FILE = path.join(process.cwd(), 'e2e', '.auth', 'admin.json');

/**
 * Authenticate once for the whole run.
 *
 * /api/auth/login is rate-limited (10 per 15 min in production; the test webServer
 * raises it via LOGIN_RATE_MAX), so logging in per-test exhausts the budget and later
 * tests fail at the login screen for reasons unrelated to what they cover.
 *
 * The state is NOT cached between runs: the access token lives 15 minutes and refresh
 * tokens rotate on use, so a reused file goes stale in a way that shows up as a
 * confusing 401 in the middle of an unrelated test.
 */
setup('authenticate', async ({ page }) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  await login(page, ADMIN);
  await expect(page).not.toHaveURL(/login/);
  await page.context().storageState({ path: STATE_FILE });

  await assertRateLimitRaised(page);
  await warmDevServer(page);
});

/**
 * Fail fast if the API is running with the production rate limit.
 *
 * `reuseExistingServer` means a backend left over from an earlier session gets picked
 * up as-is. If that one started without API_RATE_MAX, the suite quietly burns through
 * the production default of 200 requests a minute and dies somewhere in the middle
 * with a 429 that reads like missing data — which is exactly what happened, twice.
 * One header check here turns that into a message that says what to do.
 */
async function assertRateLimitRaised(page) {
  const limit = await page.evaluate(async () => {
    const res = await fetch('/api/products');
    return res.headers.get('RateLimit-Limit');
  });
  expect(
    Number(limit),
    'The API is running with the production rate limit (' + limit + '/min) and this ' +
      'suite will trip it. Stop the backend and let Playwright start it, or export ' +
      'API_RATE_MAX before starting it yourself.'
  ).toBeGreaterThan(1000);
}

/**
 * Visit every route the suite touches, once, before any test runs.
 *
 * Vite optimises dependencies lazily. Discovering a new one mid-run triggers a
 * re-bundle AND a full page reload, which showed up as a single ~20 second stall
 * landing on a different test every run — long enough to blow the 15 s action
 * timeout and read as a random flake. Paying it here makes the rest deterministic,
 * and a slow warm-up here costs nothing because setup has no assertions to race.
 *
 * Every step is best-effort: warming must never be the reason a run fails.
 */
async function warmDevServer(page) {
  const visit = async (route) => {
    try {
      await page.goto(route, { waitUntil: 'networkidle', timeout: 45_000 });
    } catch {
      // Nothing to do — the route will just compile on first real use instead.
    }
  };

  for (const route of ['/inventory', '/products', '/purchases/invoices']) await visit(route);

  // Product detail is its own chunk, and it owns the label-printing dialog.
  try {
    const res = await api(page, 'GET', '/products', { params: { limit: '1' } });
    const id = res.body?.data?.[0]?.id;
    if (id) {
      await visit(`/products/${id}`);
      await page.getByTestId('product-print-labels').click({ timeout: 5_000 });
    }
  } catch {
    // No products in this dataset, or the button moved; neither is fatal here.
  }

  // The POS scanner pulls ZXing through a dynamic import — the largest chunk the
  // suite loads, and the one most likely to stall a test mid-scan.
  await visit('/pos');
  try {
    await page.getByTestId('pos-scan-button').click({ timeout: 5_000 });
    await page.waitForTimeout(1500);
  } catch {
    // Scanner unavailable in this environment; the tests cover that case themselves.
  }
}
