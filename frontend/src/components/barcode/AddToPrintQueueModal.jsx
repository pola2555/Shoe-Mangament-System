import { useState, useEffect, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { printQueueAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import { formatSize, formatColor } from '../../utils/variantFormat';
// Lives in its own module so a page can ask whether to offer the queue without pulling
// this dialog — and the label renderer behind it — into its chunk.
import { setPromptSuppressed } from '../../utils/printQueuePrompt';

/**
 * "You just put 60 pairs on the shelf — shall I queue their labels?"
 *
 * Opens once, straight after a purchase box is completed or a stock intake is posted,
 * because that is the only moment anybody knows what just arrived. The alternative is
 * remembering, and the whole queue exists because nobody does.
 *
 * WHAT IT OFFERS IS WHAT THE DOCUMENT CREATED, not what is in stock. Those differ the
 * moment a pair sells, and a label was owed for it either way.
 *
 * Nothing is added until the button is pressed, and adding twice is safe: the server
 * REPLACES this document's pending rows rather than adding to them, so a reload or a
 * second person answering the same prompt cannot double the paper.
 *
 * Props: { sourceType: 'purchase_box' | 'stock_intake', sourceId, title, onClose,
 *          onQueued(rows) }
 */
export default function AddToPrintQueueModal({ sourceType, sourceId, title, onClose, onQueued }) {
  const { t, locale } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [qty, setQty] = useState({});
  const [sourceRef, setSourceRef] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [sourceType, sourceId]);

  // Esc closes, like every other dialog in the app.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function load() {
    try {
      setLoading(true);
      const res = await printQueueAPI.sourceLines({ source_type: sourceType, source_id: sourceId });
      const data = res.data.data || {};
      const list = data.rows || [];
      setRows(list);
      setSourceRef(data.source_ref || null);
      // One label per pair received. Anything already queued for this same document
      // wins, so re-opening the prompt shows what was decided last time rather than
      // silently resetting an edited count back to the full run.
      setQty(Object.fromEntries(list.map((r) => [
        r.variant_id, r.queued_qty || r.created_qty || 0,
      ])));
    } catch (err) {
      toast.error(err.response?.data?.message || t('print_queue.load_failed'));
      onClose();
    } finally {
      setLoading(false);
    }
  }

  const total = useMemo(
    () => rows.reduce((n, r) => n + (Number(qty[r.variant_id]) || 0), 0),
    [rows, qty]
  );
  const alreadyQueued = useMemo(() => rows.some((r) => r.queued_qty > 0), [rows]);

  function setOne(variantId, v) {
    const n = Math.max(0, Math.min(999, Number(v) || 0));
    setQty((q) => ({ ...q, [variantId]: n }));
  }

  async function submit(thenPrint) {
    if (total === 0) { toast.error(t('print_queue.nothing_selected')); return; }
    try {
      setSaving(true);
      const res = await printQueueAPI.addFromSource({
        source_type: sourceType,
        source_id: sourceId,
        items: rows.map((r) => ({ variant_id: r.variant_id, quantity: Number(qty[r.variant_id]) || 0 })),
      });
      if (dontAsk) setPromptSuppressed(true);
      toast.success(t('print_queue.added', { count: total }));
      // The sidebar badge listens for this rather than polling: a queue that is only
      // ever changed from inside this app does not need to be asked about on a timer.
      window.dispatchEvent(new CustomEvent('print-queue-changed'));
      onQueued?.(res.data.data || [], thenPrint);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || t('print_queue.add_failed'));
    } finally {
      setSaving(false);
    }
  }

  function dismiss() {
    if (dontAsk) setPromptSuppressed(true);
    onClose();
  }

  // Grouped by colour, so the list reads the way the stock is stacked.
  const byColour = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const name = formatColor(r) || '';
      if (!m.has(name)) m.set(name, { hex: r.hex_code, rows: [] });
      m.get(name).rows.push(r);
    }
    return [...m.entries()];
  }, [rows]);

  return createPortal(
    <div className="modal-overlay" onClick={dismiss}>
      <div
        className="modal-content card"
        data-testid="add-to-print-queue"
        style={{ maxWidth: 680, width: '95%', maxHeight: '92vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '.35rem' }}>
          <h2 style={{ margin: 0 }}>{t('print_queue.prompt_title')}</h2>
          <button className="btn btn-secondary btn-sm" onClick={dismiss}>{t('common.close')}</button>
        </div>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginTop: 0 }}>
          {t('print_queue.prompt_why')}
        </p>
        {(title || sourceRef) && (
          <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-md)' }}>
            {[title, sourceRef].filter(Boolean).join(' · ')}
          </div>
        )}

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-secondary)' }} data-testid="pq-source-empty">
            {t('print_queue.source_empty')}
          </div>
        ) : (
          <>
            {alreadyQueued && (
              <div
                style={{
                  marginBottom: 'var(--spacing-md)', padding: '.6rem .8rem',
                  borderRadius: 'var(--radius-md)', fontSize: 'var(--font-size-sm)',
                  background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
                }}
                data-testid="pq-already-queued"
              >
                {t('print_queue.already_queued')}
              </div>
            )}

            <div className="table-container" style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--spacing-md)' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{t('products.size_generic')}</th>
                    <th style={{ textAlign: 'center' }}>{t('print_queue.received')}</th>
                    <th style={{ textAlign: 'center' }}>{t('barcode.copies')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byColour.map(([colour, grp]) => (
                    <Fragment key={colour}>
                      {colour && (
                        <tr style={{ background: 'var(--color-bg-secondary)' }}>
                          <td colSpan={3} style={{ fontWeight: 700 }}>
                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: grp.hex || '#ccc', marginInlineEnd: 6, border: '1px solid var(--color-border)' }} />
                            {colour}
                          </td>
                        </tr>
                      )}
                      {grp.rows.map((r) => (
                        <tr key={r.variant_id}>
                          <td>{formatSize(r, locale)}</td>
                          <td style={{ textAlign: 'center' }}>{r.created_qty}</td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="number" min={0} max={999} className="form-input"
                              style={{ width: 76, textAlign: 'center' }}
                              value={qty[r.variant_id] ?? 0}
                              onChange={(e) => setOne(r.variant_id, e.target.value)}
                            />
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem', marginBottom: 'var(--spacing-md)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                <input type="checkbox" checked={dontAsk} data-testid="pq-dont-ask" onChange={(e) => setDontAsk(e.target.checked)} />
                <span>{t('print_queue.dont_ask')}</span>
              </label>
              <strong data-testid="pq-total">{t('barcode.total_labels', { count: total })}</strong>
            </div>

            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={dismiss} data-testid="pq-not-now">
                {t('print_queue.not_now')}
              </button>
              <button className="btn btn-secondary" onClick={() => submit(true)} disabled={saving || total === 0} data-testid="pq-add-and-print">
                {t('print_queue.add_and_print')}
              </button>
              <button className="btn btn-primary" onClick={() => submit(false)} disabled={saving || total === 0} data-testid="pq-add">
                {saving ? t('common.loading') : t('print_queue.add_to_queue')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
