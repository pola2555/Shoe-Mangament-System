/**
 * The day of the month a recurring template is anchored to.
 *
 * `advance()` clamped 31 January back to 28 February so it could not overflow into
 * March — correct — but the clamped date then became the anchor for the next hop, so
 * a template due on the 31st walked to the 28th and stayed there. Rent booked on the
 * last day of the month quietly moved earlier every February and never came back.
 *
 * With the anchor stored, the clamp becomes presentational: 31 Jan -> 28 Feb -> 31 Mar.
 *
 * Weekly templates have no day-of-month anchor; the column stays NULL for them and
 * `advance()` ignores it.
 *
 * The backfill reads the day out of the CURRENT next_date, which is the best guess
 * available — a template that has already walked back re-anchors where it landed, not
 * where it started. Nothing records the original day, so this cannot be undone
 * automatically; a shop that notices can edit the date once.
 */

exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('expense_recurring', 'anchor_day');
  if (!has) {
    await knex.schema.alterTable('expense_recurring', (t) => {
      t.smallint('anchor_day');
    });
  }
  await knex.raw(`
    UPDATE expense_recurring
       SET anchor_day = EXTRACT(DAY FROM next_date)::smallint
     WHERE anchor_day IS NULL
       AND frequency <> 'weekly'
  `);
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('expense_recurring', 'anchor_day');
  if (has) {
    await knex.schema.alterTable('expense_recurring', (t) => {
      t.dropColumn('anchor_day');
    });
  }
};
