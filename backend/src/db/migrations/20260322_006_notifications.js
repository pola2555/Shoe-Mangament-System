exports.up = function(knex) {
  return knex.schema.createTable('notifications', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('type').notNullable(); // e.g., 'price_update', 'alert'
    table.string('title').notNullable();
    table.text('message').notNullable();
    table.uuid('reference_id').nullable(); // to link to product_id
    table.boolean('is_read').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('notifications');
};
