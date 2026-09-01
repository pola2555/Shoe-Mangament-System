import { test, expect, chromium } from '@playwright/test';
import { api, shot } from './helpers.js';
import { createRequire } from 'module';
import path from 'path';

// Playwright transpiles these specs to CJS, so import.meta is unavailable; anchor the
// require on the repo root instead.
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { decodeBarcodeResilient } = require('./e2e/decode.js');
const sharp = require('./backend/node_modules/sharp');

/**
 * Label generation and printing, through the real UI.
 *
 * The important test here is the last one: it screenshots the barcode the app
 * actually renders and reads it back with ZXing. The SVG encoder is hand-written, so
 * this is the only evidence that a printed label will scan.
 */

let ctx = {};

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' });
  await page.goto('http://localhost:5173/');
  const products = await api(page, 'GET', '/products', { params: { limit: '50' } });
  expect(products.status).toBe(200);
  // Pick a product that actually has numeric sizes. Taking whichever product is newest
  // made this suite depend on catalogue ordering, and the catalogue now contains
  // categories with alpha sizes or none at all.
  const rows = products.body.data;
  ctx.product = rows.find((p) => p.has_sizes && p.scale_is_numeric && p.variant_count > 0)
    || rows.find((p) => p.variant_count > 0)
    || rows[0];
  expect(ctx.product, 'need a product with variants').toBeTruthy();
  await page.close();
});

test('print dialog opens from the product page and defaults copies to stock on hand', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();

  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('heading', { name: /print labels/i })).toBeVisible();

  // Every row should carry a barcode; none should be flagged as missing.
  await expect(modal.locator('tbody tr')).not.toHaveCount(0);
  await expect(modal.getByText(/have no barcode yet/i)).toHaveCount(0);

  // Copies default to the number of pairs actually in stock.
  const rows = modal.locator('tbody tr').filter({ has: page.locator('input[type="number"]') });
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);

  let mismatches = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const stock = (await row.locator('td').nth(2).textContent())?.trim();
    const copies = await row.locator('input[type="number"]').inputValue();
    if (stock !== copies) mismatches.push(`row ${i}: stock=${stock} copies=${copies}`);
  }
  expect(mismatches, `copies should default to stock: ${mismatches.join('; ')}`).toHaveLength(0);

  await shot(page, 'labels-print-dialog');
});

test('bulk copy controls and the total both behave', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();

  await modal.getByRole('button', { name: /clear all/i }).click();
  await expect(modal.getByText(/0 label\(s\) total/i)).toBeVisible();
  // With nothing to print, printing must be refused rather than emitting a blank run.
  await expect(modal.getByRole('button', { name: /print 0 label/i })).toBeDisabled();

  await modal.getByRole('button', { name: /one each/i }).click();
  const rowCount = await modal.locator('tbody input[type="number"]').count();
  await expect(modal.getByText(new RegExp(`${rowCount} label\\(s\\) total`, 'i'))).toBeVisible();

  await shot(page, 'labels-bulk-controls');
});

test('label size can be changed and is remembered', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  const select = modal.getByTestId('label-size');

  await expect(select).toHaveValue('38x25'); // the user's stock
  await select.selectOption('40x30');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('label_size'))).toBe('40x30');

  // Restore, so later tests see the real default.
  await select.selectOption('38x25');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('label_size'))).toBe('38x25');
});

test('rendered label shows colour, the size, product code and a CODED price', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await modal.getByText(/^preview$/i).click();

  const label = modal.locator('.shoe-label').first();
  await expect(label).toBeVisible();

  const text = (await label.textContent()) || '';

  const rows = await api(page, 'GET', '/barcodes/labels', { params: { product_id: ctx.product.id } });
  const first = rows.body.data.find((r) => r.barcode);

  // The size as THIS category writes it — "EU 42", "80 cm", "Kids". Asserting a
  // hard-coded "EU" was only ever right while the catalogue was shoes, and it now
  // fails on a belt whose label correctly reads "80 cm".
  const expectedSize = [first.size_prefix, first.size_label_en || first.size_eu, first.size_suffix]
    .filter(Boolean).join(' ');
  expect(text, `the size must be on the label as "${expectedSize}"`).toContain(expectedSize);

  // A placeholder colour is the stand-in for "no colour" and must never be printed.
  if (first.color_is_placeholder) {
    expect(text, 'the placeholder colour must not reach paper').not.toContain(first.color_name);
  } else {
    expect(text, 'colour must be on the label').toContain(first.color_name);
  }
  expect(text, 'product code must be on the label').toContain(first.product_code);

  if (first.price != null && first.price > 0) {
    expect(text, 'the coded price must be present').toContain(first.price_code);
    // The whole point: the plain number must NOT appear.
    expect(text, 'plain price must never be printed').not.toContain(String(Math.round(first.price)));
    expect(text).not.toContain(first.price.toLocaleString());
  }

  await shot(page, 'labels-rendered-38x25', { clip: await label.boundingBox() });
});

