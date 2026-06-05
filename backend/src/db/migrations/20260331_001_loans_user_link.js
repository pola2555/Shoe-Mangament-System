/**
 * Link loans to system users instead of free-text borrower names.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('loans', (t) => {
    t.uuid('borrower_user_id').references('id').inTable('users').onDelete('SET NULL');
  });

  // Backfill: try to match existing borrower_name to users.full_name
  const loans = await knex('loans').select('id', 'borrower_name');
  for (const loan of loans) {
    const user = await knex('users')
      .whereRaw('LOWER(full_name) = LOWER(?)', [loan.borrower_name])
      .first();
    if (user) {
      await knex('loans').where('id', loan.id).update({ borrower_user_id: user.id });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('loans', (t) => {
    t.dropColumn('borrower_user_id');
  });
};
