/**
 * Stock intakes, estimated costs, and the correction log.
 *
 * WHY
 *
 * Stock could only enter through a supplier invoice. A shop adopting the system
 * already owns everything on its shelves, and inventing invoices for stock bought
 * years ago is not practical. `inventory_items.source` has carried a 'manual' value
 * since the first migration and `POST /inventory/manual` has existed all along — but
 * one variant at a time, with nothing recording that a batch ever happened.
 *
 * A stock intake is that batch, as a document: draft, review, post, and reverse while
 * nothing has been sold. The same document with a different `reason` is a stock count
 * or a write-off, which is why the reason is a column and not a hard-coded 'opening'.
 *
 * THE ESTIMATED COST, AND WHY IT IS A SEPARATE IDEA
 *
 * The owner knows what the old stock sells for. What it COST is a guess. A guess in
 * `inventory_items.cost` is indistinguishable from a real invoice cost, and profit is
 * computed from it — so every report would quietly rest on guesses with nothing on
 * screen to say so.
 *
 * `cost_is_estimated` marks the pairs whose cost is a guess. When that product is
 * later bought on a real invoice, the guesses are replaced with the invoiced cost and
 * the mark clears. The rule underneath, which decides every edge case:
 *
 *     A GUESS IS NOT HISTORY. Correcting a guess fixes a number that was known to be
 *     wrong. Changing a REAL cost would be rewriting the past, and is never done.
 *
 * So a later purchase never touches a pair that already had a real cost, and never
 * touches a past sale of one. The existing behaviour — `products.net_price` following
 * the newest box, with a notification — is untouched by all of this: net_price is a
 * display-only reference that no report reads.
 *
 * `sale_items.cost_is_estimated` is a photocopy, exactly as `cost_at_sale` already is.
 * A sold pair's profit has to be markable without joining back through inventory on
 * every report.
 *
 * cost_corrections IS THE POINT
 *
 * Because most of a shop's opening stock sells before it is ever re-bought, correcting
 * an ALREADY-SOLD pair is the common case, not the rare one — the till hands out the
 * oldest pair first, and the opening stock is the oldest stock there is. That means
 * this feature rewrites reported profit as a matter of routine, so every change is
 * logged with what it was, what it became, which invoice caused it and when, and a
 * whole batch can be reverted in one action.
 *
 * `sale_date` is denormalised onto the log so a report can answer "was this period
 * restated, and when" without joining sales.
 *
 * down() drops the tables and columns. Stock created by an intake STAYS — it is real
 * stock on a real shelf, and inventory_items.intake_id is merely how it got there.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('stock_intakes', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('intake_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    // Where the owner believes it came from. Advisory: an intake is not a purchase and
    // creates no payable, but it is the best hint available for costing it later.
    t.uuid('supplier_id').references('id').inTable('suppliers').onDelete('SET NULL');
    t.string('reason', 20).notNullable().defaultTo('opening');   // opening | count | found | damaged
    t.string('status', 20).notNullable().defaultTo('draft');     // draft | posted | cancelled
    t.date('intake_date').notNullable();
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('posted_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('posted_at');
    t.uuid('cancelled_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('cancelled_at');
    t.text('cancel_reason');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'status']);
  });

  await knex.schema.createTable('stock_intake_lines', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('intake_id').notNullable().references('id').inTable('stock_intakes').onDelete('CASCADE');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('RESTRICT');
    // Both nullable: a colourless or sizeless category resolves its placeholder at post
    // time, the same way a purchase box does. See utils/variantIdentity.js.
    t.uuid('product_color_id').references('id').inTable('product_colors').onDelete('SET NULL');
    t.string('size_eu', 20);
    t.integer('quantity').notNullable();
    t.decimal('unit_cost', 10, 2).notNullable();
    // Per LINE, not per sheet: an owner knows the cost of some of their old stock
    // exactly. Marking the whole document a guess would let a later invoice overwrite
    // the numbers that were already right.
    t.boolean('cost_is_estimated').notNullable().defaultTo(true);
    // Filled in at post time, so the sheet records what it actually created.
    t.uuid('variant_id').references('id').inTable('product_variants').onDelete('SET NULL');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['intake_id']);
  });

  await knex.schema.alterTable('inventory_items', (t) => {
    t.uuid('intake_id').references('id').inTable('stock_intakes').onDelete('SET NULL');
    t.boolean('cost_is_estimated').notNullable().defaultTo(false);
  });

  // Healing looks up "every estimated pair of this product", which is a tiny slice of
  // a large table, so the index only covers the rows that can match.
  await knex.raw(
    'CREATE INDEX idx_inventory_items_estimated ON inventory_items (variant_id) WHERE cost_is_estimated'
  );

  await knex.schema.alterTable('sale_items', (t) => {
    t.boolean('cost_is_estimated').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('cost_corrections', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    // One healing event, so a notification can offer to undo all of it at once.
    t.uuid('batch_id').notNullable();
    t.uuid('inventory_item_id').notNullable().references('id').inTable('inventory_items').onDelete('CASCADE');
    // Set when the pair had already been sold. A pair voided and sold again has one
    // row per sale line, which is why this is not unique per pair.
    t.uuid('sale_item_id').references('id').inTable('sale_items').onDelete('CASCADE');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.decimal('old_cost', 10, 2).notNullable();
    t.decimal('new_cost', 10, 2).notNullable();
    t.uuid('source_box_id').references('id').inTable('purchase_invoice_boxes').onDelete('SET NULL');
    // Kept as text as well, so the log still names its cause after a box is deleted.
    t.string('source_invoice_number', 50);
    // Which day's reported profit moved. Denormalised so "was this period restated?"
    // is one indexed read rather than a join through sale_items to sales.
    t.date('sale_date');
    t.timestamp('applied_at').defaultTo(knex.fn.now());
    t.uuid('applied_by').references('id').inTable('users').onDelete('SET NULL'); // NULL = automatic
    t.timestamp('reverted_at');
    t.uuid('reverted_by').references('id').inTable('users').onDelete('SET NULL');

    t.index(['batch_id']);
    t.index(['product_id']);
    t.index(['sale_date']);
  });

  // user_permissions.permission_code is an FK to permissions.code, so without this row
  // the ability could never be granted to anyone — the mistake that once left the
  // `dashboard` permission ungrantable. Admins bypass every check, so nothing else is
  // needed here: granting it to a non-admin is a deliberate act in the users screen,
  // and REVOKING it is the switch the owner flips once the opening stock is in. The
  // feature stays; the ability to use it does not.
  const exists = await knex('permissions').where('code', 'stock_intake').first();
  if (!exists) {
    await knex('permissions').insert({
      code: 'stock_intake',
      description: 'Enter stock without a purchase invoice (opening stock, counts, write-offs)',
      category: 'inventory',
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cost_corrections');

  await knex.raw('DROP INDEX IF EXISTS idx_inventory_items_estimated');

  const hasSaleFlag = await knex.schema.hasColumn('sale_items', 'cost_is_estimated');
  if (hasSaleFlag) {
    await knex.schema.alterTable('sale_items', (t) => t.dropColumn('cost_is_estimated'));
  }

  // The stock itself stays. Only the link to the document that created it goes.
  for (const col of ['intake_id', 'cost_is_estimated']) {
    if (await knex.schema.hasColumn('inventory_items', col)) {
      await knex.schema.alterTable('inventory_items', (t) => t.dropColumn(col));
    }
  }

  await knex.schema.dropTableIfExists('stock_intake_lines');
  await knex.schema.dropTableIfExists('stock_intakes');

  await knex('user_permissions').where('permission_code', 'stock_intake').del().catch(() => {});
  await knex('permissions').where('code', 'stock_intake').del();
};
