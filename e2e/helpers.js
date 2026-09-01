import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export const ADMIN = { username: 'admin', password: 'admin123' };
export const API = 'http://localhost:5000/api';

const SHOTS = path.join(process.cwd(), 'e2e', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let shotSeq = 0;
/** Numbered screenshot so the folder reads in execution order. */
export async function shot(page, name, opts = {}) {
  shotSeq += 1;
  const file = path.join(SHOTS, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false, ...opts });
  return file;
}

/** Screenshot one element rather than a page region. */
export async function shotOf(locator, name) {
  shotSeq += 1;
  const file = path.join(SHOTS, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  await locator.screenshot({ path: file });
  return file;
}

/** Log in through the real UI and land on the dashboard. */
export async function login(page, user = ADMIN) {
  await page.goto('/login');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20_000 });
  // The app stores the token on success; waiting for it avoids racing the first
  // authenticated fetch on the page we navigate to next.
  await page.waitForFunction(() => !!localStorage.getItem('accessToken'), { timeout: 15_000 });
}

/** Access token from the app's own storage, for direct API calls in tests. */
export async function tokenOf(page) {
  return page.evaluate(() =>
    localStorage.getItem('accessToken') ||
    localStorage.getItem('access_token') ||
    localStorage.getItem('token')
  );
}

/** Call the API with the logged-in user's token, from inside the page. */
export async function api(page, method, urlPath, { params, body } = {}) {
  return page.evaluate(async ({ method, urlPath, params, body, base }) => {
    const token =
      localStorage.getItem('accessToken') ||
      localStorage.getItem('access_token') ||
      localStorage.getItem('token');
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await fetch(base + urlPath + qs, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    // 429 from the global limiter is the most common non-obvious failure in a test
    // run; surfacing the status keeps it from looking like missing data.
    return { status: res.status, ok: res.ok, body: json };
  }, { method, urlPath, params, body, base: '/api' });
}

/**
 * Type a barcode the way a hardware wedge scanner does: characters a few ms apart,
 * then Enter. The app distinguishes a scanner from a person purely by this timing, so
 * the delay is the thing under test — a slow "scan" must NOT be treated as one.
 */
export async function hardwareScan(page, code, { perCharMs = 0 } = {}) {
  for (const ch of String(code)) {
    await page.keyboard.press(ch);
    if (perCharMs) await page.waitForTimeout(perCharMs);
  }
  await page.keyboard.press('Enter');
}

/** Type at human speed, to prove the scanner heuristic does not fire. */
export async function humanType(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press('Enter');
}

/** Pick a store in the POS store selector and wait for it to settle. */
export async function selectPosStore(page, storeName) {
  const select = page.locator('select').first();
  if (await select.count()) {
    await select.selectOption({ label: storeName }).catch(async () => {
      await select.selectOption({ index: 1 });
    });
  }
  await page.waitForTimeout(400);
}

export { expect };

/**
 * Wait for the POS scan strip to settle and report what it says.
 * Asserting on scan-ok directly hides the reason when a scan fails, so read the strip
 * and let the caller assert on the actual text.
 */
export async function scanResult(page, timeout = 12_000) {
  const strip = page.getByTestId('pos-scan-strip');
  await expect(strip).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="pos-scan-strip"]');
    return el && (el.querySelector('[data-testid="scan-ok"]') || el.querySelector('[data-testid="scan-err"]'));
  }, undefined, { timeout });

  const okEl = page.getByTestId('scan-ok');
  if (await okEl.count()) return { ok: true, text: (await okEl.textContent()) || '' };
  return { ok: false, text: (await page.getByTestId('scan-err').textContent()) || '' };
}
