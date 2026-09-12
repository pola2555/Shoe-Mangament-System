import { useState, useEffect, useRef } from 'react';
import { salesAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import { formatSize, formatColor } from '../../utils/variantFormat';
import './Receipt.css';

/**
 * A customer receipt.
 *
 * PRINTING IS OPTIONAL, and that is the whole design.
 *
 * Most shoe shops hand over a bag, not a docket, and a screen that forces a print
 * dialog after every sale trains staff to dismiss dialogs. So this opens as something
 * to LOOK at — the customer can read it over the counter, or be shown the total — and
 * printing is one button among several. Nothing auto-prints.
 *
 * WIDTH
 *
 * 80 mm is the default because that is what a thermal receipt printer takes and it also
 * reads fine on a phone held over the counter. A4 exists for anyone printing on the
 * office printer. The choice is remembered per till, since a shop has one answer.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 *
 * Cost, margin, and the coded price. A receipt goes to the customer, and the price code
 * on a label exists precisely so that information stays inside the shop.
 */

const WIDTH_KEY = 'receipt_width';

export default function ReceiptModal({ saleId, onClose }) {
  const { t, locale } = useTranslation();
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(() => {
    try { return localStorage.getItem(WIDTH_KEY) || '80mm'; } catch { return '80mm'; }
  });
  const frameRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    salesAPI.getById(saleId)
      .then(({ data }) => { if (!cancelled) setSale(data.data); })
      .catch(() => { if (!cancelled) setSale(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [saleId]);

  const chooseWidth = (w) => {
    setWidth(w);
    try { localStorage.setItem(WIDTH_KEY, w); } catch { /* private mode */ }
  };

  /**
   * Print through a hidden iframe rather than the page.
   *
   * The same approach the label sheet uses, and for the same reason: `@page` has to
   * describe ONLY the receipt. Printing the page itself would carry the sidebar, the
   * app's screen stylesheet and the browser's own header into the output.
   */
  const print = () => {
    const node = document.getElementById('receipt-print-root');
    if (!node) return;
    const frame = frameRef.current;
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${sale?.sale_number || ''}</title>
      <style>${receiptCss(width)}</style></head>
      <body dir="${locale === 'ar' ? 'rtl' : 'ltr'}">${node.innerHTML}</body></html>`);
    doc.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
  };

  if (loading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
          <div className="spinner" />
        </div>
      </div>
    );
  }
  if (!sale) return null;

  const money = (v) => `${(Math.round((Number(v) || 0) * 100) / 100).toLocaleString()} ${t('common.currency')}`;
  const paid = Number(sale.amount_paid) || 0;
  const due = Number(sale.amount_due) || 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card receipt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="receipt-toolbar">
          <h2>{t('receipt.title')}</h2>
          <div className="receipt-actions">
            <div className="receipt-widths">
              {['80mm', 'a4'].map((w) => (
                <button key={w} type="button"
                  className={`btn btn-sm ${width === w ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => chooseWidth(w)}>
                  {t(`receipt.width_${w}`)}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" onClick={print} data-testid="receipt-print">
              {t('receipt.print')}
            </button>
            <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
          </div>
        </div>
        <p className="section-hint">{t('receipt.optional_hint')}</p>

        <div className={`receipt-preview receipt-preview--${width}`}>
          <div id="receipt-print-root" className="receipt">
            <div className="r-head">
              <div className="r-shop">{sale.store_name}</div>
              {sale.store_phone && <div className="r-line">{sale.store_phone}</div>}
              {sale.store_address && <div className="r-line">{sale.store_address}</div>}
            </div>

            <div className="r-meta">
              <div><span>{t('receipt.number')}</span><strong>{sale.sale_number}</strong></div>
              <div><span>{t('common.date')}</span><span>{new Date(sale.created_at).toLocaleString()}</span></div>
              {(sale.sold_by_name || sale.created_by_name) && (
                <div><span>{t('receipt.served_by')}</span><span>{sale.sold_by_name || sale.created_by_name}</span></div>
              )}
              {sale.customer_name && (
                <div><span>{t('common.customer')}</span><span>{sale.customer_name}</span></div>
              )}
            </div>

            <table className="r-items">
              <thead>
                <tr>
                  <th>{t('common.product')}</th>
                  <th className="r-num">{t('common.price')}</th>
                </tr>
              </thead>
              <tbody>
                {(sale.items || []).map((it) => (
                  <tr key={it.id}>
                    <td>
                      <div className="r-name">{it.product_name}</div>
                      <div className="r-sub">
                        {[formatColor(it), formatSize(it, locale)].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="r-num">{money(it.sale_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="r-totals">
              <div><span>{t('receipt.subtotal')}</span><span>{money(sale.total_amount)}</span></div>
              {Number(sale.discount_amount) > 0 && (
                <div><span>{t('common.discount')}</span><span>-{money(sale.discount_amount)}</span></div>
              )}
              <div className="r-grand"><span>{t('common.total')}</span><span>{money(sale.final_amount)}</span></div>
              {(sale.payments || []).map((p) => (
                <div key={p.id}><span>{t(`sales.method_${p.payment_method}`, {}, p.payment_method)}</span><span>{money(p.amount)}</span></div>
              ))}
              {due > 0.01 && (
                <div className="r-due"><span>{t('receipt.still_owing')}</span><span>{money(due)}</span></div>
              )}
              {paid > Number(sale.final_amount) + 0.01 && (
                <div><span>{t('receipt.change')}</span><span>{money(paid - Number(sale.final_amount))}</span></div>
              )}
            </div>

            {sale.store_receipt_note && <div className="r-note">{sale.store_receipt_note}</div>}
            <div className="r-thanks">{t('receipt.thanks')}</div>
          </div>
        </div>

        {/* Kept out of the layout entirely; only ever written to at print time. */}
        <iframe ref={frameRef} title="receipt-print" className="receipt-print-frame" />
      </div>
    </div>
  );
}

/** The print stylesheet. `@page` describes the receipt and nothing else. */
function receiptCss(width) {
  const page = width === 'a4' ? 'A4' : '80mm auto';
  const pad = width === 'a4' ? '16mm' : '3mm';
  return `
    @page { size: ${page}; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: ${pad}; font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
           font-size: ${width === 'a4' ? '12pt' : '9pt'}; color: #000; background: #fff; }
    .r-head { text-align: center; margin-bottom: 6px; }
    .r-shop { font-size: 1.25em; font-weight: 700; }
    .r-line { font-size: 0.85em; }
    .r-meta { border-top: 1px dashed #000; border-bottom: 1px dashed #000;
              padding: 4px 0; margin: 6px 0; font-size: 0.85em; }
    .r-meta > div { display: flex; justify-content: space-between; gap: 8px; }
    .r-items { width: 100%; border-collapse: collapse; }
    .r-items th { text-align: start; font-size: 0.8em; border-bottom: 1px solid #000; padding-bottom: 2px; }
    .r-items td { padding: 3px 0; vertical-align: top; }
    .r-num { text-align: end; white-space: nowrap; }
    .r-name { font-weight: 600; }
    .r-sub { font-size: 0.8em; color: #333; }
    .r-totals { border-top: 1px dashed #000; margin-top: 6px; padding-top: 4px; }
    .r-totals > div { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
    .r-grand { font-weight: 700; font-size: 1.15em; border-top: 1px solid #000;
               border-bottom: 1px solid #000; margin: 3px 0; padding: 3px 0; }
    .r-due { font-weight: 700; }
    .r-note { margin-top: 8px; font-size: 0.8em; text-align: center; }
    .r-thanks { margin-top: 8px; text-align: center; font-size: 0.9em; }
  `;
}
