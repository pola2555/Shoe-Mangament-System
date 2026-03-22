exports.up = async function(knex) {
  await knex.schema.table('customer_returns', (t) => {
    t.enu('refund_method', ['cash', 'store_credit', 'card', 'exchange', 'other']).defaultTo('cash').notNullable();
    t.decimal('total_refund_amount', 10, 2).defaultTo(0).notNullable();
  });
};

exports.down = async function(knex) {
  await knex.schema.table('customer_returns', (t) => {
    t.dropColumn('total_refund_amount');
    t.dropColumn('refund_method');
  });
};
