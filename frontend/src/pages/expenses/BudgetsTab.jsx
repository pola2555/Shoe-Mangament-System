import { useState, useEffect, useCallback } from 'react';
import { expensesAPI } from '../../api';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import { catPath, monthInput, money } from './expenseHelpers';

/**
 * A monthly limit per category, and what was actually spent against it.
 *
 * Every active category appears whether or not it is budgeted. A category quietly
 * overspent with no budget set is exactly what a shop needs to see, so "no budget" is
 * shown as a row with a dash rather than as a missing line.
 *
 * A budget belongs to one store. Editing is inline: typing a number and leaving the
 * field saves it, and clearing it to 0 removes the budget entirely.
 */
export default function BudgetsTab({ stores, canSetup }) {
  const { t, locale } = useTranslation();
  const [month, setMonth] = useState(() => monthInput(new Date().toISOString()));
  const [storeId, setStoreId] = useState(stores[0]?.id || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});

  const load = useCallback(async () => {
    if (!storeId) { setLoading(false); return; }
    try {
      setLoading(true);
      const { data: res } = await expensesAPI.budgets({ store_id: storeId, period_month: `${month}-01` });
      setData(res.data);
      setDraft({});
    } catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  }, [storeId, month]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!storeId && stores.length) setStoreId(stores[0].id); }, [stores]);

  const save = async (categoryId, value) => {
    const amount = value === '' ? 0 : parseFloat(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    try {
      await expensesAPI.setBudget({
        store_id: storeId, category_id: categoryId,
        period_month: `${month}-01`, amount,
      });
      toast.success(t('budget.saved'));
      await load();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const currency = t('common.currency');
  const totals = data?.totals || { budget: 0, actual: 0 };
  const totalVariance = totals.budget - totals.actual;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 'var(--spacing-md)', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>{t('budget.title')}</h3>
          <p style={{ color: 'var(--color-text-secondary)', margin: '.25rem 0 0', fontSize: 'var(--font-size-sm)' }}>
            {t('budget.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 170 }}>
            <label className="form-label">{t('common.store')}</label>
            <SearchableSelect options={stores.map((s) => ({ value: s.id, label: s.name }))}
              value={storeId} onChange={(e) => setStoreId(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t('budget.month')}</label>
            <input className="form-input" type="month" value={month} data-testid="budget-month"
              onChange={(e) => setMonth(e.target.value)} />
          </div>
        </div>
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : !data ? null : (
        <div className="table-container">
          <table className="table" data-testid="budget-table">
            <thead>
              <tr>
                <th>{t('expenses.category')}</th>
                <th style={{ textAlign: 'end' }}>{t('budget.budget')}</th>
                <th style={{ textAlign: 'end' }}>{t('budget.actual')}</th>
                <th style={{ textAlign: 'end' }}>{t('budget.variance')}</th>
                <th style={{ width: 140 }}>{t('budget.used')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const over = r.budget > 0 && r.actual > r.budget;
                const pct = r.used_pct;
                return (
                  <tr key={r.category_id} data-testid={`budget-row-${r.category_id}`}>
                    <td style={{ paddingInlineStart: r.parent_id ? '2.2rem' : undefined }}>
                      {r.parent_id && <span style={{ color: 'var(--color-text-muted)' }}>› </span>}
                      {catPath({ ...r, name: r.name_en }, locale)}
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {canSetup ? (
                        <input
                          className="form-input"
                          type="number" step="0.01" min="0"
                          style={{ width: 120, textAlign: 'end', display: 'inline-block' }}
                          data-testid={`budget-input-${r.category_id}`}
                          value={draft[r.category_id] ?? (r.budget || '')}
                          placeholder="—"
                          onChange={(e) => setDraft({ ...draft, [r.category_id]: e.target.value })}
                          // Saving on blur rather than on every keystroke: one request
                          // per edit, and the number is whole by the time it is sent.
                          onBlur={(e) => {
                            const next = e.target.value;
                            if (String(r.budget || '') === next) return;
                            save(r.category_id, next);
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        />
                      ) : (r.budget ? money(r.budget, currency) : '—')}
                    </td>
                    <td style={{ textAlign: 'end' }}>{money(r.actual, currency)}</td>
                    <td style={{ textAlign: 'end', color: over ? 'var(--color-danger)' : undefined, fontWeight: over ? 700 : undefined }}>
                      {r.budget === 0 ? '—' : over
                        ? `${t('budget.over')} ${money(Math.abs(r.variance), currency)}`
                        : money(r.variance, currency)}
                    </td>
                    <td>
                      {pct === null ? <span style={{ color: 'var(--color-text-muted)' }}>{t('budget.no_budget')}</span> : (
                        <div title={`${pct}%`} style={{ background: 'var(--color-bg-secondary)', borderRadius: 999, height: 8, overflow: 'hidden' }}>
                          <div style={{
                            width: `${Math.min(100, pct)}%`,
                            height: '100%',
                            background: over ? 'var(--color-danger)' : pct > 80 ? 'var(--color-warning, #eab308)' : 'var(--color-success)',
                          }} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {data.uncategorised > 0 && (
                <tr>
                  <td style={{ color: 'var(--color-text-muted)' }}>{t('budget.uncategorised_note')}</td>
                  <td style={{ textAlign: 'end' }}>—</td>
                  <td style={{ textAlign: 'end' }}>{money(data.uncategorised, currency)}</td>
                  <td style={{ textAlign: 'end' }}>—</td>
                  <td></td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>{t('budget.totals')}</td>
                <td style={{ textAlign: 'end' }}>{money(totals.budget, currency)}</td>
                <td style={{ textAlign: 'end' }} data-testid="budget-total-actual">{money(totals.actual, currency)}</td>
                <td style={{ textAlign: 'end', color: totalVariance < 0 ? 'var(--color-danger)' : undefined }}>
                  {totalVariance < 0
                    ? `${t('budget.over')} ${money(Math.abs(totalVariance), currency)}`
                    : money(totalVariance, currency)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
