#!/usr/bin/env node
/**
 * Assign internal EAN-13 barcodes to every product variant that does not have one.
 *
 * Safe to re-run: assignForVariant is idempotent, so variants that already carry a
 * barcode (including manufacturer-linked ones) are skipped untouched.
 *
 *   node scripts/backfill-barcodes.js               # assign all missing
 *   node scripts/backfill-barcodes.js --dry-run     # report only, change nothing
 *   node scripts/backfill-barcodes.js --limit 50    # first 50 only
 *   node scripts/backfill-barcodes.js --product <uuid>
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/config/database');
const barcodesService = require('../src/modules/barcodes/barcodes.service');
const { parseVariantBarcode } = require('../src/utils/ean13');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number(arg('--limit', 0)) || 0;
const PRODUCT = arg('--product', null);

async function main() {
  let q = db('product_variants')
    .join('products', 'product_variants.product_id', 'products.id')
    .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
    .whereNull('product_variants.barcode')
    .select(
      'product_variants.id',
      'product_variants.sku',
      'product_variants.size_eu',
      'products.model_name',
      'product_colors.color_name'
    )
    .orderBy('products.model_name')
    .orderBy('product_colors.color_name')
    .orderBy('product_variants.size_eu');

  if (PRODUCT) q = q.where('products.id', PRODUCT);
  if (LIMIT) q = q.limit(LIMIT);

  const pending = await q;
  const totalVariants = Number(
    (await db('product_variants').count('* as c').first()).c
  );
  const already = totalVariants - pending.length;

  console.log(`variants total : ${totalVariants}`);
  console.log(`already coded  : ${already}`);
  console.log(`to assign      : ${pending.length}${DRY_RUN ? '  (dry run)' : ''}\n`);

  if (!pending.length) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    for (const v of pending) {
      console.log(`  would assign  ${v.sku.padEnd(20)} ${v.model_name} / ${v.color_name} / ${v.size_eu}`);
    }
    return;
  }

  let ok = 0;
  const failures = [];

  for (const v of pending) {
    try {
      const { barcode, created } = await barcodesService.assignForVariant(v.id);
      const parsed = parseVariantBarcode(barcode);
      const decoded = parsed ? `p${parsed.productSeq} c${parsed.colorSeq} sz${parsed.sizeEu ?? '(escape)'}` : '';
      console.log(
        `  ${created ? 'assigned' : 'existing'}  ${barcode}  ${v.sku.padEnd(20)} ${decoded}`
      );
      ok++;
    } catch (err) {
      failures.push({ sku: v.sku, message: err.message });
      console.error(`  FAILED    ${v.sku.padEnd(20)} ${err.message}`);
    }
  }

  console.log(`\nassigned ${ok} / ${pending.length}`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    failures.forEach((f) => console.log(`  ${f.sku}: ${f.message}`));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
