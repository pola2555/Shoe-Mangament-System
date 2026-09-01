import Ean13Svg from './Ean13Svg';
import { formatSize, formatColor } from '../../utils/variantFormat';

/**
 * Printable shoe labels.
 *
 * Default stock is 38 x 25 mm on a TSC TDP-225 (203 dpi direct thermal). The vertical
 * budget is tight, so the rows are fixed rather than flowed:
 *
 *   1.0  top padding
 *   2.8  brand + model
 *  11.4  barcode (8.5 bars + 0.9 guard descender + 2.0 digits)
 *   5.0  colour + EU size   <- the row staff actually read
 *   2.8  product code + coded price
 *   1.0  bottom padding
 *  ----
 *  24.0  of 25.0 mm
 *
 * Labels are forced LTR even when the app is in Arabic: the barcode, size and price
 * code are all left-to-right, and mirroring them would put the size where staff do
 * not expect it.
 *
 * ---------------------------------------------------------------------------
 * Two things here exist purely because of how browsers paginate to a label roll:
 *
 * 1. The sheet is BLOCK flow, never flex, in print. Chrome's fragmentation inside a
 *    flex container is unreliable — `break-inside: avoid` on a flex item is widely
 *    ignored — so a single label would straddle a page boundary and come out printed
 *    across two stickers. Flex is re-enabled for the on-screen preview only.
 *
 * 2. `rotate` counter-rotates the artwork by a quarter turn. Chrome derives page
 *    ORIENTATION from `@page { size: W H }`: width > height means landscape, and a
 *    driver whose stock is already defined as 38 x 25 responds by turning the image
 *    sideways — at which point the 38 mm design runs along the 25 mm feed direction
 *    and spills onto the next label. Rotating the artwork inside a portrait page box
 *    (25 x 38) sidesteps the orientation guess entirely.
 *
 *    Both directions are offered because which way a driver turns the image is not
 *    knowable from here, and guessing wrong prints the label upside down. 90 and 270
 *    between them cover it, so calibration is two test labels at worst.
 */

export const LABEL_SIZES = {
  '38x25': { w: 38, h: 25, label: '38 × 25 mm', module: 0.25, barH: 8.5, nameMm: 2.6, bigMm: 4.2, footMm: 2.4 },
  '40x30': { w: 40, h: 30, label: '40 × 30 mm', module: 0.25, barH: 11, nameMm: 3.0, bigMm: 5.0, footMm: 2.8 },
  '50x25': { w: 50, h: 25, label: '50 × 25 mm', module: 0.3, barH: 8.5, nameMm: 2.8, bigMm: 4.4, footMm: 2.6 },
  '30x20': { w: 30, h: 20, label: '30 × 20 mm', module: 0.2, barH: 7.0, nameMm: 2.2, bigMm: 3.6, footMm: 2.0 },
};

export const LABEL_ROTATIONS = [0, 90, 270];

/**
 * @param {string} size    key into LABEL_SIZES
 * @param {number} rotate  0, 90 or 270 — how far to turn the artwork on the label
 */
export function labelCss(size, rotate = 0) {
  const s = LABEL_SIZES[size] || LABEL_SIZES['38x25'];
  const deg = LABEL_ROTATIONS.includes(Number(rotate)) ? Number(rotate) : 0;
  const turned = deg !== 0;

  // The page box is the label as the PRINTER feeds it; the artwork box is always the
  // design's own 38 x 25. When turned, those two differ and the transform bridges them.
  const pw = turned ? s.h : s.w;
  const ph = turned ? s.w : s.h;

  // rotate(90deg) maps (x, y) -> (-y, x), putting the artwork at x in [-h, 0]; shifting
  // right by the page width brings it back. rotate(-90deg) maps (x, y) -> (y, -x), so
  // that one needs the same correction downwards instead.
  let turn = '';
  if (deg === 90) turn = `transform-origin: 0 0; transform: translateX(${s.h}mm) rotate(90deg);`;
  if (deg === 270) turn = `transform-origin: 0 0; transform: translateY(${s.w}mm) rotate(-90deg);`;

  return `
@page { size: ${pw}mm ${ph}mm; margin: 0; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #fff; }

/* Block flow — see the note at the top of this file. */
.sheet { display: block; }

.shoe-label {
  width: ${pw}mm; height: ${ph}mm;
  box-sizing: border-box;
  position: relative; overflow: hidden;
  background: #fff; color: #000;
  break-inside: avoid; page-break-inside: avoid;
  break-after: page; page-break-after: always;
}
.shoe-label:last-child { break-after: auto; page-break-after: auto; }

.lbl-inner {
  width: ${s.w}mm; height: ${s.h}mm;
  box-sizing: border-box; padding: 1mm 1.2mm;
  display: flex; flex-direction: column; justify-content: space-between;
  overflow: hidden;
  direction: ltr; text-align: left;
  font-family: Arial, Helvetica, sans-serif;
  ${turn}
}
.lbl-name {
  font-size: ${s.nameMm}mm; line-height: 1.05; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lbl-name .brand { font-weight: 800; }
.lbl-name .model { font-weight: 400; }
.lbl-bc { display: flex; justify-content: center; align-items: center; }
.lbl-mid {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: ${s.bigMm}mm; line-height: 1; font-weight: 800;
}
.lbl-mid .colour {
  font-weight: 600; font-size: ${s.bigMm * 0.78}mm;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 55%;
}
.lbl-foot {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: ${s.footMm}mm; line-height: 1;
  font-family: 'Courier New', monospace;
}
.lbl-foot .code { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 58%; }
.lbl-foot .price { font-weight: 700; letter-spacing: 0.15mm; }

/* Screen-only preview chrome; never printed. */
@media screen {
  .sheet { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 6px; }
  .shoe-label { border: 1px dashed #bbb; }
}
@media print { .no-print { display: none !important; } }
`;
}

/** One label. `row` is a payload from GET /api/barcodes/labels. */
export function ShoeLabel({ row, size = '38x25', locale }) {
  const s = LABEL_SIZES[size] || LABEL_SIZES['38x25'];
  return (
    <div className="shoe-label">
      <div className="lbl-inner">
        <div className="lbl-name">
          {row.brand ? <span className="brand">{row.brand} </span> : null}
          <span className="model">{row.product_name}</span>
        </div>

        <div className="lbl-bc">
          <Ean13Svg
            value={row.barcode}
            moduleMm={s.module}
            barHeightMm={s.barH}
            guardExtendMm={0.9}
            hriFontMm={2.0}
          />
        </div>

        <div className="lbl-mid">
          <span className="colour">{formatColor(row) || ''}</span>
          <span className="size">{formatSize(row, locale)}</span>
        </div>

        <div className="lbl-foot">
          <span className="code">{row.product_code}</span>
          {/* Deliberately the obfuscated code, never the plain price. */}
          <span className="price">{row.price_code}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * A run of labels. `copies` maps variant_id -> how many to print; rows with 0 are
 * skipped entirely so an unwanted size does not eat a blank label off the roll.
 */
export default function LabelSheet({ rows, copies, size = '38x25', locale }) {
  const out = [];
  for (const row of rows) {
    if (!row.barcode) continue;
    const n = copies ? Number(copies[row.variant_id] || 0) : 1;
    for (let i = 0; i < n; i++) {
      out.push(<ShoeLabel key={`${row.variant_id}-${i}`} row={row} size={size} locale={locale} />);
    }
  }
  return <div className="sheet">{out}</div>;
}
