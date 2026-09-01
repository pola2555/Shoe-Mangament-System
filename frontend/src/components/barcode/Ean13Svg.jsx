import { useMemo } from 'react';
import { encodeEan13Bars, isGuardModule, hriGroups, QUIET_LEFT, QUIET_RIGHT, EAN13_MODULES } from '../../utils/ean13';

/**
 * EAN-13 rendered as SVG, sized in real millimetres so it prints at a known physical
 * width rather than whatever the browser's pixel scaling produces.
 *
 * The module width defaults to 0.25 mm = exactly 2 dots on a 203 dpi printer (the
 * TSC TDP-225). Keeping it a whole number of dots matters: a fractional module width
 * makes the printer round some bars up and others down, which shows up as uneven bar
 * widths and hurts read rate. 3 dots (0.375 mm) would be truer to the EAN spec but
 * makes the symbol 39.8 mm wide, which does not fit a 38 mm label.
 *
 * Total width = (95 + 11 left quiet + 7 right quiet) x module.
 */
export default function Ean13Svg({
  value,
  moduleMm = 0.25,
  barHeightMm = 8.5,
  guardExtendMm = 0.9,
  hriFontMm = 2.3,
  showHri = true,
  color = '#000',
  className,
}) {
  const model = useMemo(() => {
    try {
      return { bars: encodeEan13Bars(value), groups: hriGroups(value), error: null };
    } catch (err) {
      return { bars: null, groups: null, error: err.message };
    }
  }, [value]);

  const totalModules = EAN13_MODULES + QUIET_LEFT + QUIET_RIGHT;
  const widthMm = totalModules * moduleMm;
  const hriBandMm = showHri ? hriFontMm * 1.15 : 0;
  const heightMm = barHeightMm + guardExtendMm + hriBandMm;

  if (model.error) {
    return (
      <div
        className={className}
        style={{
          width: `${widthMm}mm`, height: `${heightMm}mm`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px dashed #c00', color: '#c00',
          fontSize: '2mm', textAlign: 'center', boxSizing: 'border-box',
        }}
      >
        no barcode
      </div>
    );
  }

  const x0 = QUIET_LEFT; // bars start after the left quiet zone

  return (
    <svg
      className={className}
      width={`${widthMm}mm`}
      height={`${heightMm}mm`}
      viewBox={`0 0 ${widthMm} ${heightMm}`}
      // 1 user unit == 1 mm, so nothing is rescaled on the way to the printer.
      shapeRendering="crispEdges"
      role="img"
      aria-label={`barcode ${value}`}
      data-barcode={value}
    >
      {/* White ground: the quiet zones are part of the symbol, not decoration.
          Without them a scanner can fail to find the start guard. */}
      <rect x="0" y="0" width={widthMm} height={heightMm} fill="#fff" />

      {model.bars.map((b, i) => {
        // Guard bars run lower than data bars — that descender is what visually
        // separates the three human-readable digit groups.
        const isGuard = isGuardModule(b.x);
        const h = barHeightMm + (isGuard ? guardExtendMm : 0);
        return (
          <rect
            key={i}
            x={(x0 + b.x) * moduleMm}
            y={0}
            width={b.width * moduleMm}
            height={h}
            fill={color}
          />
        );
      })}

      {showHri && model.groups.map((g, i) => (
        <text
          key={i}
          x={(x0 + g.centre) * moduleMm}
          y={heightMm - hriFontMm * 0.12}
          textAnchor="middle"
          fontSize={hriFontMm}
          fontFamily="'Courier New', ui-monospace, monospace"
          letterSpacing={moduleMm * 0.35}
          fill={color}
        >
          {g.text}
        </text>
      ))}
    </svg>
  );
}
