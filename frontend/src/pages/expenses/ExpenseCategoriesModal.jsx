import { useState, useEffect } from 'react';
import { expensesAPI } from '../../api';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import { catName } from './expenseHelpers';

/**
 * Managing the expense category list.
 *
 * There was no way to do this at all: `expense_categories` was six rows seeded once,
 * with no endpoint to add a seventh, so every shop filed everything under Rent,
 * Salaries, Maintenance, Utilities, Supplies or Other.
 *
 * Retiring is offered before deleting. A category that has been used names what real
 * money was for, and deleting it would either take that spending with it or leave it
 * uncategorised — so the server refuses, and this says so before the user tries.
 */
export default function ExpenseCategoriesModal({ onClose, onChanged, canWrite }) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const { data } = await expensesAPI.getCategories({ include_counts: true });
      setRows(data.data || []);
    } catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing.name?.trim()) return toast.error(t('expcat.name_en'));
    try {
      setSaving(true);
      const payload = {
        name: editing.name.trim(),
        name_ar: editing.name_ar?.trim() || null,
        parent_id: editing.parent_id ? Number(editing.parent_id) : null,
        sort_order: Number(editing.sort_order) || 0,
      };
      if (editing.id) await expensesAPI.updateCategory(editing.id, payload);
      else await expensesAPI.createCategory(payload);
      toast.success(t('expcat.saved'));
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSaving(false); }
  };

  const toggle = async (row) => {
    try {
      await expensesAPI.toggleCategoryActive(row.id);
      await load();
      onChanged?.();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const remove = async (row) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try {
      await expensesAPI.deleteCategory(row.id);
      toast.success(t('expcat.deleted'));
      await load();
      onChanged?.();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  // Only a top-level category can be a parent — the server enforces two levels, and
  // offering a third here would just produce an error message.
  const parentOptions = [
    { value: '', label: t('expcat.top_level') },
    ...rows.filter((r) => !r.parent_id && r.id !== editing?.id).map((r) => ({
      value: String(r.id), label: catName(r, locale),
    })),
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 720, maxHeight: '86vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()} data-testid="expense-categories-modal">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>{t('expcat.title')}</h2>
            <p style={{ color: 'var(--color-text-secondary)', margin: '.25rem 0 0', fontSize: 'var(--font-size-sm)' }}>
              {t('expcat.subtitle')}
            </p>
          </div>
          {canWrite && !editing && (
            <button className="btn btn-primary btn-sm" data-testid="add-expense-category"
              onClick={() => setEditing({ name: '', name_ar: '', parent_id: '', sort_order: (rows.length + 1) * 10 })}>
              + {t('expcat.add')}
            </button>
          )}
        </div>

        {editing && (
          <div className="card" style={{ marginTop: 'var(--spacing-md)', background: 'var(--color-bg-secondary)' }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? t('expcat.edit') : t('expcat.add')}</h3>
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t('expcat.name_en')} *</label>
                <input className="form-input" data-testid="expcat-name" value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Electricity" />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t('expcat.name_ar')}</label>
                <input className="form-input" data-testid="expcat-name-ar" value={editing.name_ar || ''} dir="rtl"
                  onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label className="form-label">{t('expcat.parent')}</label>
                <SearchableSelect options={parentOptions} value={String(editing.parent_id || '')}
                  onChange={(e) => setEditing({ ...editing, parent_id: e.target.value })} />
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('expcat.two_levels_note')}</small>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t('expcat.sort_order')}</label>
                <input className="form-input" type="number" value={editing.sort_order ?? 0}
                  onChange={(e) => setEditing({ ...editing, sort_order: e.target.value })} />
              </div>
            </div>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={saving} data-testid="expcat-save" onClick={save}>
                {saving ? '…' : t('common.save')}
              </button>
            </div>
          </div>
        )}

        {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
          <div className="table-container" style={{ marginTop: 'var(--spacing-md)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('expcat.name_en')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('expenses.title')}</th>
                  {canWrite && <th></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`expcat-row-${r.id}`}
                    style={{ opacity: r.is_active ? 1 : 0.55 }}>
                    <td style={{ paddingInlineStart: r.parent_id ? '2.2rem' : undefined }}>
                      {r.parent_id && <span style={{ color: 'var(--color-text-muted)' }}>› </span>}
                      <strong>{catName(r, locale)}</strong>
                      {r.name_ar && locale !== 'ar' && (
                        <span style={{ color: 'var(--color-text-muted)', marginInlineStart: 8 }} dir="rtl">{r.name_ar}</span>
                      )}
                      {r.child_count > 0 && (
                        <span className="badge badge-neutral" style={{ marginInlineStart: 8 }}>
                          {t('expcat.sub_count', { n: r.child_count })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${r.is_active ? 'badge-success' : 'badge-neutral'}`}>
                        {r.is_active ? t('expcat.active') : t('expcat.inactive')}
                      </span>
                    </td>
                    <td>{t('expcat.in_use', { n: r.expense_count || 0 })}</td>
                    {canWrite && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm btn-secondary"
                          onClick={() => setEditing({
                            id: r.id, name: r.name_en || r.name, name_ar: r.name_ar || '',
                            parent_id: r.parent_id || '', sort_order: r.sort_order,
                          })}>{t('common.edit')}</button>
                        <button className="btn btn-sm btn-secondary" style={{ marginInlineStart: 6 }}
                          onClick={() => toggle(r)}>
                          {r.is_active ? t('expcat.retire') : t('expcat.restore')}
                        </button>
                        {/* Deleting is offered only when nothing references it; the
                            server refuses otherwise, and saying so up front is kinder
                            than an error after the click. */}
                        {r.expense_count === 0 && r.child_count === 0 ? (
                          <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }}
                            onClick={() => remove(r)}>✕</button>
                        ) : (
                          <span style={{ marginInlineStart: 6, fontSize: '.75rem', color: 'var(--color-text-muted)' }}>
                            {t('expcat.cannot_delete')}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
