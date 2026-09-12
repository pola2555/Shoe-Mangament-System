/**
 * Server-side paging for a list query, in one place.
 *
 * The point of paging here is to stop shipping a whole table to the browser — the
 * client holds one page, never the lot. So this runs two queries against the SAME
 * builder: a COUNT of the full filtered set (for "x of N" and the page count), and the
 * one page of rows.
 *
 * It clones the builder for the count and strips the SELECT and ORDER BY, because a
 * COUNT(*) does not need either and an ORDER BY over a stripped select is an error on
 * some engines. The builder must therefore be paginated BEFORE `.limit`/`.offset` are
 * applied — this adds them.
 *
 * Do not use on a query that GROUP BYs: COUNT(*) would count groups, not rows. Those
 * few list endpoints paginate by hand.
 *
 *   const { data, pagination } = await paginate(query, filters);
 */
async function paginate(query, { page, limit, defaultLimit = 50, maxLimit = 200 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || defaultLimit));

  const countRow = await query.clone().clearSelect().clearOrder().count({ total: '*' }).first();
  const total = parseInt(countRow?.total, 10) || 0;

  const data = await query.limit(l).offset((p - 1) * l);

  return {
    data,
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
}

/**
 * Was paging actually asked for? Callers that pass neither `page` nor `limit` (the POS,
 * the exchange lookup, a transfer's stock picker) still want the plain capped array
 * they always got — changing that shape out from under them is how a working screen
 * turns into a blank one. A page number, or an explicit `paginate` flag, opts in.
 */
function wantsPage(filters = {}) {
  return filters.page !== undefined || filters.paginate === 'true' || filters.paginate === true;
}

module.exports = { paginate, wantsPage };
