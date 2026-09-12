import { useState } from 'react';
import SearchableSelect from '../common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import { sizeValueLabel } from '../../utils/variantFormat';

/**
 * Adding a run of sizes at once, in whatever shape the category's size list takes.
 *
 * The purchase box had a "smart generator" that was `for (s = start; s <= end; s++)` —
 * so it could only ever produce whole numbers. Half sizes were impossible and Kids /
 * Teens / Adults could not be generated at all, which is why receiving socks meant
 * typing every row by hand.
 *
 *   numeric list (shoes, belts)  a from/to range, as before, plus the quantity
 *   word list (socks, clothing)  the list's own values as chips, tap what came in
 *   no sizes (bags, tools)       nothing to pick; the caller hides this entirely
 *
 * Emits `[{ size_eu, quantity }]` and lets the caller decide what to do with it, so the
 * box editor and the template editor can both use it without agreeing on anything else.
 */
export default function SizeRunPicker({
  colors = [],
  colorId,
  onColorChange,
  hasColors = true,
  sizeValues = [],
  isNumeric = true,
  locale,
  onGenerate,
}) {
  const { t } = useTranslation();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [qty, setQty] = useState('1');
  const [picked, setPicked] = useState([]);

  const quantity = Math.max(1, parseInt(qty, 10) || 1);

  const emitRange = () => {
    const from = parseFloat(start);
    const to = parseFloat(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return;

    // Step by the list's own spacing when there is one, so a shoe list that runs in
    // half sizes generates half sizes instead of skipping them. Falls back to whole
    // numbers for a product with no category.
    const numeric = sizeValues
      .map((v) => parseFloat(v.value))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const step = numeric.length > 1
      ? Math.min(...numeric.slice(1).map((n, i) => n - numeric[i])) || 1
      : 1;

    const out = [];
    if (numeric.length) {
      for (const n of numeric) {
        if (n >= from && n <= to) {
          const def = sizeValues.find((v) => parseFloat(v.value) === n);
          out.push({ size_eu: def.value, quantity: String(quantity) });
        }
      }
    } else {
      for (let s = from; s <= to + 1e-9; s = Math.round((s + step) * 100) / 100) {
        out.push({ size_eu: String(s), quantity: String(quantity) });
      }
    }
    if (out.length) onGenerate(out);
  };

  const emitPicked = () => {
    if (!picked.length) return;
    // Emitted in list order, not tap order, so the rows land the way they read.
    const ordered = sizeValues.filter((v) => picked.includes(v.value));
    onGenerate(ordered.map((v) => ({ size_eu: v.value, quantity: String(quantity) })));
    setPicked([]);
  };

  const toggle = (v) =>
    setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <div style={{
      marginBottom: 'var(--spacing-md)', padding: 'var(--spacing-md)',
      backgroundColor: 'var(--color-bg-base)', borderRadius: 8,
      border: '1px solid var(--color-primary)',
    }} data-testid="size-run-picker">
      <h4 style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-primary)' }}>
        ⚡ {t('products.smart_generator')}
      </h4>

      <div className="form-row" style={{ alignItems: 'flex-end', marginBottom: 0, flexWrap: 'wrap' }}>
        {hasColors && (
          <div className="form-group" style={{ flex: '1 1 180px', margin: 0 }}>
            <label className="form-label">{t('products.color_name')}</label>
            <SearchableSelect
              options={[
                { value: '', label: t('common.select') },
                ...colors.map((c) => ({ value: c.id, label: c.color_name })),
              ]}
              value={colorId || ''}
              onChange={(e) => onColorChange(e.target.value)}
            />
          </div>
        )}

        {isNumeric ? (
          <>
            <div className="form-group" style={{ flex: '1 1 90px', margin: 0 }}>
              <label className="form-label">{t('products.start_size')}</label>
              <input className="form-input" type="number" step="any" value={start}
                data-testid="run-start" onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="form-group" style={{ flex: '1 1 90px', margin: 0 }}>
              <label className="form-label">{t('products.end_size')}</label>
              <input className="form-input" type="number" step="any" value={end}
                data-testid="run-end" onChange={(e) => setEnd(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="form-group" style={{ flex: '2 1 240px', margin: 0 }}>
            <label className="form-label">{t('products.size_generic')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }} data-testid="run-chips">
              {sizeValues.map((v) => (
                <button key={v.id || v.value} type="button"
                  className={`btn btn-sm ${picked.includes(v.value) ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '.25rem .6rem' }}
                  onClick={() => toggle(v.value)}>
                  {sizeValueLabel(v, locale)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="form-group" style={{ flex: '1 1 90px', margin: 0 }}>
          <label className="form-label">{t('common.quantity')}</label>
          <input className="form-input" type="number" min="1" value={qty}
            data-testid="run-qty" onChange={(e) => setQty(e.target.value)} />
        </div>

        <button type="button" className="btn btn-primary" data-testid="run-generate"
          onClick={isNumeric ? emitRange : emitPicked}>
          {t('products.generate_preview')}
        </button>
      </div>
    </div>
  );
}
