/**
 * Two long-standing bugs in product_variants, fixed ahead of the categories work.
 *
 * 1. `updated_at` never existed. products.service.js updateVariant() sets it on every
 *    call, so *every* variant edit has been failing with "column updated_at does not
 *    exist". Adding the column is the fix; nothing else has to change.
 *
 * 2. `size_eu` is a varchar and every ORDER BY on it was lexical, so '10' sorted before
 *    '9'. That has been invisible only because every size in the catalogue is 40-45.
 *    It stops being invisible the moment sizes widen or non-numeric sizes (S/M/L)
 *    arrive, and alphabetical ordering of those would put L before M before S.
 *
 *    `size_sort` is the numeric sort key. It is scaled by 10 so half sizes interleave
 *    as whole numbers: 41 -> 410, 41.5 -> 415, 42 -> 420. Once size scales land it is
 *    re-derived from the scale's own ordering, which is what makes S < M < L work;
 *    until then it is derived from the digits in size_eu using the same expression the
 *    query layer already uses, so ordering is identical to today's numeric sorts.
 */

const SIZE_DIGITS = "NULLIF(substring(size_eu from '[0-9]+[.]{0,1}[0-9]*'), '')::numeric";

exports.up = async function (knex) {
  const cols = await knex('product_variants').columnInfo();

  if (!cols.updated_at) {
    await knex.schema.alterTable('product_variants', (t) => {
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
    // Existing rows have never been updated, so created_at is the honest value.
    await knex.raw('UPDATE product_variants SET updated_at = created_at WHERE updated_at IS NULL');
  }

  if (!cols.size_sort) {
    await knex.schema.alterTable('product_variants', (t) => {
      // NOT NULL so every ORDER BY is total. A size with no digits sorts to 0, which
      // puts it first — visibly odd rather than invisibly scattered.
      t.integer('size_sort').notNullable().defaultTo(0);
    });
    await knex.raw(`
      UPDATE product_variants
         SET size_sort = ROUND(COALESCE(${SIZE_DIGITS}, 0) * 10)::int
    `);
    await knex.schema.alterTable('product_variants', (t) => {
      t.index(['product_id', 'size_sort'], 'idx_product_variants_product_size_sort');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('product_variants', (t) => {
    t.dropIndex(['product_id', 'size_sort'], 'idx_product_variants_product_size_sort');
    t.dropColumn('size_sort');
    t.dropColumn('updated_at');
  });
};
