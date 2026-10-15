/**
 * What a box COST, as the figure that was actually typed.
 *
 * A box is bought as a box: "twelve pairs, 1000 EGP". The system only ever stored
 * `cost_per_item`, so that purchase had to be entered as 83.33 a pair — and 83.33 x 12
 * is 999.96. The four piastres went nowhere: not onto the invoice total, not into the
 * stock valuation, not onto the supplier's balance. Boxes that divide evenly hid the
 * problem; the ones that do not are ordinary.
 *
 * So `box_cost` is now the figure of record and `cost_per_item` is derived from it.
 * Two consequences the rest of the code depends on:
 *
 *   - `cost_per_item` widens from (10,2) to (12,4). It is a derived display and
 *     reporting figure now, and 1000/12 wants more than two places to be worth
 *     printing. It is NOT what the pairs are costed at — see below.
 *
 *   - the pairs themselves are costed by DISTRIBUTING `box_cost` to the cent, so the
 *     stock valuation of a box adds up to what was paid for it. Eight pairs at 83.33
 *     and four at 83.34 come to exactly 1000.00. `inventory_items.cost` stays (10,2),
 *     because a per-pair cost in the real world is a number of piastres.
 *
 * Backfilled from what the old shape recorded, so every existing box keeps describing
 * exactly the money it described before this ran.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable('purchase_invoice_boxes', (t) => {
    t.decimal('box_cost', 12, 2);
  });

  await knex.raw(`
    UPDATE purchase_invoice_boxes
       SET box_cost = ROUND(COALESCE(total_items, 0) * COALESCE(cost_per_item, 0), 2)
  `);

  await knex.raw('ALTER TABLE purchase_invoice_boxes ALTER COLUMN cost_per_item TYPE decimal(12,4)');
};

exports.down = async (knex) => {
  // Narrow first: a value with more than two places would not survive the cast, and
  // failing loudly here is better than silently rounding somebody's cost basis.
  await knex.raw('ALTER TABLE purchase_invoice_boxes ALTER COLUMN cost_per_item TYPE decimal(10,2)');
  await knex.schema.alterTable('purchase_invoice_boxes', (t) => {
    t.dropColumn('box_cost');
  });
};
