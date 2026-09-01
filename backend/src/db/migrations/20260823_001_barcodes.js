/**
 * Barcode support: internal EAN-13 per product variant (product + colour + size).
 *
 * Numbering is allocated from strict high-water marks that never decrement:
 *   - products.barcode_seq  <- the product_barcode_seq SEQUENCE (global, never reused)
 *   - product_colors.color_seq <- products.color_seq_hwm (per-product, only increments)
 *
 * This matters: if a colour were deleted and its number handed to the next colour,
 * every label already printed for the old colour would start scanning as the new one.
 * Taking MAX(color_seq)+1 would do exactly that when the highest colour is removed,
 * so the high-water mark is stored on the product instead of derived from the rows.
 */

exports.up = async function (knex) {
  // Global product numbering. 999999 is the ceiling the 6-digit field allows.
  await knex.raw(`
    CREATE SEQUENCE IF NOT EXISTS product_barcode_seq
      AS integer START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 999999 NO CYCLE
  `);

  await knex.schema.alterTable('products', (t) => {
    t.integer('barcode_seq').unique();
    t.integer('color_seq_hwm').notNullable().defaultTo(0);
  });

  await knex.schema.alterTable('product_colors', (t) => {
    t.smallint('color_seq');
  });
  // A colour number must be unique within its product, but stays NULL until the
  // colour's first barcode is minted.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_colors_product_seq
      ON product_colors (product_id, color_seq)
      WHERE color_seq IS NOT NULL
  `);

  await knex.schema.alterTable('product_variants', (t) => {
    t.string('barcode', 20);
    t.enu('barcode_source', ['generated', 'manufacturer'])
      .notNullable()
      .defaultTo('generated');
  });
  // Unique across the whole catalogue: a scan must resolve to exactly one variant.
  // Partial so the many not-yet-assigned variants do not collide on NULL.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_barcode
      ON product_variants (barcode)
      WHERE barcode IS NOT NULL
  `);

  // Escape codes 900-999 for sizes that are not plain numbers. size_eu is free text,
  // so '36-37' or 'XL' are possible and cannot be encoded as size x 2.
  await knex.schema.createTable('size_codes', (t) => {
    t.smallint('code').primary();
    t.string('size_eu', 10).notNullable().unique();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Permission for minting barcodes and printing labels. user_permissions.permission_code
  // is an FK to permissions.code, so without this row it could never be granted.
  const existing = await knex('permissions').where('code', 'barcodes').first();
  if (!existing) {
    await knex('permissions').insert([
      { code: 'barcodes', description: 'Generate barcodes and print labels', category: 'inventory' },
    ]);
  }
};

exports.down = async function (knex) {
  await knex('permissions').where('code', 'barcodes').del();
  await knex.schema.dropTableIfExists('size_codes');

  await knex.raw('DROP INDEX IF EXISTS uq_product_variants_barcode');
  await knex.schema.alterTable('product_variants', (t) => {
    t.dropColumn('barcode');
    t.dropColumn('barcode_source');
  });

  await knex.raw('DROP INDEX IF EXISTS uq_product_colors_product_seq');
  await knex.schema.alterTable('product_colors', (t) => {
    t.dropColumn('color_seq');
  });

  await knex.schema.alterTable('products', (t) => {
    t.dropColumn('barcode_seq');
    t.dropColumn('color_seq_hwm');
  });

  await knex.raw('DROP SEQUENCE IF EXISTS product_barcode_seq');
};
