import { useEffect, useMemo, useState } from 'react';
import { formatSize } from '../../utils/variantFormat';
import ColorChips from './ColorChips';
import ColorThumb from './ColorThumb';
import './PhoneGrid.css';

/**
 * Entering quantities per size, on a phone.
 *
 * The wide version is a colour x size table. Measured at 360px it showed 292px of
 * 3688px — about two of forty size columns — so filling one colour's run meant
 * scrolling sideways through a dozen screens with the size headers out of view. It
 * was not slow; it was impractical.
 *
 * Here one colour is current and its sizes are a vertical list. What that costs is
 * the overview the grid gave for free, so it is bought back deliberately:
 *
 *   - every colour chip shows how many pairs are already entered against it, so
 *     "which have I done" is read off the screen rather than remembered;
 *   - a tally line states the running total for this colour and overall;
 *   - a filled row is tinted, so gaps in a long size run are visible at a glance.
 *
 * Each row carries plus and minus buttons as well as the number field. Typing is
 * faster for a box of twelve; tapping is faster and far more accurate for the ones
 * and twos, which is most of them, and it never raises the keyboard over the list.
 */
export default function PhoneQuantityEntry({
  colorRows, sizeCols, grid, setGrid, cat, locale, t, activeColor, setActiveColor,
}) {
  const hasColors = cat.hasColors && colorRows.length > 1;
  const [showAllSizes, setShowAllSizes] = useState(false);

  // Default to the first colour, and recover if the current one disappears because
  // the product changed underneath.
  useEffect(() => {
    if (!colorRows.length) return;
    const stillThere = colorRows.some((c) => c.id === activeColor);
    if (!stillThere) setActiveColor(colorRows[0].id);
  }, [colorRows, activeColor, setActiveColor]);

  const current = colorRows.find((c) => c.id === activeColor) || colorRows[0];

  /** Pairs entered against each colour, for the chip badges. */
  const counts = useMemo(() => {
    const out = {};
    for (const c of colorRows) {
      let n = 0;
      for (const sz of sizeCols) {
        const v = parseInt(grid[`${c.id}|${sz.value}`], 10);
        if (Number.isFinite(v) && v > 0) n += v;
      }
      out[c.id] = n;
    }
    return out;
  }, [colorRows, sizeCols, grid]);

  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  if (!current) return null;

  const keyOf = (sz) => `${current.id}|${sz.value}`;
  const valueOf = (sz) => grid[keyOf(sz)] || '';

  const setValue = (sz, raw) => {
    const next = { ...grid };
    const n = parseInt(raw, 10);
    if (!raw || !Number.isFinite(n) || n <= 0) delete next[keyOf(sz)];
    else next[keyOf(sz)] = String(Math.min(n, 9999));
    setGrid(next);
  };

  const bump = (sz, by) => {
    const n = parseInt(valueOf(sz), 10) || 0;
    setValue(sz, String(Math.max(0, n + by)));
  };

  const clearColour = () => {
    const next = { ...grid };
    for (const sz of sizeCols) delete next[keyOf(sz)];
    setGrid(next);
  };

  /**
   * THE SIZES THIS PRODUCT ACTUALLY CARRIES, FIRST.
   *
   * A shoe category lists 41 sizes (EU 30 to 50 in half steps) and a given product
   * usually stocks six. Offering all 41 means scrolling past thirty-five irrelevant
   * rows for every colour of every product, which on a phone is most of the work.
   *
   * So the default is the sizes the product already has, plus any already typed into
   * this sheet — never hiding something somebody has entered. The rest are one tap
   * away, because receiving a size the product has never carried is perfectly normal
   * and must not be made difficult.
   *
   * With nothing stocked yet (a brand new product) there is no shortlist to make, so
   * the full list shows and the toggle never appears.
   */
  const shown = useMemo(() => {
    if (showAllSizes) return sizeCols;
    const stocked = new Set((cat.stockedSizes || []).map(String));
    if (!stocked.size) return sizeCols;
    const keep = sizeCols.filter((sz) => {
      if (stocked.has(String(sz.value))) return true;
      // Anything already entered against ANY colour stays visible, or switching
      // colour could hide a number somebody has just typed.
      return colorRows.some((c) => {
        const v = parseInt(grid[`${c.id}|${sz.value}`], 10);
        return Number.isFinite(v) && v > 0;
      });
    });
    return keep.length ? keep : sizeCols;
  }, [showAllSizes, sizeCols, cat.stockedSizes, colorRows, grid]);

  const hiddenCount = sizeCols.length - shown.length;

  /**
   * Is a shortlist even possible for this product?
   *
   * Without it, expanding a product that stocks every size would leave a "show
   * fewer" button that does nothing visible — the shortlist and the full list being
   * the same. Computed the same way `shown` is, deliberately: if these two ever
   * disagree the button lies about what it will do.
   */
  const canShortlist = useMemo(() => {
    const stocked = new Set((cat.stockedSizes || []).map(String));
    if (!stocked.size) return false;
    const keep = sizeCols.filter((sz) => stocked.has(String(sz.value))
      || colorRows.some((c) => {
        const v = parseInt(grid[`${c.id}|${sz.value}`], 10);
        return Number.isFinite(v) && v > 0;
      }));
    return keep.length > 0 && keep.length < sizeCols.length;
  }, [sizeCols, cat.stockedSizes, colorRows, grid]);

  const label = (sz) => (sz.value
    ? formatSize({
      size_eu: sz.value, size_label_en: sz.label_en, size_label_ar: sz.label_ar,
      size_prefix: cat.prefix, has_sizes: cat.hasSizes,
    }, locale)
    : t('intake.one_size'));

  return (
    <div data-testid="phone-quantity-entry">
      {hasColors && (
        <ColorChips
          colors={colorRows}
          value={current.id}
          onChange={setActiveColor}
          counts={counts}
          idPrefix="intake-color-chip"
        />
      )}

      {/* Which colour is being filled, always on screen — the thing the grid used to
          say by position and a list cannot. */}
      <div className="phone-tally">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {hasColors && <ColorThumb color={current} size="sm" />}
          <strong data-testid="phone-active-color">
            {hasColors ? current.color_name : t('intake.all')}
          </strong>
        </span>
        <span data-testid="phone-tally">
          {t('intake.phone_tally', { colour: counts[current.id] || 0, total: totalAll })}
        </span>
      </div>

      {(counts[current.id] || 0) > 0 && (
        <div className="phone-bulk">
          <button type="button" className="btn btn-sm btn-secondary"
            data-testid="phone-clear-colour" onClick={clearColour}>
            {t('intake.phone_clear_colour')}
          </button>
        </div>
      )}

      {/* Two-way. Expanding to forty-one rows with no way back would trade one
          scrolling problem for another, and the shortlist is the useful state. */}
      {(hiddenCount > 0 || showAllSizes) && canShortlist && (
        <div className="phone-bulk">
          <button type="button" className="btn btn-sm btn-secondary"
            data-testid={showAllSizes ? 'phone-show-fewer-sizes' : 'phone-show-all-sizes'}
            onClick={() => setShowAllSizes((v) => !v)}>
            {showAllSizes
              ? t('intake.phone_show_fewer_sizes')
              : t('intake.phone_show_all_sizes', { count: hiddenCount })}
          </button>
        </div>
      )}

      <div className="phone-sizes" data-testid="phone-size-list">
        {shown.map((sz) => {
          const v = valueOf(sz);
          const n = parseInt(v, 10) || 0;
          return (
            <div key={String(sz.value)}
              className={`phone-size-row ${n > 0 ? 'phone-size-row--filled' : ''}`}
              data-testid={`phone-size-${sz.value ?? 'one'}`}>
              <span className="phone-size-row__label">{label(sz)}</span>
              <span className="phone-step">
                <button type="button" className="phone-step__btn" disabled={n <= 0}
                  aria-label={`${t('common.remove')} ${label(sz)}`}
                  onClick={() => bump(sz, -1)}>−</button>
                <input
                  type="number"
                  // The phone keypad, not the full keyboard. `type=number` alone is
                  // inconsistent across Android browsers; inputMode is what actually
                  // decides it, and these fields take nothing but digits.
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min="0"
                  className="form-input phone-step__input intake-cell"
                  data-testid={`phone-qty-${sz.value ?? 'one'}`}
                  value={v}
                  onChange={(e) => setValue(sz, e.target.value)}
                />
                <button type="button" className="phone-step__btn"
                  aria-label={`${t('common.add')} ${label(sz)}`}
                  onClick={() => bump(sz, 1)}>+</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
