/**
 * Loans tracking system.
 * Tracks money lent to people (borrowers) and their repayments.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('loans', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('borrower_name', 100).notNullable();
    t.string('borrower_phone', 30);
    t.decimal('amount', 12, 2).notNullable();
    t.decimal('paid_amount', 12, 2).notNullable().defaultTo(0);
    t.enu('status', ['active', 'paid', 'partial']).notNullable().defaultTo('active');
    t.date('loan_date').notNullable();
    t.date('due_date');
    t.text('notes');
    t.uuid('store_id').references('id').inTable('stores').onDelete('SET NULL');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('loan_payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('loan_id').notNullable().references('id').inTable('loans').onDelete('CASCADE');
    t.decimal('amount', 12, 2).notNullable();
    t.string('payment_method', 30).defaultTo('cash');
    t.date('payment_date').notNullable();
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Add loans permission
  await knex('permissions').insert([
    { code: 'loans', description: 'Loan tracking and management', category: 'finance' },
  ]);
};

exports.down = async function (knex) {
  await knex('permissions').where('code', 'loans').del();
  await knex.schema.dropTableIfExists('loan_payments');
  await knex.schema.dropTableIfExists('loans');
};
