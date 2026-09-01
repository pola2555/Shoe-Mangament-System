import { useState, useEffect } from 'react';
import { expensesAPI } from '../../api';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import { categoryOptions, catName, PAYMENT_METHODS, today, dateInput, money } from './expenseHelpers';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];

/**
 * Costs that come round again — rent, salaries, the internet bill.
 *
 * Nothing posts by itself. There is no scheduler in this deployment, and a background
 * job that silently books rent every month is worse than a list of what is waiting:
 * someone has to have decided the money actually went out. So this shows what is due
 * and posts it on a click.
 *
 * The schedule advances from the date that WAS due, not from today, so a template
 * posted three weeks late still lands on the right day next month.
 */
export default function RecurringTab({ categories, stores, canWrite, canSetup, onPosted }) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const { data } = await expensesAPI.listRecurring();
      setRows(data.data || []);
    } catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const blank = () => ({
    store_id: stores.length === 1 ? stores[0].id : '',
    category_id: '',
    amount: '',
    description: '',
    payment_method: 'cash',
    paid_to: '',
    frequency: 'monthly',
    next_date: today(),
    end_date: '',
  });

  const save = async () => {
    if (!editing.store_id || !editing.category_id || !editing.amount) {
      return toast.error(t('common.error'));
    }
    try {
      setSaving(true);
      const payload = {
        ...editing,
        amount: parseFloat(editing.amount),
        category_id: Number(editing.category_id),
        end_date: editing.end_date || null,
        paid_to: editing.paid_to || null,
      };
      delete payload.id;
      delete payload.is_due;
      if (editing.id) await expensesAPI.updateRecurring(editing.id, payload);
      else await expensesAPI.createRecurring(payload);
      toast.success(t('expenses.saved'));
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSaving(false); }
  };

  const post = async (row) => {
    const label = row.description || catName({ name_en: row.category_name_en, name_ar: row.category_name_ar }, locale);
    if (!confirm(t('recurring.confirm_post', { amount: money(row.amount, t('common.currency')), desc: label }))) return;
    try {
      setBusyId(row.id);
      await expensesAPI.postRecurring(row.id);
      toast.success(t('recurring.posted'));
      await load();
      onPosted?.();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setBusyId(null); }
  };

  const togglePause = async (row) => {
    try {
      await expensesAPI.updateRecurring(row.id, { is_active: !row.is_active });
      await load();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const remove = async (row) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try {
      await expensesAPI.deleteRecurring(row.id);
      toast.success(t('common.deleted'));
      await load();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const dueCount = rows.filter((r) => r.is_due && r.is_active).length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 'var(--spacing-md)', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>{t('recurring.title')}</h3>
          <p style={{ color: 'var(--color-text-secondary)', margin: '.25rem 0 0', fontSize: 'var(--font-size-sm)', maxWidth: 640 }}>
            {t('recurring.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {dueCount > 0 && (
            <span className="badge badge-warning" data-testid="recurring-due-count">
              {t('recurring.due_count', { n: dueCount })}
            </span>
          )}
          {canSetup && !editing && (
            <button className="btn btn-primary btn-sm" data-testid="add-recurring"
              onClick={() => setEditing(blank())}>+ {t('recurring.add')}</button>
          )}
        </div>
      </div>

      {editing && (
        <div className="card" style={{ marginBottom: 'var(--spacing-md)', background: 'var(--color-bg-secondary)' }}>
          <h4 style={{ marginTop: 0 }}>{editing.id ? t('recurring.edit') : t('recurring.add')}</h4>
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('common.store')} *</label>
              <SearchableSelect
                options={[{ value: '', label: t('common.select') }, ...stores.map((s) => ({ value: s.id, label: s.name }))]}
                value={editing.store_id} onChange={(e) => setEditing({ ...editing, store_id: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('expenses.category')} *</label>
              <SearchableSelect
                options={categoryOptions(categories, locale, { includeBlank: true, blankLabel: t('common.select') })}
                value={String(editing.category_id || '')}
                onChange={(e) => setEditing({ ...editing, category_id: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('expenses.amount')} *</label>
              <input className="form-input" type="number" step="0.01" min="0.01" data-testid="recurring-amount"
                value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('recurring.frequency')} *</label>
              <SearchableSelect options={FREQUENCIES.map((f) => ({ value: f, label: t(`recurring.${f}`) }))}
                value={editing.frequency} onChange={(e) => setEditing({ ...editing, frequency: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('recurring.next_date')} *</label>
              <input className="form-input" type="date" data-testid="recurring-next-date"
                value={dateInput(editing.next_date)} onChange={(e) => setEditing({ ...editing, next_date: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('recurring.end_date')}</label>
              <input className="form-input" type="date" value={dateInput(editing.end_date)}
                onChange={(e) => setEditing({ ...editing, end_date: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('expenses.payment_method')}</label>
              <SearchableSelect options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`payment_methods.${m}`) }))}
                value={editing.payment_method || 'cash'}
                onChange={(e) => setEditing({ ...editing, payment_method: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('expenses.paid_to')}</label>
              <input className="form-input" value={editing.paid_to || ''}
                onChange={(e) => setEditing({ ...editing, paid_to: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">{t('expenses.description')}</label>
            <input className="form-input" value={editing.description || ''} data-testid="recurring-description"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="e.g. Shop rent" />
          </div>
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={saving} data-testid="recurring-save" onClick={save}>
              {saving ? '…' : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>{t('expenses.description')}</th>
                <th>{t('expenses.category')}</th>
                <th>{t('common.store')}</th>
                <th>{t('recurring.frequency')}</th>
                <th>{t('recurring.next_date')}</th>
                <th>{t('expenses.amount')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('recurring.none')}</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} data-testid={`recurring-row-${r.id}`} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                  <td>
                    <strong>{r.description || '—'}</strong>
                    {!r.is_active && <span className="badge badge-neutral" style={{ marginInlineStart: 8 }}>{t('recurring.paused')}</span>}
                  </td>
                  <td>{catName({ name_en: r.category_name_en, name_ar: r.category_name_ar }, locale)}</td>
                  <td>{r.store_name}</td>
                  <td>{t(`recurring.${r.frequency}`)}</td>
                  <td>
                    {dateInput(r.next_date)}
                    {r.is_due && r.is_active && (
                      <span className="badge badge-warning" style={{ marginInlineStart: 8 }}>{t('recurring.due_now')}</span>
                    )}
                  </td>
                  <td><strong>{money(r.amount, t('common.currency'))}</strong></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canWrite && r.is_active && r.is_due && (
                      <button className="btn btn-sm btn-primary" data-testid={`post-recurring-${r.id}`}
                        disabled={busyId === r.id} onClick={() => post(r)}>
                        {busyId === r.id ? '…' : t('recurring.post')}
                      </button>
                    )}
                    {canSetup && (
                      <>
                        <button className="btn btn-sm btn-secondary" style={{ marginInlineStart: 6 }}
                          onClick={() => setEditing({ ...r, category_id: String(r.category_id) })}>{t('common.edit')}</button>
                        <button className="btn btn-sm btn-secondary" style={{ marginInlineStart: 6 }}
                          onClick={() => togglePause(r)}>
                          {r.is_active ? t('recurring.pause') : t('recurring.resume')}
                        </button>
                        <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }}
                          onClick={() => remove(r)}>✕</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
