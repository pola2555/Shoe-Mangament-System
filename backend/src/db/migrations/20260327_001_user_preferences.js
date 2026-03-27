/**
 * Add theme and locale preferences to users table
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('theme', 10).defaultTo('dark');
    t.string('locale', 5).defaultTo('en');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('theme');
    t.dropColumn('locale');
  });
};
