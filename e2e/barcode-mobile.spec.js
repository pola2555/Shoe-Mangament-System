import { test, expect } from '@playwright/test';
import { api, shot } from './helpers.js';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const sharp = require('./backend/node_modules/sharp');

/**
 * Mobile POS: the phone-camera and photo-upload paths.
 *
 * The upload tier is the one that carries real weight — a file input needs no secure
 * context, so it is the only camera path that works on the current plain-HTTP
 * deployment. It is also the fallback on any device with no usable camera.
 */

const TMP = path.join(process.cwd(), 'e2e', '.artifacts', 'images');
let fixture = {};

/** Render a barcode to a PNG the way a phone photo of a label would look. */
async function barcodePng(code, { blur = 0, rotate = 0, scale = 4 } = {}) {
  const { encodeEan13Bars, isGuardModule, QUIET_LEFT, QUIET_RIGHT, EAN13_MODULES } =
    await import('../frontend/src/utils/ean13.js');

  const mod = 0.25, barH = 8.5, guard = 0.9;
  const total = EAN13_MODULES + QUIET_LEFT + QUIET_RIGHT;
  const w = total * mod, h = barH + guard + 3;
  const rects = encodeEan13Bars(code)
    .map((b) => `<rect x="${(QUIET_LEFT + b.x) * mod}" y="0" width="${b.width * mod}" height="${barH + (isGuardModule(b.x) ? guard : 0)}" fill="#000"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${rects}</svg>`;

  let img = sharp(Buffer.from(svg), { density: 203 * scale }).flatten({ background: '#fff' });
  if (rotate) img = img.rotate(rotate, { background: '#fff' });
  if (blur) img = img.blur(blur);
  return img.png().toBuffer();
}

async function writePng(name, buf) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const inv = await api(page, 'GET', '/inventory', { params: { status: 'in_stock', limit: '200' } });
  expect(inv.status).toBe(200);
  const rows = (inv.body.data || []).filter((i) => i.barcode);
  expect(rows.length).toBeGreaterThan(0);
  fixture.item = rows[0];
  fixture.barcode = rows[0].barcode;
  fixture.storeId = rows[0].store_id;
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([store]) => {
    localStorage.setItem('pos_store', store);
    localStorage.removeItem('pos_cart');
  }, [fixture.storeId]);
});

/**
 * Force the photo/upload tier by removing getUserMedia — which is exactly what the
 * browser does on a plain-HTTP origin, and what a device with no camera looks like.
 */
async function gotoPosWithoutCamera(page) {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true, value: undefined,
      });
    }
  });
  await openPos(page);
}

async function openPos(page) {
  await page.goto('/pos');
  await page.locator('.pos-products-grid, .pos-empty-state').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(200);
}

/** Open the scanner already in photo mode. */
async function openPhotoScanner(page) {
  await gotoPosWithoutCamera(page);
  await page.getByTestId('pos-scan-button').click();
  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('barcode-file-input')).toBeAttached();
  return modal;
}

test('POS is usable on a phone viewport', async ({ page }) => {
  await openPos(page);
  await expect(page.getByTestId('pos-scan-button')).toBeVisible();
  // The page must not scroll sideways on a phone.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'POS must not scroll horizontally on mobile').toBeLessThanOrEqual(1);
  await shot(page, 'mobile-pos');
});

test('photo of a barcode is decoded and adds the pair to the cart', async ({ page }) => {
  const modal = await openPhotoScanner(page);

  const file = await writePng('label-clean.png', await barcodePng(fixture.barcode));
  await modal.getByTestId('barcode-file-input').setInputFiles(file);

  // Decoding closes the scanner and the POS adds the pair.
  await expect(page.getByTestId('scan-ok')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.pos-cart-item')).toHaveCount(1);
  await shot(page, 'mobile-photo-scan-success');
});

test('a slightly blurred, rotated photo still decodes', async ({ page }) => {
  const modal = await openPhotoScanner(page);

  // What a hurried photo of a shoe box actually looks like.
  const file = await writePng('label-blur.png', await barcodePng(fixture.barcode, { blur: 1.2, rotate: 3 }));
  await modal.getByTestId('barcode-file-input').setInputFiles(file);

  await expect(page.getByTestId('scan-ok')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.pos-cart-item')).toHaveCount(1);
  await shot(page, 'mobile-blurred-photo-scan');
});

test('an image with no barcode reports it instead of hanging', async ({ page }) => {
  const modal = await openPhotoScanner(page);

  const blank = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#dddddd' } })
    .png().toBuffer();
  const file = await writePng('no-barcode.png', blank);
  await modal.getByTestId('barcode-file-input').setInputFiles(file);

  await expect(modal.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(modal.getByText(/no barcode found/i)).toBeVisible();
  // Nothing must have been added.
  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await shot(page, 'mobile-no-barcode-in-image');

  // And the modal must still be usable — a failed read cannot be a dead end.
  await expect(modal.getByTestId('barcode-file-input')).toBeAttached();
});

test('a non-image file is rejected', async ({ page }) => {
  const modal = await openPhotoScanner(page);

  fs.mkdirSync(TMP, { recursive: true });
  const txt = path.join(TMP, 'not-an-image.txt');
  fs.writeFileSync(txt, 'this is not a picture');
  await modal.getByTestId('barcode-file-input').setInputFiles(txt);

  await expect(modal.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await shot(page, 'mobile-not-an-image');
});

test('a photo of an unknown barcode surfaces the lookup error', async ({ page }) => {
  const modal = await openPhotoScanner(page);

  // Valid EAN-13 (check digit verified) that belongs to no product here.
  const file = await writePng('unknown.png', await barcodePng('2009999990000'));
  await modal.getByTestId('barcode-file-input').setInputFiles(file);

  await expect(page.getByTestId('scan-err')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.pos-cart-item')).toHaveCount(0);
  await shot(page, 'mobile-unknown-barcode-photo');
});
