import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from '../../i18n/i18nContext';
import './DenominationCounter.css';

/**
 * COUNTING THE DRAWER, THE WAY IT IS ACTUALLY COUNTED.
 *
 * A cash-up asked for one number: the total in the drawer. Nobody arrives at that
 * number in one step — they count the 200s, then the 100s, then the coins, add it up in
 * their head or on a phone, and type the answer. Every one of those is a place to make
 * a mistake, and the mistake surfaces as a drawer that does not balance, which is
 * indistinguishable from money actually being missing.
 *
 * So the counting happens here instead. Enter how many of each note, and the total is
 * arithmetic rather than mental arithmetic. That is also why the owner asked to be able
 * to re-enter a count: the old flow made miscounts easy and then made them permanent.
 *
 * Typing a total directly still works, and is the default — a quick close at the end of
 * a quiet day should not require twelve boxes. This is the other way in, not a
 * replacement.
 *
 * Egyptian notes and coins. Extending this is a matter of editing one array.
 */

const DENOMINATIONS = [200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];

export default function DenominationCounter({ value, onChange }) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState({});

  const total = useMemo(
    () => Math.round(
      DENOMINATIONS.reduce((sum, d) => sum + d * (Number(counts[d]) || 0), 0) * 100
    ) / 100,
    [counts]
  );

  // Push the running total up as it changes. The parent owns the value, so the person
  // can still overwrite it by typing in the total box — this only ever proposes.
  useEffect(() => {
    if (Object.keys(counts).length > 0) onChange(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const set = (d, raw) => {
    const n = raw === '' ? '' : Math.max(0, Math.floor(Number(raw) || 0));
    setCounts((prev) => ({ ...prev, [d]: n }));
  };

  return (
    <div className="denoms" data-testid="denominations">
      <div className="denoms__grid">
        {DENOMINATIONS.map((d) => {
          const n = counts[d];
          const line = Math.round(d * (Number(n) || 0) * 100) / 100;
          return (
            <label key={d} className="denoms__row">
              <span className="denoms__face">{d >= 1 ? d : `${d * 100}pt`}</span>
              <span className="denoms__times">×</span>
              <input
                type="number" min="0" step="1" className="form-input denoms__input"
                data-testid={`denom-${String(d).replace('.', '_')}`}
                value={n ?? ''}
                onChange={(e) => set(d, e.target.value)}
                placeholder="0"
              />
              {/* The running line total. Seeing "10 × 200 = 2000" is where a slipped
                  digit gets noticed, which is the whole point of counting this way. */}
              <span className={`denoms__line${line ? '' : ' is-zero'}`}>
                {line ? line.toLocaleString() : ''}
              </span>
            </label>
          );
        })}
      </div>

      <div className="denoms__total" data-testid="denom-total">
        <span>{t('shifts.counted_total')}</span>
        <strong>{total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
      </div>

      {Object.keys(counts).length > 0 && (
        <button type="button" className="btn btn-sm btn-secondary" data-testid="denom-clear"
          onClick={() => { setCounts({}); onChange(''); }}>
          {t('common.clear')}
        </button>
      )}
    </div>
  );
}
