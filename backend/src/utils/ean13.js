/**
 * EAN-13 encoding for internal ("restricted circulation") shop barcodes.
 *
 * Layout — 13 digits, fixed width:
 *
 *   2 · PPPPPP · CC · SSS · K
 *   │     │       │    │     └ mod-10 check digit
 *   │     │       │    └────── size code   (EU size x 2, or 900-999 escape)
 *   │     │       └─────────── colour sequence within the product (01-99)
 *   │     └─────────────────── product sequence (000001-999999)
 *   └───────────────────────── GS1 prefix 2 = restricted circulation, in-store use
 *
 * The embedded meaning is for humans and offline stocktakes ONLY. Every lookup
 * path resolves a scan against product_variants.barcode in the database and never
 * trusts these digits, so a variant whose size was edited after labels were printed
 * is a cosmetic mismatch rather than a mis-sale.
 */

const PREFIX = '2';

const PRODUCT_DIGITS = 6;
const COLOR_DIGITS = 2;
const SIZE_DIGITS = 3;

const MAX_PRODUCT_SEQ = 999999;
const MAX_COLOR_SEQ = 99;

// Size codes 000-899 are `EU size x 2`. 900-999 are escapes for sizes that are not
// plain numbers (size_eu is free text, so '36-37' or 'XL' are possible), allocated
// from the size_codes table.
const MAX_NUMERIC_SIZE_CODE = 899;
const ESCAPE_SIZE_CODE_MIN = 900;
const ESCAPE_SIZE_CODE_MAX = 999;

/**
 * EAN-13 mod-10 check digit over the first 12 digits.
 * Odd positions (1-indexed from the left) weigh 1, even positions weigh 3.
 */
function checkDigit(twelve) {
  const s = String(twelve);
  if (!/^[0-9]{12}$/.test(s)) {
    throw new Error(`checkDigit expects exactly 12 digits, got "${twelve}"`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/** Append the check digit to a 12-digit body. */
function withCheckDigit(twelve) {
  return String(twelve) + String(checkDigit(twelve));
}

/** True when `code` is 13 digits and its final digit is the correct check digit. */
function isValidEan13(code) {
  const s = String(code || '').trim();
  if (!/^[0-9]{13}$/.test(s)) return false;
  return checkDigit(s.slice(0, 12)) === Number(s[12]);
}

/**
 * Convert a size_eu string to its 3-digit size code.
 * Returns null when the size is not a plain number — the caller must then allocate
 * an escape code from the size_codes table.
 */
function sizeToCode(sizeEu) {
  const s = String(sizeEu == null ? '' : sizeEu).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;

  const doubled = Number(s) * 2;
  // Only whole and half sizes are representable; 42.25 is not.
  if (!Number.isInteger(doubled)) return null;
  if (doubled < 0 || doubled > MAX_NUMERIC_SIZE_CODE) return null;
  return doubled;
}

/** Inverse of sizeToCode. Returns null for escape codes, which need a DB lookup. */
function codeToSize(code) {
  const n = Number(code);
  if (!Number.isInteger(n) || n < 0 || n > MAX_NUMERIC_SIZE_CODE) return null;
  return n / 2;
}

function isEscapeSizeCode(code) {
  const n = Number(code);
  return Number.isInteger(n) && n >= ESCAPE_SIZE_CODE_MIN && n <= ESCAPE_SIZE_CODE_MAX;
}

/**
 * Build the full 13-digit barcode from its parts.
 * @param {number} productSeq  1..999999
 * @param {number} colorSeq    1..99
 * @param {number} sizeCode    0..999
 */
function buildVariantBarcode({ productSeq, colorSeq, sizeCode }) {
  if (!Number.isInteger(productSeq) || productSeq < 1 || productSeq > MAX_PRODUCT_SEQ) {
    throw new Error(`productSeq out of range (1-${MAX_PRODUCT_SEQ}): ${productSeq}`);
  }
  if (!Number.isInteger(colorSeq) || colorSeq < 1 || colorSeq > MAX_COLOR_SEQ) {
    throw new Error(`colorSeq out of range (1-${MAX_COLOR_SEQ}): ${colorSeq}`);
  }
  if (!Number.isInteger(sizeCode) || sizeCode < 0 || sizeCode > ESCAPE_SIZE_CODE_MAX) {
    throw new Error(`sizeCode out of range (0-${ESCAPE_SIZE_CODE_MAX}): ${sizeCode}`);
  }

  const body =
    PREFIX +
    String(productSeq).padStart(PRODUCT_DIGITS, '0') +
    String(colorSeq).padStart(COLOR_DIGITS, '0') +
    String(sizeCode).padStart(SIZE_DIGITS, '0');

  return withCheckDigit(body);
}

/**
 * Split a barcode back into its parts. Advisory only — never use this to resolve a
 * scan. Returns null when the code is not one of ours or fails its check digit.
 */
function parseVariantBarcode(code) {
  const s = String(code || '').trim();
  if (!isValidEan13(s)) return null;
  if (s[0] !== PREFIX) return null;

  const sizeCode = Number(s.slice(9, 12));
  return {
    prefix: s[0],
    productSeq: Number(s.slice(1, 7)),
    colorSeq: Number(s.slice(7, 9)),
    sizeCode,
    sizeEu: isEscapeSizeCode(sizeCode) ? null : codeToSize(sizeCode),
  };
}

/** True when the code uses our in-store prefix (as opposed to a manufacturer EAN). */
function isInternalBarcode(code) {
  const s = String(code || '').trim();
  return isValidEan13(s) && s[0] === PREFIX;
}

/**
 * Normalise raw scanner/camera input. Hardware wedges commonly append CR/LF and can
 * emit leading zeros or surrounding whitespace; UPC-A (12 digits) is an EAN-13 with a
 * leading zero, so widen it rather than rejecting it.
 */
function normalizeScan(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/[\r\n\t]/g, '');
  s = s.replace(/\s+/g, '');
  if (/^[0-9]{12}$/.test(s)) s = '0' + s; // UPC-A -> EAN-13
  return s;
}

module.exports = {
  PREFIX,
  MAX_PRODUCT_SEQ,
  MAX_COLOR_SEQ,
  MAX_NUMERIC_SIZE_CODE,
  ESCAPE_SIZE_CODE_MIN,
  ESCAPE_SIZE_CODE_MAX,
  checkDigit,
  withCheckDigit,
  isValidEan13,
  sizeToCode,
  codeToSize,
  isEscapeSizeCode,
  buildVariantBarcode,
  parseVariantBarcode,
  isInternalBarcode,
  normalizeScan,
};
