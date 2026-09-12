/**
 * HIDING PAGES FROM A PERSON — 2026-09-04
 *
 * A list of route paths this user should not be shown.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a way to keep a screen out of somebody's way — a stockkeeper who never touches
 * reports should not have to scroll past them. It is NOT a security control, and must
 * never be treated as one: the data behind every page is protected by the permission
 * gates on its API routes, and that is the thing an attacker meets. Hiding /reports
 * from somebody who holds `reports:read` hides the menu item; it does not stop them
 * typing the URL, and the server would still answer.
 *
 * That distinction is written into the UI hint as well, because a shopkeeper who
 * believes this locks a page would grant permissions they should not.
 *
 * A jsonb column on `users` rather than its own table: it is read on EVERY
 * authenticated request as part of the user row (middleware/auth.js loads the profile
 * in one query, deliberately), and a join per request to fetch at most twenty short
 * strings would undo that.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('users', 'hidden_pages');
  if (!has) {
    await knex.schema.alterTable('users', (t) => {
      t.jsonb('hidden_pages').notNullable().defaultTo('[]');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('users', 'hidden_pages');
  if (has) {
    await knex.schema.alterTable('users', (t) => { t.dropColumn('hidden_pages'); });
  }
};
