import { useState } from 'react';
import toast from 'react-hot-toast';
import { inventoryAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import useProductCategory from '../../hooks/useProductCategory';
import SearchableSelect from '../common/SearchableSelect';
import SizeValueInput from './SizeValueInput';
import ColorThumb from './ColorThumb';

/**
 * Editing one row of stock: where it is booked, and how much of it there is.
 *
 * Stock gets entered wrong in two different ways and this screen now answers both.
 *
 *   WRONG VARIANT — a box of Navy booked in as Black, a size run typed one row out.
 *   The physical pairs move onto the right variant and keep their cost, their invoice
 *   box and their history. Only pairs IN STOCK move: a sold pair's sale line
 *   photocopied its cost, so moving it would restate what was sold.
 *
 *   WRONG COUNT — twelve entered as twenty-one. Nothing moves; the count is corrected
 *   where it stands. Fewer deletes the surplus, more creates the shortfall at the cost
 *   of the pairs already there.
 *
 * ONE QUANTITY BOX, TWO MEANINGS, and that is the whole risk in this screen. When the
 * colour or size has been changed it means "how many of them move"; when neither has,
 * it means "how many there should be". Rather than leave anyone to infer which, the
 * form states the consequence in a sentence before it will submit — so the thing being
 * agreed to is read, not deduced. The button changes name for the same reason.
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
  const movingVariant = (colorId && colorId !== row.product_color_id)
    || (size && String(size) !== String(row.size_eu));

  const n = parseInt(qty, 10);
  const hasNumber = Number.isFinite(n) && n >= 0;
  const delta = hasNumber ? n - available : 0;

  // Deleting pairs is the one branch with nothing to fall back on afterwards, so it is
  // the one that insists on a reason — the same rule the Remove screen applies.
  const deleting = !movingVariant && hasNumber && delta < 0;
  const reasonOk = !deleting || reason.trim().length >= 3;

  const valid = movingVariant
    ? (hasNumber && n >= 1 && n <= available)
    : (hasNumber && delta !== 0 && reasonOk);

  /** What is about to happen, in words, before it happens. */
  const preview = () => {
    if (!hasNumber) return null;
    if (movingVariant) {
      if (n < 1 || n > available) return null;
      const target = [
        colorId ? (cat.colors || []).find((c) => c.id === colorId)?.color_name : null,
        size && String(size) !== String(row.size_eu) ? String(size) : null,
      ].filter(Boolean).join(' · ') || t('inventory.reassign');
      const lines = [t('inventory.qty_preview_move', { count: n, target })];
      if (n < available) lines.push(t('inventory.qty_preview_stay', { count: available - n }));
      return lines.join(' ');
    }
    if (delta > 0) return t('inventory.qty_preview_add', { count: delta });
    if (delta < 0) return t('inventory.qty_preview_remove', { count: -delta });
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!hasNumber) { toast.error(t('inventory.reassign_bad_quantity', { max: available })); return; }

    if (movingVariant) {
      if (n < 1 || n > available) {
        toast.error(t('inventory.reassign_bad_quantity', { max: available }));
        return;
      }
    } else if (delta === 0) {
      toast.error(t('inventory.qty_nothing_changed'));
      return;
    } else if (!reasonOk) {
      toast.error(t('inventory.qty_reason_required'));
      return;
    }

    try {
      setSaving(true);

      if (!movingVariant) {
        // A correction of the count where it stands. Nothing is relabelled, because
        // the pairs stay on the variant their barcode already describes.
        const { data } = await inventoryAPI.setQuantity({
          variant_id: row.variant_id,
          store_id: row.store_id,
          quantity: n,
          reason: reason || null,
        });
        const res = data.data;
        toast.success(res.added
          ? t('inventory.qty_done_added', { count: res.added, total: res.to })
          : t('inventory.qty_done_removed', { count: res.removed, total: res.to }));
        if (res.from_purchase) {
          toast(t('inventory.remove_invoice_note', { count: res.from_purchase }), { duration: 8000 });
        }
        onDone?.(res);
        onClose();
        return;
      }

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

  const previewText = preview();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--spacing-xs)' }}>{t('inventory.edit_stock_title')}</h2>
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
              {movingVariant
                ? t('inventory.reassign_how_many', { max: available })
                : t('inventory.qty_label_count', { max: available })}
            </label>
            <input className="form-input" type="number" min={movingVariant ? 1 : 0}
              max={movingVariant ? available : undefined} required
              data-testid="reassign-quantity"
              value={qty} onChange={(e) => setQty(e.target.value)} />
            {/* Said plainly: when moving, this count is what CAN move, not what exists. */}
            <div className="form-hint">
              {movingVariant ? t('inventory.reassign_in_stock_only') : t('inventory.qty_count_hint')}
            </div>
          </div>

          {/* The consequence, before it is agreed to. */}
          {previewText && (
            <div className="form-hint" data-testid="reassign-preview"
              style={{
                background: 'var(--color-bg-secondary)',
                borderInlineStart: '3px solid var(--color-primary)',
                padding: 'var(--spacing-sm)',
                marginBottom: 'var(--spacing-sm)',
                color: 'var(--color-text)',
              }}>
              {previewText}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">
              {t('common.notes')}{deleting ? ' *' : ''}
            </label>
            <input className="form-input" value={reason} data-testid="reassign-reason"
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('inventory.reassign_reason_hint')} />
            {deleting && (
              <div className="form-hint">{t('inventory.remove_reason_why')}</div>
            )}
          </div>

          {/* The one consequence that leaves the screen and lands on a shelf. Only a
              MOVE invalidates a label: a count correction leaves the pairs on the
              variant their barcode already describes. */}
          {movingVariant && (
            <div className="form-hint" data-testid="reassign-label-warning"
              style={{ color: 'var(--color-warning, var(--color-danger))', marginBottom: 'var(--spacing-sm)' }}>
              {t('inventory.reassign_label_warning')}
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className={`btn ${deleting ? 'btn-danger' : 'btn-primary'}`}
              disabled={saving || !valid} data-testid="reassign-save">
              {saving ? t('common.loading')
                : movingVariant ? t('inventory.reassign_move') : t('inventory.qty_save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
