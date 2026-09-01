import { useState, useMemo } from 'react';
import { useTranslation } from '../../i18n/i18nContext';
import { sizeValueLabel } from '../../utils/variantFormat';

/**
 * Pick which colour/size combinations this product is stocked in.
 *
 * This replaces a numeric range generator ("from 38 to 45") that could only ever
 * produce whole numbers — no half sizes, and nothing at all for Kids/Teens/Adults or
 * S/M/L. The sizes offered here come from the product's category, so a sock offers
 * what socks have and a bag offers nothing at all.
 *
 * A cell that already exists is shown filled and cannot be selected, so re-opening
 * this to add one newly stocked size is a single tap rather than a hunt.
 *
 * Everything is saved in ONE request. The old flow fired one request per colour in
 * parallel, so a failure halfway left part of a matrix created with no indication of
 * which part.
 */
export default function VariantMatrix({ product, onCreate, creating }) {
  const { t, locale } = useTranslation();
  const [selected, setSelected] = useState(() => new Set());
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const category = product.category;
  const hasSizes = category ? category.has_sizes : true;
  const hasColors = category ? category.has_colors : true;
  const isNumeric = category ? category.scale_is_numeric : true;

  // A colourless product still has exactly one (placeholder) colour row behind the
  // scenes — variants and images hang off it — but it is never named in the UI.
  const colors = product.colors || [];
  const sizeValues = useMemo(() => {
    if (!hasSizes) return [null]; // one unnamed column; the server picks the sole value
    return (category?.size_values || []).map((v) => v.value);
  }, [category, hasSizes]);

  const existing = useMemo(() => {
    const set = new Set();
    for (const v of product.variants || []) set.add(v.product_color_id + '::' + v.size_eu);
    return set;
  }, [product.variants]);

  const labelFor = (value) => {
    if (value === null) return t('categories.hint_no_sizes');
    const def = (category?.size_values || []).find((v) => v.value === value);
    return def ? sizeValueLabel(def, locale) : value;
  };

  // For a sizeless category the single cell still has to carry a size, and only the
  // server knows which one — so the key uses a sentinel the payload turns into null.
  const keyOf = (colorId, value) => colorId + '::' + (value === null ? '' : value);

  const cellExists = (colorId, value) => {
    if (value !== null) return existing.has(colorId + '::' + value);
    // Sizeless: any variant on this colour is the one and only variant.
    return (product.variants || []).some((v) => v.product_color_id === colorId);
  };

  const toggle = (colorId, value) => {
    if (cellExists(colorId, value)) return;
    const key = keyOf(colorId, value);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setMany = (pairs, on) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const [colorId, value] of pairs) {
        if (cellExists(colorId, value)) continue;
        const key = keyOf(colorId, value);
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const allPairs = () => {
    const out = [];
    for (const c of colors) for (const v of sizeValues) out.push([c.id, v]);
    return out;
  };

  const rowFull = (colorId) =>
    sizeValues.every((v) => cellExists(colorId, v) || selected.has(keyOf(colorId, v)));
  const colFull = (value) =>
    colors.every((c) => cellExists(c.id, value) || selected.has(keyOf(c.id, value)));

  /** Numeric scales keep the old from/to convenience, now applied to the real list. */
  const applyRange = () => {
    const lo = parseFloat(rangeFrom);
    const hi = parseFloat(rangeTo);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return;
    const inRange = sizeValues.filter((v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= lo && n <= hi;
    });
    const targets = colors.length ? colors : [];
    const pairs = [];
    for (const c of targets) for (const v of inRange) pairs.push([c.id, v]);
    setMany(pairs, true);
  };

  const count = selected.size;

  const handleCreate = () => {
    const variants = [];
    for (const key of selected) {
      const idx = key.indexOf('::');
      const colorId = key.slice(0, idx);
      const value = key.slice(idx + 2);
      variants.push({
        product_color_id: colorId,
        // Empty means "this category has no sizes" — the server resolves it.
        ...(value === '' ? {} : { size_eu: value }),
      });
    }
    onCreate({ variants });
    setSelected(new Set());
  };

  if (hasColors && colors.length === 0) {
    return <p style={{ color: 'var(--color-danger)' }}>{t('products.add_colors_first')}</p>;
  }

  const cellStyle = (state) => ({
    minWidth: 54, padding: '.4rem .5rem', textAlign: 'center', cursor: state === 'exists' ? 'default' : 'pointer',
    borderRadius: 'var(--radius-sm)', userSelect: 'none',
    border: '1px solid ' + (state === 'selected' ? 'var(--color-primary)' : 'var(--color-border)'),
    background: state === 'exists' ? 'var(--color-bg-secondary)'
      : state === 'selected' ? 'var(--color-primary-light, #e3ecfb)' : 'var(--color-surface)',
    color: state === 'exists' ? 'var(--color-text-secondary)' : 'inherit',
    fontWeight: state === 'selected' ? 700 : 400,
    opacity: state === 'exists' ? 0.7 : 1,
  });

  return (
    <div data-testid="variant-matrix">
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
        <strong>{hasSizes ? t('products.size_matrix') : t('products.no_sizes_product')}</strong>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          {t('products.matrix_hint')}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="matrix-all"
          onClick={() => setMany(allPairs(), true)}>
          {hasSizes ? t('products.all_sizes') : t('products.all_colors')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="matrix-clear"
          onClick={() => setSelected(new Set())}>
          {t('products.clear_selection')}
        </button>

        {/* The from/to shortcut only means anything on a numeric list. */}
        {hasSizes && isNumeric && (
          <span style={{ display: 'inline-flex', gap: '.3rem', alignItems: 'center', marginInlineStart: '.5rem' }}>
            <input className="form-input" style={{ width: 78 }} type="number" step="0.5"
              placeholder={t('products.start_size')} value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)} />
            <span>–</span>
            <input className="form-input" style={{ width: 78 }} type="number" step="0.5"
              placeholder={t('products.end_size')} value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={applyRange}>
              {t('products.generate_preview')}
            </button>
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ margin: 0, width: 'auto' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'start' }}>{hasColors ? t('products.colors') : ''}</th>
              {sizeValues.map((v) => (
                <th key={String(v)} style={{ textAlign: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => setMany(colors.map((c) => [c.id, v]), !colFull(v))}>
                  {labelFor(v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {colors.map((c) => (
              <tr key={c.id}>
                <td style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}
                  onClick={() => setMany(sizeValues.map((v) => [c.id, v]), !rowFull(c.id))}>
                  {c.is_placeholder || !hasColors ? (
                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('products.no_colors_product')}</span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {c.hex_code && (
                        <span className="color-swatch-sm"
                          style={{ backgroundColor: c.hex_code, width: 14, height: 14, borderRadius: '50%', border: '1px solid var(--color-border)' }} />
                      )}
                      {c.color_name}
                    </span>
                  )}
                </td>
                {sizeValues.map((v) => {
                  const isThere = cellExists(c.id, v);
                  const isSel = selected.has(keyOf(c.id, v));
                  const state = isThere ? 'exists' : isSel ? 'selected' : 'empty';
                  return (
                    <td key={String(v)} style={{ padding: 3 }}>
                      <div
                        data-testid={'cell-' + c.id + '-' + (v === null ? 'one' : v)}
                        data-state={state}
                        style={cellStyle(state)}
                        onClick={() => toggle(c.id, v)}
                      >
                        {isThere ? '✓' : isSel ? '+' : ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: 'var(--spacing-md)' }}>
        <span style={{ alignSelf: 'center', color: 'var(--color-text-secondary)' }}>
          {t('products.selected_count', { count })}
        </span>
        <button type="button" className="btn btn-primary" disabled={count === 0 || creating}
          data-testid="matrix-create" onClick={handleCreate}>
          {creating ? t('common.loading') : t('products.create_variants', { count })}
        </button>
      </div>
    </div>
  );
}