test('the rendered barcode is machine-readable (ZXing decodes what we draw)', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await modal.getByText(/^preview$/i).click();

  const svgs = modal.locator('svg[data-barcode]');
  const count = await svgs.count();
  expect(count, 'preview should render some barcodes').toBeGreaterThan(0);

  const checked = [];
  const failures = [];

  for (let i = 0; i < Math.min(count, 4); i++) {
    const svg = svgs.nth(i);
    const expected = await svg.getAttribute('data-barcode');

    // Take the SVG the app actually rendered and rasterise it at 203 dpi — the
    // TDP-225's real resolution. Screenshotting instead would capture it at CSS
    // scale, where 95 modules land in under 100 pixels and no decoder could read it;
    // that would be an artefact of the screen, not of the label.
    const markup = await svg.evaluate((el) => el.outerHTML);
    const png = await sharp(Buffer.from(markup), { density: 203 })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();

    try {
      const { text, format } = await decodeBarcodeResilient(png);
      checked.push(`${expected} [${format}]`);
      expect(text, `decoded barcode ${i} did not match what was rendered`).toBe(expected);
    } catch (err) {
      failures.push(`${expected}: ${err.message}`);
    }
  }

  expect(failures, `barcodes that could not be decoded: ${failures.join(' | ')}`).toHaveLength(0);
  console.log(`    decoded ${checked.length} rendered barcodes: ${checked.join(', ')}`);

  await shot(page, 'labels-decoded-preview');
});

