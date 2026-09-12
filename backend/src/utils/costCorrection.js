const { generateUUID } = require('./generateCodes');
const { capabilities } = require('./schemaCapabilities');

/**
 * Replacing guessed costs with real ones, and being able to take it back.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 *     A guess is not history. Correcting a guess fixes a number that was known to be
 *     wrong. Changing a real cost would be rewriting the past, and never happens.
 *
 * So `healEstimatedCosts` only ever touches rows with `cost_is_estimated = true`. A
 * pair that arrived on a real invoice is never re-costed, no matter how many times the
 * product is bought again — which is what keeps the existing behaviour intact, where
 * `products.net_price` follows the newest box and sends a notification. That number is
 * display-only and no report reads it; this file is the only thing that can move a
 * reported figure.
 *
 * WHY CORRECTING A SOLD PAIR IS THE NORMAL CASE
 *
 * The till hands out the oldest pair first, and a shop's opening stock is the oldest
 * stock it has. So the guessed pairs sell first — most of them long before that product
 * is bought again. Correcting one therefore means rewriting `cost_at_sale` on a sale
 * that already happened, and moving the profit reported for the month it happened in.
 *
 * That is a real restatement of a month the owner has already looked at, so it is not
 * done quietly:
 *   - every single change is logged in `cost_corrections` with what it was, what it
 *     became, which invoice caused it and when;
 *   - the whole batch can be reverted in one action from the notification;
 *   - `sale_date` is copied onto the log so a report can say "restated on 12 Oct"
 *     without joining back through sales.
 *
 * A pair can carry MORE than one sale line — sold, voided, and sold again — so the log
 * holds one row per (pair, sale line), plus one row with a null sale line for a pair
 * still sitting on the shelf. Reverting walks them all.
 */

/**
 * Replace every estimated cost for a product with the cost just invoiced.
 *
 * Call inside the caller's transaction, so a failure anywhere in the receipt takes the
 * corrections with it.
 *
 * @returns {Promise<null|{batch_id, pairs, sold_pairs, old_costs:number[], new_cost}>}
 *          null when there was nothing to correct.
 */
async function healEstimatedCosts(trx, { productId, newCost, boxId = null, invoiceNumber = null, userId = null }) {
  const { estimatedCostTracking } = await capabilities();
  if (!estimatedCostTracking) return null;

  const cost = Number(newCost);
  if (!Number.isFinite(cost) || cost <= 0) return null;

  // Every estimated pair of this product, in every branch. Cost belongs to the product,
  // not to the shelf it sits on: stock guessed in one shop is corrected by an invoice
  // received into another.
  const pairs = await trx('inventory_items')
    .join('product_variants', 'product_variants.id', 'inventory_items.variant_id')
    .where('product_variants.product_id', productId)
    .where('inventory_items.cost_is_estimated', true)
    .forUpdate('inventory_items')
    .select('inventory_items.id', 'inventory_items.cost');

  if (pairs.length === 0) return null;

  const pairIds = pairs.map((p) => p.id);
  const batchId = generateUUID();

  // Sale lines for those pairs, with the day whose profit is about to move.
  const soldLines = await trx('sale_items')
    .join('sales', 'sales.id', 'sale_items.sale_id')
    .whereIn('sale_items.inventory_item_id', pairIds)
    .select(
      'sale_items.id',
      'sale_items.inventory_item_id',
      'sale_items.cost_at_sale',
      trx.raw('sales.created_at::date as sale_date')
    );

  const linesByPair = new Map();
  for (const line of soldLines) {
    if (!linesByPair.has(line.inventory_item_id)) linesByPair.set(line.inventory_item_id, []);
    linesByPair.get(line.inventory_item_id).push(line);
  }

  const log = [];
  for (const pair of pairs) {
    const lines = linesByPair.get(pair.id) || [];
    const base = {
      batch_id: batchId,
      inventory_item_id: pair.id,
      product_id: productId,
      new_cost: cost,
      source_box_id: boxId,
      source_invoice_number: invoiceNumber,
      applied_by: userId,
    };

    if (lines.length === 0) {
      // Still on the shelf. Nothing has ever been reported about it, so this one is
      // free: no month moves.
      log.push({ id: generateUUID(), ...base, sale_item_id: null, old_cost: pair.cost, sale_date: null });
    } else {
      for (const line of lines) {
        log.push({
          id: generateUUID(),
          ...base,
          sale_item_id: line.id,
          old_cost: line.cost_at_sale,
          sale_date: line.sale_date,
        });
      }
    }
  }

  // A guess that turns out to be exactly right still gets a row. Without one, reverting
  // the batch could not restore the estimated mark on that pair.
  await trx.batchInsert('cost_corrections', log, 500);

  await trx('inventory_items')
    .whereIn('id', pairIds)
    .update({ cost, cost_is_estimated: false, updated_at: new Date() });

  const soldIds = soldLines.map((l) => l.id);
  if (soldIds.length) {
    await trx('sale_items')
      .whereIn('id', soldIds)
      .update({ cost_at_sale: cost, cost_is_estimated: false });
  }

  return {
    batch_id: batchId,
    pairs: pairs.length,
    sold_pairs: soldLines.length,
    new_cost: cost,
    old_costs: [...new Set(pairs.map((p) => Number(p.cost)))].sort((a, b) => a - b),
  };
}

/**
 * Put a batch back the way it was.
 *
 * The invoiced cost is TODAY's cost, and the guessed stock may have been bought a year
 * ago at a different price — so an automatic correction can be worse than the guess it
 * replaced, and only the owner can judge that. Automatic is only safe because it is
 * reversible.
 *
 * Rows already reverted are skipped, so this is idempotent.
 */
async function revertCostCorrection(trx, batchId, userId = null) {
  const rows = await trx('cost_corrections')
    .where('batch_id', batchId)
    .whereNull('reverted_at')
    .forUpdate()
    .select('*');

  if (rows.length === 0) return { reverted: 0 };

  for (const row of rows) {
    // Restoring the pair repeats harmlessly when it carries several sale lines: every
    // row of one batch holds the same pre-correction cost for that pair.
    await trx('inventory_items')
      .where('id', row.inventory_item_id)
      .update({ cost: row.old_cost, cost_is_estimated: true, updated_at: new Date() });

    if (row.sale_item_id) {
      await trx('sale_items')
        .where('id', row.sale_item_id)
        .update({ cost_at_sale: row.old_cost, cost_is_estimated: true });
    }
  }

  await trx('cost_corrections')
    .where('batch_id', batchId)
    .whereNull('reverted_at')
    .update({ reverted_at: new Date(), reverted_by: userId });

  return {
    reverted: rows.length,
    pairs: new Set(rows.map((r) => r.inventory_item_id)).size,
    sold_pairs: rows.filter((r) => r.sale_item_id).length,
  };
}

module.exports = { healEstimatedCosts, revertCostCorrection };
