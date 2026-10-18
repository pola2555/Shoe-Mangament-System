/**
 * When the shop's own price floor was waived, and what it was at the time.
 *
 * The floor says what the shop will accept for a pair. Until now nobody could go
 * under it — not even the owner, who would reasonably expect to be able to; the
 * Checkout button simply went dead and the server refused the sale. Clearing a slow
 * line, matching a competitor, settling an argument with a regular: all of it needed
 * the product's minimum edited and then edited back, which moves the floor for
 * everybody and leaves no record of why.
 *
 * So an administrator may now sell under the floor, after confirming it. The
 * exception is worth nothing unless it is visible afterwards, which is what this
 * column is for.
 *
 * IT STORES THE FLOOR, NOT A FLAG. A boolean would say "this went under" and nothing
 * else; by the time anybody looks, the product's minimum may have been changed three
 * times and the question "under what?" would be unanswerable. The number here is the
 * floor as it stood at the moment of sale — the same reasoning as `cost_at_sale`,
 * which photocopies the cost rather than pointing at a figure that moves.
 *
 * NULL means the sale respected the floor, which is almost all of them.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable('sale_items', (t) => {
    t.decimal('floor_waived', 10, 2);
  });

  // The question asked of this column is always "show me the exceptions", a tiny
  // slice of a table that grows with every sale, so the index covers only those rows.
  await knex.raw(
    'CREATE INDEX idx_sale_items_floor_waived ON sale_items (sale_id) WHERE floor_waived IS NOT NULL',
  );
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS idx_sale_items_floor_waived');
  await knex.schema.alterTable('sale_items', (t) => {
    t.dropColumn('floor_waived');
  });
};
