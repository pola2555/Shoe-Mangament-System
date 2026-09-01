/**
 * Expenses and loans: categories a shop can manage, receipts, recurring costs,
 * budgets, and loan instalments.
 *
 * WHAT WAS WRONG
 *
 * `expense_categories` held six rows seeded in 2026-03 with columns (id, name,
 * created_at) and no endpoint to add a seventh. A shop could not name its own costs,
 * could not split "Salaries" per employee, and read every category in English only.
 * `expenses` itself recorded an amount, a date and free text — not how the money left
 * (cash / bank / wallet), not who received it, and with nowhere to keep the receipt.
 *
 * DESIGN NOTES
 *
 * - Categories are TWO levels, never more. A parent may have children; a child may not
 *   itself be a parent. Arbitrary depth costs recursive CTEs in every roll-up and buys
 *   a shop nothing — "Utilities > Electricity" is the real requirement.
 * - `name` stays as the English name rather than being renamed to name_en, so the
 *   existing queries and the seeded rows keep working; the services alias it.
 * - Receipts reuse `attached_images`, which is already polymorphic on
 *   (entity_type, entity_id) and already indexed. No new table, and the upload,
 *   thumbnail and viewer pipeline all work unchanged.
 * - Recurring expenses do NOT auto-post. There is no scheduler in this deployment, and
 *   a background job that silently books rent is worse than a list of what is due —
 *   posting stays an explicit act with a person behind it.
 * - Loan instalments are rows, not a formula, so one instalment can be moved or
 *   re-sized without recomputing the rest.
 *
 * down() drops what it created and the columns it added. It does not restore the
 * Arabic names it backfilled, which is data, not schema.
 */

const AR_CATEGORY_NAMES = {
  Rent: 'إيجار',
  Salaries: 'رواتب',
  Maintenance: 'صيانة',
  Utilities: 'مرافق',
  Supplies: 'مستلزمات',
  Other: 'أخرى',
};

exports.up = async function up(knex) {
  // ---------------------------------------------------------------- categories
  await knex.schema.alterTable('expense_categories', (t) => {
    t.string('name_ar', 100);
    t.integer('parent_id').references('id').inTable('expense_categories').onDelete('RESTRICT');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('parent_id', 'idx_expense_categories_parent');
  });

  // The original schema made `name` globally unique, which a hierarchy cannot live
  // with: "Electricity" under Utilities and "Electricity" under Workshop are different
  // costs, and a shop that files them separately is doing the right thing. Uniqueness
  // becomes per-parent instead.
  //
  // Postgres treats NULLs as distinct, so a plain UNIQUE(parent_id, name) would still
  // allow two top-level categories both called "Rent". COALESCE collapses that, and
  // lower() makes it case-insensitive so "rent" and "Rent" cannot coexist either.
  await knex.raw('ALTER TABLE expense_categories DROP CONSTRAINT IF EXISTS expense_categories_name_unique');
  await knex.raw('DROP INDEX IF EXISTS expense_categories_name_unique');
  await knex.raw(`
    CREATE UNIQUE INDEX uq_expense_categories_name
    ON expense_categories (COALESCE(parent_id, 0), lower(name))
  `);

  for (const [name, nameAr] of Object.entries(AR_CATEGORY_NAMES)) {
    await knex('expense_categories').where('name', name).update({ name_ar: nameAr });
  }
  // Keep the seeded order stable and leave gaps for insertions.
  await knex.raw('UPDATE expense_categories SET sort_order = id * 10 WHERE sort_order = 0');

  // ---------------------------------------------------------------- recurring
  await knex.schema.createTable('expense_recurring', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.integer('category_id').notNullable().references('id').inTable('expense_categories').onDelete('RESTRICT');
    t.decimal('amount', 14, 2).notNullable();
    t.text('description');
    t.string('payment_method', 30);
    t.string('paid_to', 120);
    // monthly is what rent and salaries actually are; the other two are here so the
    // shop is not forced to describe a weekly cleaner as "monthly-ish".
    t.string('frequency', 10).notNullable().defaultTo('monthly');
    // The next date this template is due to be posted. Advanced by the service when a
    // posting is made, so a missed month is still visible as an overdue template
    // rather than being skipped.
    t.date('next_date').notNullable();
    t.date('end_date');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['is_active', 'next_date'], 'idx_expense_recurring_due');
  });

  await knex.raw(`
    ALTER TABLE expense_recurring
    ADD CONSTRAINT expense_recurring_frequency_check
    CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly'))
  `);

  // ---------------------------------------------------------------- budgets
  await knex.schema.createTable('expense_budgets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.integer('category_id').notNullable().references('id').inTable('expense_categories').onDelete('CASCADE');
    // Always the first day of the month it budgets for, so equality works and a range
    // scan over a period is a plain BETWEEN.
    t.date('period_month').notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.timestamps(true, true);
    t.unique(['store_id', 'category_id', 'period_month'], { indexName: 'uq_expense_budget_period' });
  });

  // ---------------------------------------------------------------- expenses
  await knex.schema.alterTable('expenses', (t) => {
    t.string('payment_method', 30);
    t.string('paid_to', 120);
    // Which template posted this row, so a mistaken template can be traced to every
    // expense it produced. SET NULL: deleting a template must not delete real spending.
    t.uuid('recurring_id').references('id').inTable('expense_recurring').onDelete('SET NULL');
  });

  // ---------------------------------------------------------------- loans
  await knex.schema.createTable('loan_installments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('loan_id').notNullable().references('id').inTable('loans').onDelete('CASCADE');
    t.integer('seq').notNullable();
    t.date('due_date').notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.timestamps(true, true);
    t.unique(['loan_id', 'seq'], { indexName: 'uq_loan_installment_seq' });
    t.index(['loan_id', 'due_date'], 'idx_loan_installments_due');
  });

  // A loan to someone who is not a system user is the normal case for a shop — a
  // customer, a supplier's driver, a relative. The column was already nullable; this
  // records that it is deliberate, since the API used to demand it.
  await knex.raw(`
    COMMENT ON COLUMN loans.borrower_user_id IS
    'Optional. NULL means the borrower is not a system user; borrower_name is then the only identity.'
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('loan_installments');

  await knex.schema.alterTable('expenses', (t) => {
    t.dropColumn('payment_method');
    t.dropColumn('paid_to');
    t.dropColumn('recurring_id');
  });

  await knex.schema.dropTableIfExists('expense_budgets');
  await knex.schema.dropTableIfExists('expense_recurring');

  await knex.raw('DROP INDEX IF EXISTS uq_expense_categories_name');
  // Restoring the global unique is best-effort: it can only succeed if no two
  // categories now share a name, and it must not fail when it is already there (this
  // migration shipped once without the DROP above, so a rollback can meet either state).
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_categories_name_unique')
         AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'expense_categories_name_unique')
         AND NOT EXISTS (SELECT 1 FROM (SELECT name FROM expense_categories GROUP BY name HAVING COUNT(*) > 1) d)
      THEN
        ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_name_unique UNIQUE (name);
      END IF;
    END $$;
  `);
  await knex.schema.alterTable('expense_categories', (t) => {
    t.dropIndex('parent_id', 'idx_expense_categories_parent');
    t.dropColumn('name_ar');
    t.dropColumn('parent_id');
    t.dropColumn('sort_order');
    t.dropColumn('is_active');
    t.dropColumn('updated_at');
  });
};
