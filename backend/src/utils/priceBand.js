const AppError = require('./AppError');

/**
 * A FLOOR ABOVE A CEILING IS NOT A PRICE RULE, IT IS A TYPO.
 *
 * Nothing used to compare the two, because each is a perfectly good number on its own
 * — neither is negative, and that was the whole of the validation. So swapping them
 * was accepted silently, and the product it happened to went on looking completely
 * normal: it could be bought, received, counted, transferred and labelled. It simply
 * could never be SOLD, because `sales.service` then asks for a price that is at once
 * >= 90 and <= 80, which nothing satisfies. At the till that reads as one product that
 * "doesn't work", with no message naming the cause.
 *
 * WHY IT LIVES HERE AND NOT IN JOI
 *
 * Joi only sees the request. A product edit and a branch price sheet may each send ONE
 * of the two numbers, and whether that number is legal depends entirely on the value
 * already stored beside it — so the rule has to run where the merged pair is known.
 * Two callers write a band (`products.setStorePrice` and `stores.setPrice`), which is
 * the other reason it is one function rather than a copy in each.
 *
 * `null` means "not set" and never constrains anything, which is why only a pair of
 * real numbers is compared. Equal is allowed: a band of 80-80 is a fixed price, which
 * is a thing a shop legitimately wants.
 */
function assertSellingBand(min, max, context = 'This product') {
  const lo = toNum(min);
  const hi = toNum(max);
  if (lo === null || hi === null) return;
  if (lo > hi) {
    throw new AppError(
      `${context} would have a minimum price (${lo}) above its maximum (${hi}), `
      + 'so no price could ever be accepted for it. Check the two are not swapped.',
      400,
    );
  }
}

/**
 * The band a branch actually trades in, for a product it may or may not have priced.
 *
 * Each end is resolved INDEPENDENTLY — the branch's number when the branch set one,
 * the catalogue's otherwise. That is not a simplification, it is exactly what
 * `sales.service` does at checkout, and the reason a band can be impossible while
 * both numbers in the request look sane: a branch floor of 90 against a catalogue
 * ceiling of 80 is two reasonable edits and one unsellable product.
 */
function effectiveBand(storeRow, product) {
  const pick = (key) => {
    const own = storeRow ? storeRow[key] : null;
    return own === null || own === undefined || own === '' ? product[key] : own;
  };
  return { min: pick('min_selling_price'), max: pick('max_selling_price') };
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { assertSellingBand, effectiveBand, toNum };
