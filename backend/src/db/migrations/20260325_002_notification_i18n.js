exports.up = async function(knex) {
  await knex.schema.alterTable('notifications', (table) => {
    table.string('title_key', 100).nullable();
    table.string('message_key', 100).nullable();
    table.jsonb('params').nullable();
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('notifications', (table) => {
    table.dropColumn('title_key');
    table.dropColumn('message_key');
    table.dropColumn('params');
  });
};
