/**
 * Dividing an amount of money between things, without losing any of it.
 *
 * A box of twelve pairs costing 1000 EGP is 83.333... a pair, and no amount of
 * rounding makes twelve equal shares add back up to 1000. Rounding each share to
 * 83.33 loses four piastres from the stock valuation; rounding to 83.34 invents eight.
 * Neither is acceptable in a figure that feeds profit.
 *
 * So the division is done in piastres and the remainder is handed out, one each, to
 * the first few shares: eight pairs at 83.33 and four at 83.34, which is exactly
 * 1000.00. This is the largest-remainder method, and the only thing that matters about
 * it here is the guarantee it gives — THE PARTS ALWAYS SUM BACK TO THE WHOLE.
 *
 * Which pairs get the extra piastre is arbitrary, and deliberately so: the pairs are
 * physically interchangeable, and any rule for choosing would be a fiction. What is
 * not arbitrary is that the total is preserved.
 */

/**
 * Split `total` into `parts` shares that sum back to `total` exactly.
 *
 * @param {number|string} total  the amount to divide, in whole currency units
 * @param {number} parts         how many shares; must be a positive integer
 * @returns {number[]}           `parts` amounts, each to 2 decimal places
 */
function splitEvenly(total, parts) {
  const n = Number(parts);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`splitEvenly needs a positive whole number of parts, got ${parts}`);
  }

  const amount = Number(total);
  if (!Number.isFinite(amount)) {
    throw new Error(`splitEvenly needs a finite amount, got ${total}`);
  }

  // Work in piastres. Math.round before dividing, because the input may already carry
  // float noise (0.1 + 0.2 arrives as 0.30000000000000004) and truncating that noise
  // would shift a whole piastre.
  const cents = Math.round(amount * 100);
  const base = Math.trunc(cents / n);
  // Negative totals round toward zero above, so the remainder keeps the sign and the
  // shares stay consistent — a credit note divides the same way a cost does.
  let remainder = cents - base * n;
  const step = remainder < 0 ? -1 : 1;
  remainder = Math.abs(remainder);

  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = (base + (i < remainder ? step : 0)) / 100;
  }
  return out;
}

module.exports = { splitEvenly };
