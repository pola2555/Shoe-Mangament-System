/**
 * Obfuscated price code for shelf/box labels.
 *
 * The plain price is deliberately NOT printed. Instead the digits are reversed and
 * fixed filler letters are interleaved:
 *
 *   1450  ->  reverse "0541"  ->  interleave  ->  "0F5H4K1"
 *
 * Staff decode by eye: drop the letters, read the digits backwards.
 *
 * Fillers are FIXED BY POSITION rather than random, so reprinting a label always
 * produces a byte-identical code — a code that changed between prints would read to
 * staff as "the price changed".
 *
 * The filler alphabet excludes letters that read as digits (I O S Z B G Q L D ->
 * 1 0 5 2 8 6 0 1 0), which would make the code ambiguous at a glance.
 *
 * Note this is obfuscation, not encryption: the true digits are still present on the
 * label, so someone who works out the reversal can read the price. That trade-off was
 * accepted in favour of staff being able to decode it without memorising a keyword.
 */

// No I, O, S, Z, B, G, Q, L or D — each of those reads as a digit.
const FILLERS = ['F', 'H', 'K', 'M', 'N', 'P', 'R', 'T', 'V', 'W'];

const LETTER_RE = /[A-Z]/g;

/**
 * Encode a price as its label code.
 * Rounded to whole EGP — piastres are not used in practice and would double the code
 * length on a label row that is already sharing space with the product code.
 *
 * @param {number|string} price
 * @returns {string} e.g. "0F5H4K1", or '' when there is no usable price
 */
function encodePriceCode(price) {
  // Guard before Number(): Number(null) and Number('') are both 0, so a missing price
  // would otherwise encode as "0" and staff would decode it as free.
  if (price === null || price === undefined || price === '') return '';

  const n = Math.round(Number(price));
  if (!Number.isFinite(n) || n < 0) return '';

  const reversed = String(n).split('').reverse();

  let out = '';
  for (let i = 0; i < reversed.length; i++) {
    out += reversed[i];
    // Filler goes between digits, never trailing — a trailing letter would look like
    // part of the next field when the row is tight.
    if (i < reversed.length - 1) out += FILLERS[i % FILLERS.length];
  }
  return out;
}

/**
 * Decode a label code back to the price. Inverse of encodePriceCode.
 * @returns {number|null} null when the code contains no digits
 */
function decodePriceCode(code) {
  const s = String(code == null ? '' : code).toUpperCase().replace(LETTER_RE, '');
  if (!/^[0-9]+$/.test(s)) return null;
  return Number(s.split('').reverse().join(''));
}

module.exports = { encodePriceCode, decodePriceCode, FILLERS };
