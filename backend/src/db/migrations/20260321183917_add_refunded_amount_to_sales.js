exports.up = function(knex) {
  return knex.schema.alterTable('sales', (t) => {
    t.decimal('refunded_amount', 10, 2).defaultTo(0);
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('sales', (t) => {
    t.dropColumn('refunded_amount');
  });
};
