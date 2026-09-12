/**
 * Voiding a sale, and a notification history.
 *
 * WHY
 *
 * A sale that was rung up wrong could not be corrected at all. There is no DELETE on
 * /api/sales and no reversal — the stock was gone and the money was recorded. The only
 * near-miss was a customer return, which is a different event: a return is the customer
 * bringing goods back, a void is the till saying "that never happened".
 *
 * DESIGN
 *
 * - `voided_at` is the single test for whether a sale is real. NULL means live. Every
 *   query that counts money or stock has to say `WHERE voided_at IS NULL`; a boolean
 *   plus a timestamp would let the two disagree.
 * - The sale, its lines and its payments all STAY. They are the record of what
 *   happened, and a void that erased them would leave a hole in the numbering with no
 *   explanation. Only the inventory moves back.
 * - `notifications.archived_at` gives the bell an "empty it" that loses nothing. The
 *   history page reads across archived and unarchived alike; permanent deletion is a
 *   separate, explicit act over a date range.
 *
 * down() drops the columns and the permission. Any sale voided in the meantime becomes
 * live again — which is the honest reversal of "this column no longer exists".
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('sales', (t) => {
    // NULL = a real sale. The only place the answer lives.
    t.timestamp('voided_at');
    t.uuid('voided_by').references('id').inTable('users').onDelete('SET NULL');
    t.text('void_reason');
  });

  // Reports filter by store and then by "is it real", so both belong in one index.
  await knex.raw('CREATE INDEX idx_sales_store_voided ON sales (store_id, voided_at)');

  await knex.schema.alterTable('notifications', (t) => {
    t.timestamp('archived_at');
  });

  // The bell reads (user, not archived, newest first); the history reads the same
  // columns without the archived predicate.
  await knex.raw('CREATE INDEX idx_notifications_user_archived ON notifications (user_id, archived_at, created_at DESC)');

  // user_permissions.permission_code is an FK to permissions.code, so without this row
  // the permission could never be granted — the mistake that once locked every
  // non-admin out of the dashboard.
  const existing = await knex('permissions').where('code', 'sale_void').first();
  if (!existing) {
    await knex('permissions').insert([{
      code: 'sale_void',
      description: 'Void a completed sale and return its stock',
      category: 'sales',
    }]);
  }
};

exports.down = async function down(knex) {
  await knex('permissions').where('code', 'sale_void').del();

  await knex.raw('DROP INDEX IF EXISTS idx_notifications_user_archived');
  await knex.schema.alterTable('notifications', (t) => {
    t.dropColumn('archived_at');
  });

  await knex.raw('DROP INDEX IF EXISTS idx_sales_store_voided');
  await knex.schema.alterTable('sales', (t) => {
    t.dropColumn('voided_at');
    t.dropColumn('voided_by');
    t.dropColumn('void_reason');
  });
};
