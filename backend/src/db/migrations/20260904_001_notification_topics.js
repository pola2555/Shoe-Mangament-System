/**
 * NOTIFICATION TOPICS — 2026-09-04
 *
 * "What notification the user can receive, like about what."
 *
 * A row per (user, topic) recording an explicit choice. ABSENCE IS NOT "OFF" — it means
 * the default from src/utils/notificationTypes.js. That distinction is the whole point:
 * a new topic added next year switches on for everyone it should reach without a
 * backfill, and nobody has to be re-configured because a row was missing.
 *
 * `type` is deliberately a plain string with no foreign key. The topic list lives in
 * code because each topic needs a route and a default, which a table cannot hold; a FK
 * would mean a migration every time a notification is added, and a stale row for one
 * that is removed. Unknown types are simply ignored on read.
 *
 * Also adds `notification_topics`, the permission to choose these FOR somebody else.
 * Note this is not the `notifications` permission removed yesterday — that one gated
 * nothing, because a person's own notifications are already scoped to them. This one
 * gates a real power: deciding what another person is told about.
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('notification_preferences');
  if (!exists) {
    await knex.schema.createTable('notification_preferences', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('type', 50).notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      t.unique(['user_id', 'type'], 'uq_notification_pref_user_type');
      t.index(['user_id'], 'idx_notification_pref_user');
    });
  }

  const perm = await knex('permissions').where('code', 'notification_topics').first();
  if (!perm) {
    await knex('permissions').insert({
      code: 'notification_topics',
      description: 'Choose which notifications another person receives',
      category: 'administration',
    });
  }
};

exports.down = async function down(knex) {
  await knex('user_permissions').where('permission_code', 'notification_topics').del();
  await knex('permissions').where('code', 'notification_topics').del();
  await knex.schema.dropTableIfExists('notification_preferences');
};
