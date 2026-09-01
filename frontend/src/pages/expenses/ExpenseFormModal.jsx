import { useState, useEffect, useRef } from 'react';
import { expensesAPI } from '../../api';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import ClickableImage from '../../components/common/ClickableImage';
import { useTranslation } from '../../i18n/i18nContext';
import { categoryOptions, PAYMENT_METHODS, today, dateInput } from './expenseHelpers';

/**
 * Adding or editing one expense, with its receipts.
 *
 * Editing did not exist. The API has always had PUT /expenses/:id, but the page only
 * offered ✕ — so correcting a typo meant destroying the record and its audit trail and
 * typing it again.
 *
 * Receipts can only be attached to an expense that already exists, because they hang
 * off its id. On a new expense the upload appears after the first save rather than
 * being disabled with no explanation.
 */
export default function ExpenseFormModal({ expense, categories, stores, onClose, onSaved }) {
  const { t, locale } = useTranslation();
  const isEdit = Boolean(expense?.id);
  const fileRef = useRef(null);

  const [form, setForm] = useState({
    store_id: expense?.store_id || (stores.length === 1 ? stores[0].id : ''),
    category_id: expense?.category_id ? String(expense.category_id) : '',
    amount: expense?.amount ?? '',
    description: expense?.description || '',
    expense_date: dateInput(expense?.expense_date) || today(),
    payment_method: expense?.payment_method || 'cash',
    paid_to: expense?.paid_to || '',
  });
  const [saving, setSaving] = useState(false);
  const [receipts, setReceipts] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    expensesAPI.listReceipts(expense.id)
      .then((r) => setReceipts(r.data.data || []))
      .catch(() => { /* the form still works without them */ });
  }, [isEdit, expense?.id]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.store_id) return toast.error(t('common.store'));
    try {
      setSaving(true);
      const payload = {
        ...form,
        amount: parseFloat(form.amount),
        // '' would fail uuid/int validation; null is what "no category" means.
        category_id: form.category_id ? Number(form.category_id) : null,
        paid_to: form.paid_to || null,
      };
      if (isEdit) {
        await expensesAPI.update(expense.id, payload);
        toast.success(t('expenses.saved'));
      } else {
        await expensesAPI.create(payload);
        toast.success(t('expenses.saved'));
      }
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSaving(false); }
  };

  const upload = async (file) => {
    if (!file) return;
    try {
      setUploading(true);
      const fd = new FormData();
      fd.append('image', file);
      const { data } = await expensesAPI.uploadReceipt(expense.id, fd);
      setReceipts((prev) => [...prev, data.data]);
      toast.success(t('expenses.receipt_added'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeReceipt = async (imageId) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try {
      await expensesAPI.deleteReceipt(expense.id, imageId);
      setReceipts((prev) => prev.filter((r) => r.id !== imageId));
      toast.success(t('expenses.receipt_deleted'));
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 620, maxHeight: '88vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()} data-testid="expense-form">
        <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>
          {isEdit ? t('expenses.edit_expense') : t('expenses.add_expense')}
        </h2>

        <form onSubmit={submit} className="product-form">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('common.store')} *</label>
              <SearchableSelect
                options={[{ value: '', label: t('common.select') }, ...stores.map((s) => ({ value: s.id, label: s.name }))]}
                value={form.store_id}
                onChange={(e) => setForm({ ...form, store_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('expenses.category')}</label>
              <SearchableSelect
                options={categoryOptions(categories, locale, { includeBlank: true, blankLabel: t('expenses.no_category') })}
                value={form.category_id}
                onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('expenses.amount')} ({t('common.currency')}) *</label>
              <input className="form-input" type="number" step="0.01" min="0.01" required
                data-testid="expense-amount" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('expenses.expense_date')} *</label>
              <input className="form-input" type="date" required value={form.expense_date}
                onChange={(e) => setForm({ ...form, expense_date: e.target.value })} />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('expenses.payment_method')}</label>
              <SearchableSelect
                options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`payment_methods.${m}`) }))}
                value={form.payment_method}
                onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('expenses.paid_to')}</label>
              <input className="form-input" value={form.paid_to} data-testid="expense-paid-to"
                onChange={(e) => setForm({ ...form, paid_to: e.target.value })} placeholder="e.g. Ahmed / Electricity Co." />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('expenses.description')}</label>
            <input className="form-input" value={form.description} data-testid="expense-description"
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>

          {/* Receipts need the expense to exist, so they appear only once it does. */}
          {isEdit && (
            <div className="form-group">
              <label className="form-label">{t('expenses.receipts')}</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {receipts.map((r) => (
                  <div key={r.id} style={{ position: 'relative' }}>
                    <ClickableImage src={r.image_url} thumbSrc={r.thumb_url} alt={r.original_name || 'receipt'}
                      title={r.original_name} width={64} height={64}
                      style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }} />
                    <button type="button" className="btn btn-sm btn-danger"
                      style={{ position: 'absolute', top: -6, insetInlineEnd: -6, padding: '0 5px', lineHeight: 1.4 }}
                      onClick={() => removeReceipt(r.id)}>✕</button>
                  </div>
                ))}
                {receipts.length === 0 && (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
                    {t('expenses.no_receipts')}
                  </span>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" capture="environment"
                data-testid="expense-receipt-input" style={{ marginTop: 8 }}
                disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving} data-testid="expense-save">
              {saving ? '…' : isEdit ? t('common.update') : t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
