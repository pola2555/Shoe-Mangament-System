/**
 * Shifts and the cash drawer, exchanges, stock counts, and PLAN 3 (priced by role,
 * discounts approved, sellers identified).
 *
 * These arrived together because they are one story: what happens at the counter
 * between opening the shop and closing it.
 *
 * ---------------------------------------------------------------- SHIFTS
 *
 * A drawer belongs to a BRANCH, not to a person — one till, whoever is standing at it.
 * So `uq_shifts_one_open_per_store` allows exactly one open shift per store, and every
 * sale, refund and drawer-paid expense taken while it is open belongs to it.
 *
 * `sales.shift_id` rather than "sales between opened_at and closed_at": a time window
 * has to be recomputed identically in every query that asks, and it silently changes
 * meaning if a shift is ever edited. The link is the answer.
 *
 * Cash is counted, not derived. `counted_cash` is what the person found in the drawer;
 * `expected_cash` is what the system believes should be there. The DIFFERENCE is the
 * point of the whole feature, so both are stored — recomputing "expected" later, after
 * a sale is voided or a refund posted, would silently rewrite a shortfall that somebody
 * already investigated.
 *
 * ---------------------------------------------------------------- CASH MOVEMENTS
 *
 * Money leaves a drawer for reasons that are not sales: the owner takes the day's
 * takings, someone pays for plastic bags, a cashier draws their own salary. Expenses
 * already model the last two, so an expense paid from the till carries `shift_id` and
 * `paid_from_drawer` instead of being duplicated here — one row, counted once.
 *
 * `cash_movements` is for money moving with no expense behind it: the owner's takings,
 * a float top-up, a correction.
 *
 * ---------------------------------------------------------------- EXCHANGES
 *
 * An exchange is a return AND a sale, and it must be both: the returned pair has to go
 * back into stock through the path that already knows how, and the outgoing pair has to
 * leave through the path that captures its cost. So `exchanges` is a link row over the
 * two documents plus the money difference, not a third way to move stock.
 *
 * ---------------------------------------------------------------- STOCK COUNTS
 *
 * `expected_qty` is snapshotted when the sheet is generated, because the shop keeps
 * trading while it is counted. Comparing a Tuesday count against Thursday's stock finds
 * a "shrinkage" that is really two days of sales.
 *
 * Missing stock becomes status 'lost' — not 'damaged', which means something different
 * and is a real business number, and not deleted, because `sale_items` and the count
 * itself must still be able to refer to it.
 *
 * ---------------------------------------------------------------- PLAN 3
 *
 * `discount_requests.cart` is a jsonb snapshot rather than rows: a parked cart is a
 * PROPOSAL, it holds no stock, and every line is re-validated at resume anyway. Rows
 * would imply a reservation that does not exist.
 *
 * `seller_code_hash` is bcrypt. A four-character code is still a credential — it decides
 * whose name goes on the money — so it is never stored in a form that can be read back.
 */

