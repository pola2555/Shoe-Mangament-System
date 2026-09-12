/**
 * PAY-LATER REQUESTS, AND THE DISCOUNT FLOOR — 2026-09-04
 *
 * Two things the owner asked for, in one migration because they land on one table.
 *
 * 1. THE FLOOR (`min_total`, `below_min_acknowledged`)
 *
 *    A manager answering a discount request could not see whether the answer took the
 *    sale under what the items are allowed to sell for. `min_total` is the sum of the
 *    line floors, captured WHEN THE REQUEST IS MADE rather than when it is answered:
 *    a band edited in between must not silently change what was agreed to.
 *
 *    Going under it is allowed — that was the instruction — but the first attempt is
 *    refused with both numbers, and `below_min_acknowledged` records that the person
 *    went ahead knowing. Later, "who approved selling below cost" has an answer.
 *
 * 2. PAY LATER (`kind`, `requested_credit`, `approved_credit`)
 *
 *    Selling to a registered customer who pays nothing now becomes a request a manager
 *    answers, exactly like a discount.
 *
 *    REUSING `discount_requests` RATHER THAN A NEW TABLE
 *
 *    The machinery either flow needs is identical and is the hard part: park a cart
 *    without reserving stock, notify everyone who can answer, re-validate every line at
 *    resume because nothing was held, and consume the approval INSIDE the sale's
 *    transaction so one approval cannot be spent twice. A second table would be a
 *    second copy of all of that, and the two copies would drift — this codebase has
 *    already paid that bill with three disagreeing supplier balances.
 *
 *    So `kind` separates them. The table name is now a little narrow for what it holds;
 *    that is the price, and it is cheaper than the duplication.
 *
 * `credit_approval` is its own permission rather than reusing `discount_approval`:
 * giving away margin and giving away goods are different risks, and a shop may well
 * trust somebody with the first and not the second.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('discount_requests', (t) => {
    t.decimal('min_total', 12, 2).nullable();
    t.boolean('below_min_acknowledged').notNullable().defaultTo(false);
    t.string('kind', 20).notNullable().defaultTo('discount');
    t.decimal('requested_credit', 12, 2).nullable();
    t.decimal('approved_credit', 12, 2).nullable();
  });

  await knex.raw(
    "ALTER TABLE discount_requests ADD CONSTRAINT discount_requests_kind_check "
    + "CHECK (kind = ANY (ARRAY['discount'::text, 'credit'::text]))"
  );

  // The approvals screen filters by kind and status; every existing index on this
  // table predates kind.
  await knex.schema.alterTable('discount_requests', (t) => {
    t.index(['kind', 'status'], 'idx_discount_requests_kind_status');
  });

  const perm = await knex('permissions').where('code', 'credit_approval').first();
  if (!perm) {
    await knex('permissions').insert({
      code: 'credit_approval',
      description: 'Approve letting a customer take goods and pay later',
      category: 'sales',
    });
  }
};

exports.down = async function down(knex) {
  await knex('user_permissions').where('permission_code', 'credit_approval').del();
  await knex('permissions').where('code', 'credit_approval').del();

  await knex.raw('DROP INDEX IF EXISTS idx_discount_requests_kind_status');
  await knex.raw('ALTER TABLE discount_requests DROP CONSTRAINT IF EXISTS discount_requests_kind_check');

  // Credit requests only exist under the column being dropped, so they would become
  // indistinguishable from discount requests. Remove them rather than leave rows that
  // would read as approved discounts of zero.
  await knex('discount_requests').where('kind', 'credit').del();

  await knex.schema.alterTable('discount_requests', (t) => {
    t.dropColumn('min_total');
    t.dropColumn('below_min_acknowledged');
    t.dropColumn('kind');
    t.dropColumn('requested_credit');
    t.dropColumn('approved_credit');
  });
};
