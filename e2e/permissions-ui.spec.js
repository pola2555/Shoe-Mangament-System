import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';

/**
 * CAN THE OWNER ACTUALLY GRANT A PERMISSION?
 *
 * Every guard in this system reads a `user_permissions` row, and the only way to write
 * one is this dialog. So a permission the dialog does not draw is a feature nobody can
 * switch on — the code exists, the migration inserted it, the server enforces it, and
 * there is no route to it from any screen.
 *
 * That is precisely what happened: the dialog rendered a hand-kept array of 30 codes
 * while the permissions table had grown to 46. `price_override` — the gate PLAN 3 put
 * in front of changing a sale price — was one of the sixteen that could not be granted.
 *
 * The assertion is therefore not "price_override is present" (which a second hand-kept
 * list would satisfy while rotting in the same way) but "the dialog draws EVERY code the
 * server reports". A migration that adds a permission cannot pass this without the UI
 * picking it up on its own.
 *
 * Nothing here uploads an image. Local dev writes to a real S3 bucket.
 */

test.describe.configure({ mode: 'serial' });

test('U1 · the permissions dialog offers every permission the server has', async ({ page }) => {
  await page.goto('/users');

  const perms = await api(page, 'GET', '/users/permissions');
  expect(perms.status, JSON.stringify(perms.body)).toBe(200);
  const codes = perms.body.data.map((p) => p.code);
  expect(codes.length).toBeGreaterThan(30);

  const users = await api(page, 'GET', '/users');
  const target = users.body.data.find((u) => u.username === 'admin') || users.body.data[0];

  await expect(page.getByTestId(`perm-open-${target.id}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`perm-open-${target.id}`).click();
  await expect(page.getByTestId('perm-save')).toBeVisible({ timeout: 20_000 });

  const missing = [];
  for (const code of codes) {
    if (await page.getByTestId(`perm-row-${code}`).count() === 0) missing.push(code);
  }
  expect(missing, `these permissions cannot be granted from the UI: ${missing.join(', ')}`)
    .toEqual([]);

  await shot(page, 'perms-dialog');
});

test('U2 · price_override can be granted, and the grant survives a reopen', async ({ page }) => {
  await page.goto('/users');

  // A throwaway account, so the test never edits a real person's access. Reused across
  // runs rather than minted each time.
  const username = 'e2e_perm_probe';
  const existing = await api(page, 'GET', '/users', { params: { limit: '200' } });
  let probe = existing.body.data.find((u) => u.username === username);
  if (!probe) {
    const made = await api(page, 'POST', '/users', {
      body: {
        username,
        password: 'Probe!2345',
        full_name: 'Permission probe',
        email: `${username}@example.com`,
        role_id: 3,
      },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    probe = made.body.data;
  }

  // Start from nothing, so the assertion below is about this test's own click.
  await api(page, 'PUT', `/users/${probe.id}/permissions`, { body: { permissions: [] } });

  await page.reload();
  await page.getByTestId(`perm-open-${probe.id}`).click();
  const row = page.getByTestId('perm-row-price_override');
  await expect(row).toBeVisible({ timeout: 20_000 });

  // The row cycles none → read → write. Two clicks is the grant that matters: the
  // server checks `price_override` at write level before it will accept a changed price.
  await row.click();
  await row.click();
  await expect(row).toContainText(/write|كتابة/i);
  await page.getByTestId('perm-save').click();
  // The dialog closes only after the PUT resolves, so this is the save completing —
  // reading the user back without it races the request that is still in flight.
  await expect(page.getByTestId('perm-save')).toBeHidden({ timeout: 20_000 });

  const after = await api(page, 'GET', `/users/${probe.id}`);
  const granted = (after.body.data.permissions || [])
    .find((p) => p.permission_code === 'price_override');
  expect(granted, 'price_override was not written').toBeTruthy();
  expect(granted.access_level).toBe('write');

  await api(page, 'PUT', `/users/${probe.id}/permissions`, { body: { permissions: [] } });
});

test('U3 · "All write" does not silently strip a permission it never showed', async ({ page }) => {
  await page.goto('/users');

  const users = await api(page, 'GET', '/users', { params: { limit: '200' } });
  const probe = users.body.data.find((u) => u.username === 'e2e_perm_probe');
  test.skip(!probe, 'probe account missing');

  // Hand-granted, the way an admin would through the API or a seed.
  await api(page, 'PUT', `/users/${probe.id}/permissions`, {
    body: { permissions: [{ permission_code: 'shifts', access_level: 'write' }] },
  });

  await page.reload();
  await page.getByTestId(`perm-open-${probe.id}`).click();
  await expect(page.getByTestId('perm-row-shifts')).toBeVisible({ timeout: 20_000 });

  // The old dialog rebuilt the map from its fixed array here, so anything held but
  // unlisted was dropped without ever appearing on screen — a grant deleted by a click
  // that reads as "give this person everything".
  await page.getByRole('button', { name: /all write|كتابة الكل/i }).click();
  await page.getByTestId('perm-save').click();
  await expect(page.getByTestId('perm-save')).toBeHidden({ timeout: 20_000 });

  const after = await api(page, 'GET', `/users/${probe.id}`);
  const held = (after.body.data.permissions || []).map((p) => p.permission_code);
  expect(held, 'shifts was wiped by All write').toContain('shifts');
  expect(held).toContain('price_override');

  await api(page, 'PUT', `/users/${probe.id}/permissions`, { body: { permissions: [] } });
});

test('U4 · no permission renders as a raw translation key', async ({ page }) => {
  for (const locale of ['en', 'ar']) {
    await page.goto('/settings');
    await page.evaluate((l) => {
      localStorage.setItem('locale', l);
      window.dispatchEvent(new CustomEvent('user-preferences', { detail: { locale: l } }));
    }, locale);

    await page.goto('/users');
    const users = await api(page, 'GET', '/users');
    const target = users.body.data[0];
    await page.getByTestId(`perm-open-${target.id}`).click();
    await expect(page.getByTestId('perm-save')).toBeVisible({ timeout: 20_000 });

    // t() returns the key itself when it cannot resolve one, so an unlabelled code
    // reads as `users.permission_labels.price_override` on screen — the same failure
    // as the `sidebar.management` heading found in PLAN 7.
    const dialog = page.locator('.modal-content').last();
    const text = await dialog.innerText();
    const raw = text.split('\n').map((s) => s.trim())
      .filter((s) => /^[a-z_]+\.[a-z0-9_.]+$/.test(s));
    expect(raw, `${locale}: untranslated permission keys`).toEqual([]);

    await page.keyboard.press('Escape').catch(() => {});
  }

  await page.evaluate(() => {
    localStorage.setItem('locale', 'en');
    window.dispatchEvent(new CustomEvent('user-preferences', { detail: { locale: 'en' } }));
  });
});
