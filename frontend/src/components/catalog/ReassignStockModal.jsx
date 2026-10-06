import { useState } from 'react';
import toast from 'react-hot-toast';
import { inventoryAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import useProductCategory from '../../hooks/useProductCategory';
import SearchableSelect from '../common/SearchableSelect';
import SizeValueInput from './SizeValueInput';
import ColorThumb from './ColorThumb';

/**
 * Correcting the colour or size that stock was booked under.
 *
 * Stock gets entered wrong — a box of Navy booked in as Black, a size run typed one
 * row out. The only remedies used to be writing it off and re-entering it, which loses
 * the cost and the history, or leaving it wrong. This moves the physical pairs onto
 * the right variant and keeps everything else about them.
 *
 * Two things this screen has to say out loud, because neither is recoverable from the
 * result on its own:
 *
 *   - only pairs IN STOCK move. A sold pair's sale line photocopied its cost, so
 *     moving it would restate what was sold. The count shown is the movable count.
 *   - every moved pair is still wearing a label for what it used to be. The barcode
 *     encodes colour and size, so until it is relabelled it scans as the old variant.
 *     Offered as a reprint the moment the move succeeds.
 */
export default function ReassignStockModal({ row, onClose, onDone, onPrintLabels }) {
  const { t, locale } = useTranslation();
  const cat = useProductCategory(row?.product_id || null);

  const [colorId, setColorId] = useState(row?.product_color_id || '');
  const [size, setSize] = useState(row?.size_eu || '');
  const [qty, setQty] = useState(String(row?.quantity ?? ''));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (!row) return null;

  const available = Number(row.quantity) || 0;
  const changed = (colorId && colorId !== row.product_color_id)
    || (size && String(size) !== String(row.size_eu));

  const submit = async (e) => {
    e.preventDefault();
    if (!changed) { toast.error(t('inventory.reassign_nothing_changed')); return; }
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n < 1 || n > available) {
      toast.error(t('inventory.reassign_bad_quantity', { max: available }));
      return;
    }
    try {
      setSaving(true);
      const body = {
        variant_id: row.variant_id,
        store_id: row.store_id,
        quantity: n,
        reason: reason || null,
      };
      if (colorId && colorId !== row.product_color_id) body.product_color_id = colorId;
      if (size && String(size) !== String(row.size_eu)) body.size_eu = String(size);

      const { data } = await inventoryAPI.reassign(body);
      const res = data.data;
      toast.success(t('inventory.reassign_done', { count: res.moved, color: res.to.color_name }));
      onDone?.(res);

      // The labels on those pairs are now wrong. Offered rather than done silently:
      // whoever moved the stock knows whether the box is still in front of them.
      onPrintLabels?.(res);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally { setSaving(false); }
  };

  const colorOptions = [
    { value: '', label: `${t('products.color_name')}...` },
    ...(cat.colors || []).map((c) => ({ value: c.id, label: c.color_name, color: c })),
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--spacing-xs)' }}>{t('inventory.reassign_title')}</h2>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)', fontSize: '0.9em' }}>
          {row.product_name} · {row.sku} · {row.store_name}
        </p>

        <form onSubmit={submit} className="product-form">
          {cat.hasColors && (
            <div className="form-group">
              <label className="form-label">{t('products.color_name')}</label>
              <div className="color-pick">
                <div className="color-pick__select">
                  <SearchableSelect
                    options={colorOptions}
                    value={colorId}
                    onChange={(e) => setColorId(e.target.value)}
                    formatOptionLabel={(opt) => (
                      <span className="color-option">
                        {opt.color && <ColorThumb color={opt.color} size="sm" />}
                        <span className="color-option__name">{opt.label}</span>
                      </span>
                    )}
                  />
                </div>
                {colorId && (
                  <ColorThumb size="lg" zoomable color={(cat.colors || []).find((c) => c.id === colorId)} />
                )}
              </div>
            </div>
          )}

          {cat.hasSizes && (
            <div className="form-group">
              <label className="form-label">{t('products.size_generic')}</label>
              {/* The category's own size list, so a sock offers Kids/Teens/Adults and a
                  belt offers centimetres — the same control the box editor uses. */}
              <SizeValueInput
                value={size}
                onChange={setSize}
                sizeValues={cat.sizeValues}
                locale={locale}
                data-testid="reassign-size"
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">
              {t('inventory.reassign_how_many', { max: available })}
            </label>
            <input className="form-input" type="number" min="1" max={available} required
              data-testid="reassign-quantity"
              value={qty} onChange={(e) => setQty(e.target.value)} />
            {/* Said plainly: this count is what CAN move, not what exists. */}
            <div className="form-hint">{t('inventory.reassign_in_stock_only')}</div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('common.notes')}</label>
            <input className="form-input" value={reason} data-testid="reassign-reason"
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('inventory.reassign_reason_hint')} />
          </div>

          {/* The one consequence that leaves the screen and lands on a shelf. */}
          <div className="form-hint" data-testid="reassign-label-warning"
            style={{ color: 'var(--color-warning, var(--color-danger))', marginBottom: 'var(--spacing-sm)' }}>
            {t('inventory.reassign_label_warning')}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !changed}
              data-testid="reassign-save">
              {saving ? t('common.loading') : t('inventory.reassign_move')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
