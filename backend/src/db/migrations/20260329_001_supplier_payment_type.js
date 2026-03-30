/**
 * Add 'type' column to supplier_payments to support withdrawals.
 * type = 'payment' (default, you pay supplier) or 'withdrawal' (supplier pays you back).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('supplier_payments', (t) => {
    t.string('type', 20).notNullable().defaultTo('payment');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('supplier_payments', (t) => {
    t.dropColumn('type');
  });
};
