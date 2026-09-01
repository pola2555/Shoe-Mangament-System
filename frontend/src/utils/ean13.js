/**
 * EAN-13 rendering: turn 13 digits into the 95-module bar pattern.
 *
 * Structure (95 modules):
 *   start guard  101            3
 *   6 left digits  7 each      42   parity (L/G) chosen by the FIRST digit
 *   centre guard 01010          5
 *   6 right digits 7 each      42   always R
 *   end guard    101            3
 *
 * The first digit is never drawn as bars — it is carried entirely by which parity
 * pattern the six left-hand digits use.
 */

// L-code (odd parity)
const L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

// G-code (even parity) — R-code reversed
const G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
];

// R-code — L-code complemented
const R = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
];

// Which of L/G each of the six left digits uses, indexed by the first digit.
const PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

const START_GUARD = '101';
const CENTRE_GUARD = '01010';
const END_GUARD = '101';

export const EAN13_MODULES = 95;
/** Quiet zone either side, in modules. The left one is mandated wider than the right. */
export const QUIET_LEFT = 11;
export const QUIET_RIGHT = 7;

/** EAN-13 mod-10 check digit over the first 12 digits. */
export function checkDigit(twelve) {
  const s = String(twelve);
  if (!/^[0-9]{12}$/.test(s)) throw new Error('checkDigit expects 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code) {
  const s = String(code || '').trim();
  if (!/^[0-9]{13}$/.test(s)) return false;
  return checkDigit(s.slice(0, 12)) === Number(s[12]);
}

/**
 * Encode to a 95-character string of '0' (space) and '1' (bar).
 * @throws when the code is not a valid EAN-13
 */
export function encodeEan13(code) {
  const s = String(code || '').trim();
  if (!isValidEan13(s)) throw new Error(`Not a valid EAN-13: "${code}"`);

  const first = Number(s[0]);
  const left = s.slice(1, 7);
  const right = s.slice(7, 13);
  const parity = PARITY[first];

  let out = START_GUARD;
  for (let i = 0; i < 6; i++) {
    const d = Number(left[i]);
    out += parity[i] === 'L' ? L[d] : G[d];
  }
  out += CENTRE_GUARD;
  for (let i = 0; i < 6; i++) out += R[Number(right[i])];
  out += END_GUARD;

  if (out.length !== EAN13_MODULES) {
    throw new Error(`Internal error: produced ${out.length} modules, expected ${EAN13_MODULES}`);
  }
  return out;
}

/**
 * Collapse the module string into drawable bars, merging runs of adjacent '1's so the
 * SVG has ~30 rects instead of 95. Returns positions in MODULES, not millimetres.
 */
export function encodeEan13Bars(code) {
  const modules = encodeEan13(code);
  const bars = [];
  let i = 0;
  while (i < EAN13_MODULES) {
    if (modules[i] === '1') {
      let w = 1;
      while (i + w < EAN13_MODULES && modules[i + w] === '1') w++;
      bars.push({ x: i, width: w });
      i += w;
    } else {
      i++;
    }
  }
  return bars;
}

/**
 * Guard bars run lower than data bars in a correctly drawn EAN-13, which is what
 * leaves room for the human-readable digits. These are the module offsets of the
 * three guard groups.
 */
export function isGuardModule(x) {
  return (
    x < 3 ||
    (x >= 45 && x < 50) ||
    x >= 92
  );
}

/**
 * The three human-readable digit groups and where they sit, in modules.
 *   first digit  -> in the left quiet zone
 *   left six     -> under the left data block
 *   right six    -> under the right data block
 */
export function hriGroups(code) {
  const s = String(code);
  return [
    { text: s[0], centre: -QUIET_LEFT / 2 - 1 },
    { text: s.slice(1, 7), centre: 3 + 21 },
    { text: s.slice(7, 13), centre: 50 + 21 },
  ];
}
