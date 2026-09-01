/**
 * TSPL/TSPL2 label generation for the TSC TDP-225.
 *
 * This is the escape hatch for anyone who would rather stream commands straight at
 * the printer than go through the Windows driver and the browser print dialog. The
 * printer renders the barcode from its own firmware, which is marginally sharper
 * than a rasterised SVG — and, more usefully, TSPL addresses the media directly, so
 * none of the browser's page-orientation guessing applies.
 *
 * Coordinates are in DOTS. The TDP-225 is 203 dpi, so 1 mm = 8 dots.
 *
 * Usage on Windows, with the printer shared as "TSC":
 *   copy /b labels.txt \%COMPUTERNAME%\TSC
 */

import { formatSize, formatColor } from './variantFormat';

const DOTS_PER_MM = 8; // 203 dpi

const mm = (v) => Math.round(v * DOTS_PER_MM);

/** TSPL string literals are double-quoted; escape embedded quotes and strip CR/LF. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '\\"');
}

/**
 * Build the TSPL program for a run of labels.
 *
 * @param {Array} rows   label payloads from GET /api/barcodes/labels
 * @param {object} copies  variant_id -> count
 * @param {{w:number,h:number}} size  ARTWORK size in mm (38 x 25 by default)
 * @param {object} opts
 * @param {number} opts.gapMm   vertical gap between labels on the roll
 * @param {number} opts.rotate  0, 90 or 270 — turn the artwork on the media
 *
 * When turned, the media is fed the short way round: SIZE becomes h x w and every
 * element carries TSPL's own rotation. TSPL rotates clockwise about the element's
 * start point, so an artwork point (dx, dy) lands at (h - dy, dx) for a quarter turn
 * right and at (dy, w - dx) for a quarter turn left.
 */
export function buildTspl(rows, copies, size = { w: 38, h: 25 }, opts = {}) {
  const { gapMm = 2, rotate = 0, locale } = opts;
  const rot = [0, 90, 270].includes(Number(rotate)) ? Number(rotate) : 0;
  const turned = rot !== 0;
  const out = [];

  const mediaW = turned ? size.h : size.w;
  const mediaH = turned ? size.w : size.h;
  /** Artwork coordinate -> media coordinate, in dots. */
  const at = (dx, dy) => {
    if (rot === 90) return `${mm(size.h - dy)},${mm(dx)}`;
    if (rot === 270) return `${mm(dy)},${mm(size.w - dx)}`;
    return `${mm(dx)},${mm(dy)}`;
  };

  out.push(`SIZE ${mediaW} mm,${mediaH} mm`);
  out.push(`GAP ${gapMm} mm,0`);
  out.push('DIRECTION 1');
  out.push('REFERENCE 0,0');
  out.push('DENSITY 8');
  out.push('SPEED 4');
  out.push('');

  for (const row of rows) {
    if (!row.barcode) continue;
    const n = copies ? Number(copies[row.variant_id] || 0) : 1;
    if (n <= 0) continue;

    // EAN13 in TSPL takes the 12 data digits; the firmware appends the check digit.
    // Passing all 13 makes it encode the check digit as data and produce a wrong symbol.
    const data12 = String(row.barcode).slice(0, 12);
    const isEan13 = /^[0-9]{13}$/.test(String(row.barcode));

    const name = [row.brand, row.product_name].filter(Boolean).join(' ');

    out.push('CLS');
    // Row 1 — brand + model
    out.push(`TEXT ${at(1.2, 1.0)},"1",${rot},1,1,"${esc(name).slice(0, 30)}"`);

    // Row 2 — the symbol. 'EAN13' with narrow bar 2 dots matches the 0.25 mm module
    // the SVG renderer uses, so both paths print the same physical width.
    if (isEan13) {
      out.push(`BARCODE ${at(5.0, 4.0)},"EAN13",${mm(8.5)},1,${rot},2,2,"${data12}"`);
    } else {
      out.push(`BARCODE ${at(3.0, 4.0)},"128",${mm(8.5)},1,${rot},2,2,"${esc(row.barcode)}"`);
    }

    // Row 3 — colour and size, the part staff read
    out.push(`TEXT ${at(1.2, 16.0)},"2",${rot},1,1,"${esc(formatColor(row) || '').slice(0, 14)}"`);
    out.push(`TEXT ${at(size.w - 1.2, 16.0)},"2",${rot},1,1,3,"${esc(formatSize(row, locale))}"`);

    // Row 4 — product code and the coded price (never the plain price)
    out.push(`TEXT ${at(1.2, 21.0)},"1",${rot},1,1,"${esc(row.product_code).slice(0, 14)}"`);
    out.push(`TEXT ${at(size.w - 1.2, 21.0)},"1",${rot},1,1,3,"${esc(row.price_code)}"`);

    out.push(`PRINT ${n},1`);
    out.push('');
  }

  return out.join('\r\n');
}

/** Offer the TSPL program as a .txt download. */
export function downloadTspl(rows, copies, size, opts = {}, filename = 'labels.tspl.txt') {
  const text = buildTspl(rows, copies, size, opts);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick; revoking synchronously can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return text;
}