test('TSPL export produces valid printer commands', async ({ page }) => {
  await page.goto(`/products/${ctx.product.id}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();

  const downloadPromise = page.waitForEvent('download');
  await modal.getByRole('button', { name: /download tspl/i }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;

  expect(text).toContain('SIZE 38 mm,25 mm');
  expect(text).toContain('GAP 2 mm,0');
  expect(text).toMatch(/BARCODE \d+,\d+,"EAN13",\d+,1,0,2,2,"\d{12}"/);
  expect(text).toMatch(/PRINT \d+,1/);
  expect(text).toContain('CLS');

  // TSPL takes the 12 data digits and computes the check digit itself; passing 13
  // would make it encode the check digit as data and print the wrong symbol.
  const codes = [...text.matchAll(/"EAN13",\d+,1,0,2,2,"(\d+)"/g)].map((m) => m[1]);
  expect(codes.length).toBeGreaterThan(0);
  for (const c of codes) expect(c, 'EAN13 payload must be 12 digits').toHaveLength(12);
});

test('inventory page can print labels for what is on screen', async ({ page }) => {
  await page.goto('/inventory');

  // The button stays disabled until the page has something to label — clicking before
  // then would open a dialog with an empty selection.
  const btn = page.getByTestId('inventory-print-labels');
  await expect(btn).toBeEnabled({ timeout: 20_000 });
  await btn.click();

  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('labels-empty')).toHaveCount(0);
  await expect(modal.locator('tbody tr')).not.toHaveCount(0);
  await shot(page, 'labels-from-inventory');
});

test('a received purchase box can print one label per pair', async ({ page }) => {
  // api() reads the token from localStorage, which is unreachable on about:blank.
  await page.goto('/');

  // A completed box is the highest-value moment to label: the pairs are physically on
  // the bench and every one of them needs a sticker.
  const boxes = await api(page, 'GET', '/purchases/invoices');
  expect(boxes.status).toBe(200);

  // Find an invoice with a completed box that actually produced inventory.
  let found = null;
  for (const inv of boxes.body.data.slice(0, 10)) {
    const detail = await api(page, 'GET', `/purchases/invoices/${inv.id}`);
    const box = (detail.body.data.boxes || []).find((b) => b.detail_status === 'complete');
    if (box) { found = { invoiceId: inv.id, boxId: box.id }; break; }
  }
  test.skip(!found, 'no completed purchase box in this dataset');

  // The payload must contain exactly the variants that box put into stock.
  const labels = await api(page, 'GET', '/barcodes/labels', {
    params: { invoice_box_id: found.boxId },
  });
  expect(labels.status).toBe(200);
  expect(labels.body.data.length).toBeGreaterThan(0);
  for (const row of labels.body.data) {
    expect(row.barcode, `variant ${row.sku} received into stock has no barcode`).toBeTruthy();
  }

  await page.goto(`/purchases/${found.invoiceId}`);
  const btn = page.getByTestId(`box-print-labels-${found.boxId}`);
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await btn.click();

  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('labels-empty')).toHaveCount(0);
  await expect(modal.locator('tbody input[type="number"]')).not.toHaveCount(0);

  // Copies default to what the box actually delivered, so the run matches the stock.
  const total = (await modal.getByText(/label\(s\) total/i).textContent()) || '';
  expect(total).toMatch(/[1-9]/);

  await shot(page, 'labels-from-purchase-box');
});

/**
 * Print-layout regressions.
 *
 * Both of these come from a real failed print on the TSC TDP-225: the label came out
 * turned 90 degrees and split across two stickers. Neither is visible on screen, so
 * they need asserting against the *print* stylesheet specifically.
 */

const MM = 96 / 25.4; // CSS px per mm at zoom 1

async function openPreview(page, productId) {
  await page.goto(`/products/${productId}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await expect(modal).toBeVisible();
  // The preview toggle does not exist until the label payload has arrived, and the
  // dev server's first compile of a run can outlast the default action timeout.
  await expect(modal.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  await modal.getByText(/^preview$/i).click();
  await expect(modal.locator('.shoe-label').first()).toBeVisible();
  return modal;
}

test('the print sheet is block flow, not flex', async ({ page }) => {
  const modal = await openPreview(page, ctx.product.id);

  // On screen the sheet is a flex column purely for the preview's spacing.
  await expect(modal.locator('.sheet').first()).toHaveCSS('display', 'flex');

  // In print it must be block. Chrome's fragmentation inside a flex container is
  // unreliable — `break-inside: avoid` on a flex item gets ignored — which is what
  // let a single label straddle a page boundary and print across two stickers.
  await page.emulateMedia({ media: 'print' });
  const sheet = modal.locator('.sheet').first();
  await expect(sheet).toHaveCSS('display', 'block');

  const label = modal.locator('.shoe-label').first();
  await expect(label).toHaveCSS('page-break-inside', 'avoid');
  await expect(label).toHaveCSS('page-break-after', 'always');

  await page.emulateMedia({ media: null });
});

test('a label occupies exactly one page box and never overflows it', async ({ page }) => {
  const modal = await openPreview(page, ctx.product.id);
  await page.emulateMedia({ media: 'print' });

  const box = await modal.locator('.shoe-label').first().boundingBox();
  // 38 x 25 mm exactly. A label even a hair taller than the page spills a blank
  // second sticker for every one printed.
  expect(box.width / MM).toBeCloseTo(38, 1);
  expect(box.height / MM).toBeCloseTo(25, 1);

  const inner = await modal.locator('.lbl-inner').first().boundingBox();
  expect(inner.width / MM).toBeCloseTo(38, 1);
  expect(inner.height / MM).toBeCloseTo(25, 1);

  await page.emulateMedia({ media: null });
});

for (const deg of [90, 270]) {
  test(`turned ${deg}° swaps the page box and keeps the artwork inside it`, async ({ page }) => {
    const modal = await openPreview(page, ctx.product.id);
    await modal.getByTestId('label-rotate').selectOption(String(deg));
    await page.emulateMedia({ media: 'print' });

    const label = modal.locator('.shoe-label').first();
    const box = await label.boundingBox();
    // Portrait page box: 25 wide x 38 tall. Expressing it this way is the whole point —
    // Chrome reads `size: 38mm 25mm` as a request for landscape and lets the driver
    // turn the image, which is what put the artwork sideways in the first place.
    expect(box.width / MM).toBeCloseTo(25, 1);
    expect(box.height / MM).toBeCloseTo(38, 1);

    // The rotated artwork must land on the label, not beside or off it. boundingBox()
    // is post-transform, so this catches a wrong translate as well as a wrong angle —
    // and a quarter turn the wrong way needs a different correction, which is exactly
    // the mistake this covers for both directions.
    const inner = await modal.locator('.lbl-inner').first().boundingBox();
    expect(inner.width / MM).toBeCloseTo(25, 1);
    expect(inner.height / MM).toBeCloseTo(38, 1);
    expect(Math.abs(inner.x - box.x), 'artwork is shifted horizontally off the label').toBeLessThan(2);
    expect(Math.abs(inner.y - box.y), 'artwork is shifted vertically off the label').toBeLessThan(2);

    await page.emulateMedia({ media: null });
    await shot(page, `labels-rotated-${deg}`, { clip: await label.boundingBox() });
  });

  test(`orientation ${deg}° is remembered and reaches the TSPL export`, async ({ page }) => {
    const modal = await openPreview(page, ctx.product.id);
    await modal.getByTestId('label-rotate').selectOption(String(deg));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('label_rotate'))).toBe(String(deg));

    const downloadPromise = page.waitForEvent('download');
    await modal.getByRole('button', { name: /download tspl/i }).click();
    const stream = await (await downloadPromise).createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk;

    // Media fed the short way round, and every element turned to match.
    expect(text).toContain('SIZE 25 mm,38 mm');

    const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const fields = (l, kw) => l.slice(kw.length + 1).split(',');

    // BARCODE x,y,"type",height,hri,rotation,narrow,wide,"data"
    const barcodes = lines.filter((l) => l.startsWith('BARCODE '));
    expect(barcodes.length).toBeGreaterThan(0);
    for (const l of barcodes) {
      const f = fields(l, 'BARCODE');
      expect(Number(f[5]), `barcode left unturned: ${l}`).toBe(deg);
      expect(f[8], `EAN13 payload must be 12 digits: ${l}`).toMatch(/^"[0-9]{12}"$/);
    }

    // TEXT x,y,"font",rotation,x-mul,y-mul[,align],"content"
    const texts = lines.filter((l) => l.startsWith('TEXT '));
    expect(texts.length).toBeGreaterThan(0);
    for (const l of texts) {
      expect(Number(fields(l, 'TEXT')[3]), `text left unturned: ${l}`).toBe(deg);
    }

    // Every coordinate must land on the media, not past its edge. A quarter turn the
    // wrong way still produces plausible-looking commands; this is what catches it.
    for (const l of [...barcodes, ...texts]) {
      const f = fields(l, l.split(' ')[0]);
      const [x, y] = [Number(f[0]), Number(f[1])];
      expect(x, `x=${x} dots is off a 25 mm wide label: ${l}`).toBeGreaterThanOrEqual(0);
      expect(x, `x=${x} dots is off a 25 mm wide label: ${l}`).toBeLessThanOrEqual(25 * 8);
      expect(y, `y=${y} dots is off a 38 mm long label: ${l}`).toBeGreaterThanOrEqual(0);
      expect(y, `y=${y} dots is off a 38 mm long label: ${l}`).toBeLessThanOrEqual(38 * 8);
    }

    // Restore, so the shared storageState does not leak this into later runs.
    await modal.getByTestId('label-rotate').selectOption('0');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('label_rotate'))).toBe('0');
  });
}

