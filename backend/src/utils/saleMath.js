/**
 * How a sale line turns into revenue and profit, in SQL, in one place.
 *
 * These two expressions used to live as consts at the top of reports.service.js. They
 * are now shared, because the store reports compute the same figures and a second copy
 * is how the numbers on two screens start disagreeing — the same way three copies of
 * the SKU rule drifted until one of them stopped handling collisions.
 *
 * Both assume the query has joined `sales` to `sale_items`.
 */

/**
 * Net revenue for a single sale item, with the sale-level discount allocated pro-rata.
 *
 * Discounts are recorded only on `sales.discount_amount` and never pushed down to items.
 * Reported revenue uses `sales.final_amount` (net of discount) while profit used to use
 * `sale_items.sale_price` (gross) — so every discount inflated profit and the margin
 * percentage compared two different bases.
 *
 * An item's share of the discount is proportional to its price:
 *   share = discount * (sale_price / total_amount)
 * NULLIF guards a zero total; the outer COALESCE keeps the row in the SUM when it fires.
 */
const ITEM_NET_REVENUE = `(
  sale_items.sale_price
  - COALESCE(
      COALESCE(sales.discount_amount, 0) * sale_items.sale_price
        / NULLIF(sales.total_amount, 0),
      0
    )
)`;

/** Net revenue less what the pair cost us. */
const ITEM_PROFIT = `(${ITEM_NET_REVENUE} - sale_items.cost_at_sale)`;

module.exports = { ITEM_NET_REVENUE, ITEM_PROFIT };
