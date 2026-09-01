/**
 * Numeric sort key for a size label.
 *
 * `product_variants.size_eu` is a varchar, so ordering by it directly is lexical:
 * '10' lands before '9', and alpha sizes would come back L, M, S. `size_sort` is the
 * key every ORDER BY uses instead.
 *
 * Scaled by 10 so half sizes stay whole numbers and interleave correctly:
 *   41 -> 410,  41.5 -> 415,  42 -> 420
 *
 * A label with no digits ('S', 'OS') yields 0 here. That is deliberate and temporary:
 * once a size belongs to a size scale the key comes from the scale's own ordering,
 * which is what makes S < M < L work. This function is the fallback for a size that
 * belongs to no scale.
 *
 * The character class is [.] rather than an escaped dot to match the expression the
 * SQL side already uses (inventory.service.js, and the backfill in
 * 20260901_001_variant_sort_and_updated_at.js), so both sides agree exactly.
 */
function sizeSortOf(sizeEu) {
  const match = String(sizeEu == null ? '' : sizeEu).match(/[0-9]+([.][0-9]+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  return Number.isFinite(n) ? Math.round(n * 10) : 0;
}

module.exports = { sizeSortOf };