test('the test print emits exactly one label', async ({ page }) => {
  const modal = await openPreview(page, ctx.product.id);

  // Deliberately ask for a large run; the test button must ignore it.
  await modal.getByRole('button', { name: /match stock/i }).click();
  const total = Number(((await modal.getByText(/label\(s\) total/i).textContent()) || '').match(/\d+/)[0]);
  expect(total, 'need a multi-label run to prove the test print is not the whole run').toBeGreaterThan(1);

  const count = await page.evaluate(() => {
    // The hidden single-label render is what the test button prints.
    const holders = [...document.querySelectorAll('.modal-content > div[aria-hidden="true"]')];
    return holders.map((h) => h.querySelectorAll('.shoe-label').length);
  });
  expect(count).toContain(1);
  await expect(modal.getByTestId('label-test-print')).toBeEnabled();
});

async function openDialog(page, productId) {
  await page.goto(`/products/${productId}`);
  await page.getByTestId('product-print-labels').click();
  const modal = page.locator('.modal-overlay').last();
  await expect(modal.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  return modal;
}

test('the setup instructions are on screen the moment the dialog opens', async ({ page }) => {
  const modal = await openDialog(page, ctx.product.id);
  const panel = modal.getByTestId('printer-setup');

  // toBeVisible() only means "has a box". It passed while the panel sat below the fold
  // of a scrolling dialog — no better than the collapsed <details> it replaced, and
  // the first real print went out with Chrome's default paper and its header on the
  // label because of exactly that. It has to be in the viewport, unprompted.
  await expect(panel).toBeVisible();
  await expect(panel).toBeInViewport();

  await expect(panel).toContainText(/paper size/i);
  await expect(panel).toContainText(/headers and footers/i);
  await expect(panel).toContainText(/38 × 25 mm/);
  await shot(page, 'labels-printer-setup', { clip: await modal.locator('.modal-content').boundingBox() });
});

test('setup help can be dismissed once a till is configured, and brought back', async ({ page }) => {
  const modal = await openDialog(page, ctx.product.id);

  await modal.getByTestId('printer-setup-hide').click();
  await expect(modal.getByTestId('printer-setup')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('label_setup_done'))).toBe('1');

  await modal.getByTestId('printer-setup-show').click();
  await expect(modal.getByTestId('printer-setup')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('label_setup_done'))).toBe('0');
});