exports.up = async function up(knex) {
  // ============================================================ shifts
  await knex.schema.createTable('shifts', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('shift_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.uuid('opened_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('opened_at').notNullable().defaultTo(knex.fn.now());
    t.decimal('opening_float', 12, 2).notNullable().defaultTo(0);
    t.uuid('closed_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('closed_at');
    // What was in the drawer, and what the system thought should be. Both kept: see
    // the header — recomputing "expected" later would rewrite a settled shortfall.
    t.decimal('counted_cash', 12, 2);
    t.decimal('expected_cash', 12, 2);
    t.decimal('difference', 12, 2);
    t.string('status', 10).notNullable().defaultTo('open');   // open | closed
    t.text('open_notes');
    t.text('close_notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'status']);
    t.index(['store_id', 'opened_at']);
  });

  // One drawer per branch. A second open shift would split one till's cash across two
  // counts, and neither would balance.
  await knex.raw(
    "CREATE UNIQUE INDEX uq_shifts_one_open_per_store ON shifts (store_id) WHERE status = 'open'"
  );

  await knex.schema.createTable('cash_movements', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('shift_id').references('id').inTable('shifts').onDelete('SET NULL');
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    // owner_take | drop | float_in | correction. Always a positive amount; the type
    // decides the direction, so a sign error cannot flip a withdrawal into a deposit.
    t.string('type', 20).notNullable();
    t.decimal('amount', 12, 2).notNullable();
    t.text('reason');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['shift_id']);
    t.index(['store_id', 'created_at']);
  });

  await knex.schema.alterTable('sales', (t) => {
    t.uuid('shift_id').references('id').inTable('shifts').onDelete('SET NULL');
    // WHO SOLD IT, as opposed to whose login rang it up. Several staff share one till,
    // so `created_by` alone credited every sale to whoever happened to be signed in.
    t.uuid('sold_by').references('id').inTable('users').onDelete('SET NULL');
  });
  await knex.raw('CREATE INDEX idx_sales_shift ON sales (shift_id)');

  // A cash refund takes money OUT of the same drawer, so it has to belong to the same
  // shift. Linked, not matched by timestamp: a time window has to be recomputed
  // identically everywhere it is asked, and it changes meaning if a shift is edited.
  await knex.schema.alterTable('customer_returns', (t) => {
    t.uuid('shift_id').references('id').inTable('shifts').onDelete('SET NULL');
  });
  await knex.raw('CREATE INDEX idx_customer_returns_shift ON customer_returns (shift_id)');

  await knex.schema.alterTable('expenses', (t) => {
    t.uuid('shift_id').references('id').inTable('shifts').onDelete('SET NULL');
    // Money that physically left the till, as opposed to a bank transfer or the owner's
    // own pocket. Only this kind belongs in the cash-up.
    t.boolean('paid_from_drawer').notNullable().defaultTo(false);
  });
  await knex.raw('CREATE INDEX idx_expenses_shift ON expenses (shift_id)');

  // ============================================================ exchanges
  await knex.schema.createTable('exchanges', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('exchange_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.uuid('original_sale_id').notNullable().references('id').inTable('sales').onDelete('RESTRICT');
    t.uuid('return_id').notNullable().references('id').inTable('customer_returns').onDelete('RESTRICT');
    t.uuid('new_sale_id').notNullable().references('id').inTable('sales').onDelete('RESTRICT');
    t.decimal('returned_value', 12, 2).notNullable();
    t.decimal('new_value', 12, 2).notNullable();
    // Positive: the customer owes the difference. Negative: we owe them.
    t.decimal('difference', 12, 2).notNullable();
    t.string('settlement', 20);      // cash | card | account | none
    t.text('reason');                // optional, by design — often there isn't one
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'created_at']);
    t.index(['original_sale_id']);
  });

  // ============================================================ stock counts
  await knex.schema.createTable('stock_counts', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('count_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.string('status', 20).notNullable().defaultTo('draft');    // draft | posted | cancelled
    t.string('scope', 20).notNullable().defaultTo('full');      // full | category | product
    t.uuid('category_id').references('id').inTable('product_categories').onDelete('SET NULL');
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL');
    t.date('counted_at');
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('posted_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('posted_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'status']);
  });

  await knex.schema.createTable('stock_count_lines', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('count_id').notNullable().references('id').inTable('stock_counts').onDelete('CASCADE');
    t.uuid('variant_id').notNullable().references('id').inTable('product_variants').onDelete('RESTRICT');
    // Snapshotted when the sheet is generated — the shop keeps trading while it counts,
    // and comparing against live stock reports two days of sales as shrinkage.
    t.integer('expected_qty').notNullable();
    t.integer('counted_qty');
    t.integer('variance');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['count_id', 'variant_id']);
    t.index(['count_id']);
  });

  // Missing stock is LOST, which is neither 'damaged' (a different, real business
  // number) nor deleted — a sale line or a count may still refer to the row.
  await knex.raw('ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_status_check');
  await knex.raw(
    "ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_status_check "
    + "CHECK (status = ANY (ARRAY['in_stock'::text, 'sold'::text, 'returned'::text, "
    + "'damaged'::text, 'in_transfer'::text, 'lost'::text]))"
  );

  await knex.schema.alterTable('inventory_items', (t) => {
    t.uuid('stock_count_id').references('id').inTable('stock_counts').onDelete('SET NULL');
  });

  // ============================================================ PLAN 3
  await knex.schema.createTable('discount_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('request_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.uuid('requested_by').references('id').inTable('users').onDelete('SET NULL');
    // pending | approved | rejected | used | cancelled
    t.string('status', 20).notNullable().defaultTo('pending');
    // The parked cart. A snapshot, not rows: it holds no stock and every line is
    // re-checked at resume, so rows would imply a reservation that does not exist.
    t.jsonb('cart').notNullable();
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.decimal('cart_total', 12, 2).notNullable().defaultTo(0);
    t.decimal('requested_discount', 12, 2).notNullable();
    t.decimal('approved_discount', 12, 2);
    t.text('reason');
    t.uuid('decided_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('decided_at');
    t.text('decision_note');
    t.timestamp('expires_at');
    t.uuid('sale_id').references('id').inTable('sales').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'status']);
    t.index(['requested_by', 'status']);
  });

  await knex.schema.alterTable('users', (t) => {
    // bcrypt. Short, but it decides whose name goes on the money, so it is a credential.
    t.string('seller_code_hash', 255);
    // "Don't show this again", per user, resettable by an admin.
    t.jsonb('suppressed_notices').notNullable().defaultTo('{}');
  });

  await knex.schema.alterTable('stores', (t) => {
    t.boolean('require_seller_passcode').notNullable().defaultTo(false);
    // Printed under the total on a customer receipt. Per branch: the phone number and
    // the returns policy differ.
    t.text('receipt_note');
  });

  await knex.schema.alterTable('products', (t) => {
    // A manual floor. NULL means "work it out from how fast this actually sells",
    // which is right for almost everything — see reports.getReorderSignals.
    t.integer('reorder_point');
  });

  // An even swap moves no money: the new sale is paid for by the goods that came back.
  // It still needs a payment row, or the sale sits in the customer's balance forever as
  // a debt nobody owes — so 'exchange' becomes a payment method in its own right.
  await knex.raw('ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_payment_method_check');
  await knex.raw(
    "ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_payment_method_check "
    + "CHECK (payment_method = ANY (ARRAY['cash'::text, 'card'::text, 'instapay'::text, "
    + "'vodafone_cash'::text, 'fawry'::text, 'bank_transfer'::text, 'exchange'::text, 'other'::text]))"
  );

  // ============================================================ permissions
  const perms = [
    { code: 'shifts', description: 'Open and close till shifts, count the drawer', category: 'sales' },
    { code: 'cash_drawer', description: 'Take money out of the till and record it', category: 'finance' },
    { code: 'exchanges', description: 'Exchange a sold item for another', category: 'returns' },
    { code: 'stock_count', description: 'Count stock and post the variance', category: 'inventory' },
    { code: 'seller_codes', description: 'Manage the short codes staff use to claim a sale', category: 'administration' },
    { code: 'discount_approval', description: 'Approve or reject discount requests', category: 'sales' },
    { code: 'price_override', description: 'Set a sale price away from the default, within the branch band', category: 'sales' },
  ];
  for (const p of perms) {
    const exists = await knex('permissions').where('code', p.code).first();
    if (!exists) await knex('permissions').insert(p);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('discount_requests');

  for (const col of ['seller_code_hash', 'suppressed_notices']) {
    if (await knex.schema.hasColumn('users', col)) {
      await knex.schema.alterTable('users', (t) => t.dropColumn(col));
    }
  }
  for (const col of ['require_seller_passcode', 'receipt_note']) {
    if (await knex.schema.hasColumn('stores', col)) {
      await knex.schema.alterTable('stores', (t) => t.dropColumn(col));
    }
  }
  if (await knex.schema.hasColumn('products', 'reorder_point')) {
    await knex.schema.alterTable('products', (t) => t.dropColumn('reorder_point'));
  }

  // Anything marked lost goes back to damaged — the nearest surviving meaning — before
  // the constraint that forbids 'lost' is restored.
  await knex('inventory_items').where('status', 'lost').update({ status: 'damaged' });
  if (await knex.schema.hasColumn('inventory_items', 'stock_count_id')) {
    await knex.schema.alterTable('inventory_items', (t) => t.dropColumn('stock_count_id'));
  }
  await knex.raw('ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_status_check');
  await knex.raw(
    "ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_status_check "
    + "CHECK (status = ANY (ARRAY['in_stock'::text, 'sold'::text, 'returned'::text, "
    + "'damaged'::text, 'in_transfer'::text]))"
  );

  await knex.schema.dropTableIfExists('stock_count_lines');
  await knex.schema.dropTableIfExists('stock_counts');
  await knex.schema.dropTableIfExists('exchanges');

  await knex.raw('DROP INDEX IF EXISTS idx_customer_returns_shift');
  if (await knex.schema.hasColumn('customer_returns', 'shift_id')) {
    await knex.schema.alterTable('customer_returns', (t) => t.dropColumn('shift_id'));
  }
  await knex.raw('DROP INDEX IF EXISTS idx_expenses_shift');
  for (const col of ['shift_id', 'paid_from_drawer']) {
    if (await knex.schema.hasColumn('expenses', col)) {
      await knex.schema.alterTable('expenses', (t) => t.dropColumn(col));
    }
  }
  await knex.raw('DROP INDEX IF EXISTS idx_sales_shift');
  for (const col of ['shift_id', 'sold_by']) {
    if (await knex.schema.hasColumn('sales', col)) {
      await knex.schema.alterTable('sales', (t) => t.dropColumn(col));
    }
  }

  await knex.schema.dropTableIfExists('cash_movements');
  await knex.raw('DROP INDEX IF EXISTS uq_shifts_one_open_per_store');
  await knex.schema.dropTableIfExists('shifts');

  await knex('sale_payments').where('payment_method', 'exchange').update({ payment_method: 'other' });
  await knex.raw('ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_payment_method_check');
  await knex.raw(
    "ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_payment_method_check "
    + "CHECK (payment_method = ANY (ARRAY['cash'::text, 'card'::text, 'instapay'::text, "
    + "'vodafone_cash'::text, 'fawry'::text, 'bank_transfer'::text, 'other'::text]))"
  );

  const codes = ['shifts', 'cash_drawer', 'exchanges', 'stock_count', 'seller_codes',
    'discount_approval', 'price_override'];
  await knex('user_permissions').whereIn('permission_code', codes).del().catch(() => {});
  await knex('permissions').whereIn('code', codes).del();
};
