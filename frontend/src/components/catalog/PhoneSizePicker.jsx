import { useEffect, useMemo } from 'react';
import ColorChips from './ColorChips';
import ColorThumb from './ColorThumb';
import './PhoneGrid.css';

/**
 * Choosing which sizes a colour should have, on a phone.
 *
 * The same problem as the quantity grid and the same answer: the colour x size table
 * is far wider than a phone, so one colour is current and its sizes are a list.
 *
 * Three states per size, and each is given a glyph as well as a colour — "already
 * exists" and "about to be created" must not rest on telling green from indigo:
 *
 *   ✓  exists already, and cannot be unpicked here
 *   +  picked, will be created when you save
 *      neither
 *
 * `cellExists`, `isSelected` and `toggle` come from the parent so the wide and narrow
 * layouts share one source of truth about what is picked — two copies of that state
 * would drift the moment somebody rotated the phone.
 */
export default function PhoneSizePicker({
  colors, sizeValues, hasColors, labelFor, cellExists, isSelected, toggle, setMany,
  activeColor, setActiveColor, t,
}) {
  useEffect(() => {
    if (!colors.length) return;
    if (!colors.some((c) => c.id === activeColor)) setActiveColor(colors[0].id);
  }, [colors, activeColor, setActiveColor]);

  const current = colors.find((c) => c.id === activeColor) || colors[0];

  /** Sizes picked per colour, for the chip badges. Existing ones are not counted:
   *  the number means "about to be created", which is what Save will act on. */
  const counts = useMemo(() => {
    const out = {};
    for (const c of colors) {
      out[c.id] = sizeValues.filter((v) => isSelected(c.id, v) && !cellExists(c.id, v)).length;
    }
    return out;
  }, [colors, sizeValues, isSelected, cellExists]);

  if (!current) return null;

  const pickable = sizeValues.filter((v) => !cellExists(current.id, v));
  const allPicked = pickable.length > 0 && pickable.every((v) => isSelected(current.id, v));

  return (
    <div data-testid="phone-size-picker">
      {hasColors && colors.length > 1 && (
        <ColorChips
          colors={colors}
          value={current.id}
          onChange={setActiveColor}
          counts={counts}
          idPrefix="matrix-color-chip"
        />
      )}

      <div className="phone-tally">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {hasColors && <ColorThumb color={current} size="sm" />}
          <strong>{hasColors ? current.color_name : t('products.no_colors_product')}</strong>
        </span>
        <span>{t('products.selected_count', { count: counts[current.id] || 0 })}</span>
      </div>

      {pickable.length > 0 && (
        <div className="phone-bulk">
          <button type="button" className="btn btn-sm btn-secondary"
            data-testid="phone-pick-all"
            onClick={() => setMany(pickable.map((v) => [current.id, v]), !allPicked)}>
            {allPicked ? t('products.clear_selection') : t('products.select_all_sizes')}
          </button>
        </div>
      )}

      <div className="phone-sizes">
        {sizeValues.map((v) => {
          const exists = cellExists(current.id, v);
          const sel = isSelected(current.id, v);
          const state = exists ? 'exists' : sel ? 'selected' : 'empty';
          return (
            <button
              key={String(v)}
              type="button"
              className="phone-pick"
              data-state={state}
              disabled={exists}
              data-testid={`phone-pick-${v === null ? 'one' : v}`}
              onClick={() => !exists && toggle(current.id, v)}
            >
              <span className="phone-pick__mark" aria-hidden="true">
                {exists ? '✓' : sel ? '+' : ''}
              </span>
              <span>{labelFor(v)}</span>
              {exists && <span className="phone-pick__note">{t('products.already_exists')}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