/**
 * What actually reaches the printer.
 *
 * `window.print()` is a no-op under automation, so the hidden print iframe survives
 * long enough to read. Rendering that exact document with `preferCSSPageSize` is the
 * closest thing to paper available here: it reports the physical page box Chromium
 * derives from our `@page` rule, and one page per label.
 *
 * This is the assertion that pins down the difference between "our CSS is wrong" and
 * "the print dialog is set to the wrong paper" — the first physical print came out
 * shrunk, headed and sideways, and it was the latter.
 */
for (const deg of [0, 90]) {
  const [wantW, wantH] = deg ? [25, 38] : [38, 25];

  test(`the printed document is an exact ${wantW} x ${wantH} mm page box (rotate ${deg})`, async ({ page }) => {
    const modal = await openPreview(page, ctx.product.id);
    if (deg) await modal.getByTestId('label-rotate').selectOption(String(deg));

    await modal.getByRole('button', { name: /one each/i }).click();
    const labelCount = await modal.locator('tbody input[type="number"]').count();
    expect(labelCount).toBeGreaterThan(0);

    await modal.getByRole('button', { name: /print \d+ label/i }).click();
    await page.waitForFunction(
      () => {
        const f = [...document.querySelectorAll('iframe')].pop();
        return !!(f && f.contentDocument && f.contentDocument.querySelector('.shoe-label'));
      },
      null,
      { timeout: 10_000 }
    );
    const doc = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')].pop().contentDocument.documentElement.outerHTML
    );

    expect(doc, 'the printed document must carry the page size').toContain(
      `@page { size: ${wantW}mm ${wantH}mm; margin: 0; }`
    );

    // A dedicated headless browser: page.pdf() refuses to run in headed mode, and the
    // suite should not silently skip its strongest check when run with --headed.
    const pdfBrowser = await chromium.launch();
    try {
      const sheet = await pdfBrowser.newPage();
      await sheet.setContent(doc, { waitUntil: 'load' });
      const pdf = await sheet.pdf({ preferCSSPageSize: true, printBackground: true });

      const boxes = [
        ...pdf
          .toString('latin1')
          .matchAll(/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g),
      ];
      expect(boxes.length, 'exactly one page per label — never one label over two').toBe(labelCount);

      const PT_PER_MM = 72 / 25.4;
      for (const b of boxes) {
        const w = (Number(b[3]) - Number(b[1])) / PT_PER_MM;
        const h = (Number(b[4]) - Number(b[2])) / PT_PER_MM;
        expect(w, `page width was ${w.toFixed(2)} mm`).toBeCloseTo(wantW, 0);
        expect(h, `page height was ${h.toFixed(2)} mm`).toBeCloseTo(wantH, 0);
      }
    } finally {
      await pdfBrowser.close();
    }
  });
}
