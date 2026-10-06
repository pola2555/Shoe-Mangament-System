import { useState } from 'react';
import toast from 'react-hot-toast';
import { inventoryAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * Removing stock that should never have been recorded.
 *
 * Deliberately NOT the same thing as marking stock damaged or lost, and the dialog
 * says so. Damaged and lost mean "this pair existed and is gone", which is shrinkage
 * and belongs in the reports. This means "this pair never existed" — ten booked in
 * when five arrived, a quantity typed twice. Marking those damaged would report theft
 * that never happened.
 *
 * The rows are really deleted, so three things are made plain before anything
 * happens: that it cannot be undone, that the activity log is the only record left,
 * and that writing off is the other option if the pairs were real.
 *
 * A reason is required. It is the only thing the log will have to explain why a piece
 * of stock stopped existing.
 */
export default function RemoveStockModal({ row, onClose, onDone }) {
  const { t } = useTranslation();
  const available = Number(row?.quantity) || 0;

  const [qty, setQty] = useState(String(available));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (!row) return null;

  const n = parseInt(qty, 10);
  const valid = Number.isFinite(n) && n >= 1 && n <= available && reason.trim().length >= 3;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    try {
      setSaving(true);
      const { data } = await inventoryAPI.remove({
        variant_id: row.variant_id,
        store_id: row.store_id,
        quantity: n,
        reason: reason.trim(),
      });
      const res = data.data;
      toast.success(t('inventory.remove_done', { count: res.removed }));
      // Said afterwards rather than before, because it is only knowable once the
      // pairs are chosen: a purchase invoice records what was ordered and paid for,
      // and removing stock does not change it. Better said than left to be noticed
      // when the two no longer agree.
      if (res.from_purchase > 0) {
        toast(t('inventory.remove_invoice_note', { count: res.from_purchase }), { duration: 8000 });
      }
      onDone?.(res);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--spacing-xs)' }}>{t('inventory.remove_title')}</h2>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)', fontSize: '0.9em' }}>
          {row.product_name} · {row.sku} · {row.store_name}
        </p>

        <form onSubmit={submit} className="product-form">
          <div className="form-group">
            <label className="form-label">{t('inventory.remove_how_many', { max: available })}</label>
            <input className="form-input" type="number" min="1" max={available} required
              data-testid="remove-quantity"
              value={qty} onChange={(e) => setQty(e.target.value)} />
            <div className="form-hint">{t('inventory.remove_newest_first')}</div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.remove_reason')} *</label>
            <input className="form-input" required minLength={3} data-testid="remove-reason"
              value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={t('inventory.remove_reason_hint')} />
            <div className="form-hint">{t('inventory.remove_reason_why')}</div>
          </div>

          {/* The distinction the whole dialog turns on. */}
          <div data-testid="remove-warning" style={{
            border: '1px solid var(--color-danger)',
            background: 'rgba(var(--color-danger-rgb), 0.1)',
            color: 'var(--color-danger)',
            borderRadius: 'var(--radius-md, 8px)',
            padding: 'var(--spacing-sm)',
            fontSize: '0.85em',
            lineHeight: 1.45,
            marginBottom: 'var(--spacing-sm)',
          }}>
            {t('inventory.remove_warning')}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-danger" disabled={saving || !valid}
              data-testid="remove-save">
              {saving ? t('common.loading') : t('inventory.remove_confirm', { count: Number.isFinite(n) ? n : 0 })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
