exports.up = async function(knex) {
  await knex.schema.alterTable('notifications', (table) => {
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    table.index('user_id');
  });

  await knex.schema.createTable('notification_dismissals', (table) => {
    table.increments('id').primary();
    table.uuid('notification_id').notNullable().references('id').inTable('notifications').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['notification_id', 'user_id']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('notification_dismissals');
  await knex.schema.alterTable('notifications', (table) => {
    table.dropColumn('user_id');
  });
};
