/**
 * CORRECTING A DRAWER COUNT — 2026-09-04
 *
 * "I want to be able to re-enter, like if he counted wrong."
 *
 * Reopening already existed, but it is the wrong tool for a typo: it puts the shift
 * back into trading, wipes the count AND the expected figure, and lets more sales land
 * in a shift somebody had already balanced. Using it to fix a mistyped number is a
 * sledgehammer that quietly changes what the shift means.
 *
 * A recount is the small tool: the shift stays closed, `expected_cash` is NOT
 * recomputed — that is the whole point of storing it at close, so a shortfall somebody
 * investigated does not silently rewrite itself — and only the counted figure and the
 * difference move.
 *
 * WHAT IS KEPT
 *
 *   counted_cash_original  the FIRST count, written once and never again. Without it a
 *                          correction is indistinguishable from an accurate count, and
 *                          "the drawer was 400 short until someone recounted it" is
 *                          exactly the thing an owner needs to be able to see.
 *   recount_count          how many times. Once is a typo; four times is a question.
 *   recounted_at / _by     when, and who.
 *
 * Every correction also appends a line to `close_notes`, so the trail reads in order
 * without joining anything.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('shifts', (t) => {
    t.decimal('counted_cash_original', 12, 2).nullable();
    t.integer('recount_count').notNullable().defaultTo(0);
    t.timestamp('recounted_at', { useTz: true }).nullable();
    t.uuid('recounted_by').nullable().references('id').inTable('users');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('shifts', (t) => {
    t.dropColumn('counted_cash_original');
    t.dropColumn('recount_count');
    t.dropColumn('recounted_at');
    t.dropColumn('recounted_by');
  });
};
