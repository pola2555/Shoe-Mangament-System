/**
 * THE PRICE BAND IS NOT FOR EVERYONE.
 *
 * A cashier is meant to sell at the marked price. If they want to go under it they ask,
 * and a manager answers — that is what the discount request is for. Showing them the
 * floor and the ceiling turns "the price is 450" into "the price is somewhere between
 * 380 and 520", which is a different shop.
 *
 * WHY A RESPONSE FILTER AND NOT A UI CHANGE
 *
 * The band reaches the browser from eight different endpoints — the till's product
 * grid, the inventory list and summary, the barcode lookup, product detail, the branch
 * price sheet, the discount screen. Hiding it in each of those is a list that goes
 * stale the first time somebody adds a ninth, and it protects nothing anyway: the
 * numbers would still be in the JSON, one devtools tab away. This codebase has already
 * been bitten by exactly that — the branch price band was enforced on screen and not on
 * the server, so any other client could sell under the floor.
 *
 * So it is stripped on the way out, in one place, for anyone who may not see it.
 *
 * WHO MAY SEE IT
 *
 *   - an admin
 *   - `price_override` — they are allowed to price away from the default, so the band
 *     is the thing that tells them how far
 *   - `product_prices` — they set the band
 *   - `discount_approval` — they answer requests, and cannot judge one without knowing
 *     how far under the floor it goes
 *
 * Everyone else gets the selling price and nothing else.
 */

const BAND_FIELDS = [
  'min_selling_price',
  'max_selling_price',
  'store_min_selling_price',
  'store_max_selling_price',
  // The discount request carries the floor too — per line (`min_price`) and for the
  // whole cart (`min_total`). Those are the same secret under a different name, so a
  // cashier without price permission must not read them off a request either. Only the
  // discounts screen ever emits them, so scrubbing them collides with nothing else.
  'min_price',
  'min_total',
];

/** Does this user get to see the floor and the ceiling? */
function canSeePriceBand(user) {
  if (!user) return false;
  if (user.role_name === 'admin') return true;
  const p = user.permissions || {};
  return Boolean(p.price_override || p.product_prices || p.discount_approval);
}

/**
 * Recursively delete the band fields from anything that came back.
 *
 * Depth-limited so a cyclic or pathologically nested payload cannot hang a response;
 * nothing this API returns is anywhere near ten deep.
 */
function scrub(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return value;

  if (Array.isArray(value)) {
    for (const v of value) scrub(v, depth + 1);
    return value;
  }

  for (const f of BAND_FIELDS) {
    if (f in value) delete value[f];
  }
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (v && typeof v === 'object') scrub(v, depth + 1);
  }
  return value;
}

function priceVisibility(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // req.user is set by the per-router auth, which runs after this app-level
    // middleware but before the handler that calls res.json — so it is populated here.
    if (body && !canSeePriceBand(req.user)) scrub(body);
    return originalJson(body);
  };
  next();
}

module.exports = priceVisibility;
module.exports.canSeePriceBand = canSeePriceBand;
module.exports.BAND_FIELDS = BAND_FIELDS;
