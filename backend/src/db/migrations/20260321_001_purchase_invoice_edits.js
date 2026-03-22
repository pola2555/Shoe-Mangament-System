exports.up = async function(knex) {
  await knex.schema.alterTable('purchase_invoices', (t) => {
    t.text('invoice_image_url');
    t.decimal('discount_amount', 12, 2).defaultTo(0);
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('purchase_invoices', (t) => {
    t.dropColumn('invoice_image_url');
    t.dropColumn('discount_amount');
  });
};
