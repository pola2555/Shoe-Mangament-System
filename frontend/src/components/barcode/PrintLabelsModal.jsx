import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { barcodesAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import LabelSheet, { labelCss, LABEL_SIZES, LABEL_ROTATIONS } from './LabelSheet';
import { downloadTspl } from '../../utils/tspl';
import { formatSize, formatColor } from '../../utils/variantFormat';

/**
 * Pick which variants to label, how many of each, then print.
 *
 * Printing goes through a hidden iframe rather than the page itself. `@page { size }`
 * applies to a whole document, so printing in-place would force the entire app onto
 * 38 x 25 mm paper; the iframe keeps that scoped to the labels.
 *
 * The orientation control is not a preference — it is a driver workaround. Chrome
 * infers page orientation from the aspect of `@page { size }`, and a label driver
 * whose stock is already 38 x 25 answers a landscape request by turning the image
 * sideways, which then runs off the end of the label and onto the next one. Whichever
 * way a given driver behaves, one of the two settings comes out straight, so the
 * operator can calibrate with a single test label instead of a whole run.
 *
 * Source is one of: { productId } | { variantIds } | { invoiceBoxId }.
 */
export default function PrintLabelsModal({
  productId, variantIds, invoiceBoxId, storeId, title, onClose,
}) {
  const { t, locale } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [copies, setCopies] = useState({});
  const [size, setSize] = useState(() => localStorage.getItem('label_size') || '38x25');
  const [rotate, setRotate] = useState(() => {
    const saved = Number(localStorage.getItem('label_rotate'));
    return LABEL_ROTATIONS.includes(saved) ? saved : 0;
  });
  const [setupHidden, setSetupHidden] = useState(() => localStorage.getItem('label_setup_done') === '1');
  const [generating, setGenerating] = useState(false);
  const previewRef = useRef(null);
  const testRef = useRef(null);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [productId, invoiceBoxId, storeId]);
  useEffect(() => { localStorage.setItem('label_size', size); }, [size]);
  useEffect(() => { localStorage.setItem('label_rotate', String(rotate)); }, [rotate]);
  useEffect(() => { localStorage.setItem('label_setup_done', setupHidden ? '1' : '0'); }, [setupHidden]);

  async function load() {
    // An explicitly empty variant list is a legitimate state (an inventory filter that
    // matched nothing), not an error. Show an empty dialog rather than firing a
    // request the API will reject and bouncing the user out.
    if (!productId && !invoiceBoxId && (!variantIds || variantIds.length === 0)) {
      setRows([]);
      setCopies({});
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const params = { store_id: storeId || undefined };
      if (productId) params.product_id = productId;
      if (invoiceBoxId) params.invoice_box_id = invoiceBoxId;
      if (variantIds?.length) params.variant_ids = variantIds.join(',');

      const res = await barcodesAPI.labels(params);
      const data = res.data.data || [];
      setRows(data);
      // Default to one label per pair actually on hand, so the common case needs no
      // counting. Variants with no stock default to 0 rather than 1 — printing a
      // label for something you do not have is pure waste.
      setCopies(Object.fromEntries(data.map((r) => [r.variant_id, r.stock_count || 0])));
    } catch (err) {
      toast.error(err.response?.data?.message || t('barcode.labels_failed'));
      onClose();
    } finally {
      setLoading(false);
    }
  }

  const missing = useMemo(() => rows.filter((r) => !r.barcode), [rows]);
  const printable = useMemo(() => rows.filter((r) => r.barcode), [rows]);
  const totalLabels = useMemo(
    () => printable.reduce((n, r) => n + (Number(copies[r.variant_id]) || 0), 0),
    [printable, copies]
  );

  async function generateMissing() {
    try {
      setGenerating(true);
      await barcodesAPI.assign(
        productId ? { product_id: productId } : { variant_ids: missing.map((m) => m.variant_id) }
      );
      toast.success(t('barcode.generated', { count: missing.length }));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('barcode.generate_failed'));
    } finally {
      setGenerating(false);
    }
  }

  function setCopy(variantId, v) {
    const n = Math.max(0, Math.min(999, Number(v) || 0));
    setCopies((c) => ({ ...c, [variantId]: n }));
  }

  function bulkSet(fn) {
    setCopies(Object.fromEntries(printable.map((r) => [r.variant_id, fn(r)])));
  }

  function handlePrint() {
    if (totalLabels === 0) { toast.error(t('barcode.nothing_to_print')); return; }
    printMarkup(previewRef.current?.innerHTML);
  }

  /** Burn exactly one label to check the driver settings, not the whole run. */
  function handleTestPrint() {
    if (printable.length === 0) { toast.error(t('barcode.nothing_to_print')); return; }
    printMarkup(testRef.current?.innerHTML);
  }

  function printMarkup(markup) {
    if (!markup) { toast.error(t('barcode.nothing_to_print')); return; }

    const frame = document.createElement('iframe');
    // Off-screen rather than display:none — a hidden iframe does not lay out, and an
    // unlaid-out document prints blank.
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;';
    document.body.appendChild(frame);

    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>labels</title><style>${labelCss(size, rotate)}</style></head>
      <body>${markup}</body></html>`);
    doc.close();

    const fire = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (err) {
        toast.error(t('barcode.print_failed'));
      } finally {
        // Give the print dialog time to take its snapshot before the frame goes away.
        setTimeout(() => frame.remove(), 6000);
      }
    };

    // Wait for the SVGs to lay out; onload can fire before that in Safari.
    if (doc.readyState === 'complete') setTimeout(fire, 120);
    else frame.onload = () => setTimeout(fire, 120);
  }

  function handleTspl() {
    if (totalLabels === 0) { toast.error(t('barcode.nothing_to_print')); return; }
    downloadTspl(printable, copies, LABEL_SIZES[size], { rotate, locale });
    toast.success(t('barcode.tspl_downloaded'));
  }

  // Group by colour so the operator scans the list the way the stock is arranged.
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
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content card"
        style={{ maxWidth: 900, width: '95%', maxHeight: '92vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-md)' }}>
          <div>
            <h2 style={{ marginBottom: '.25rem' }}>{t('barcode.print_labels')}</h2>
            {title && <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{title}</div>}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.close')}</button>
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-secondary)' }} data-testid="labels-empty">
            {t('barcode.nothing_to_label')}
          </div>
        ) : (
          <>
            {/* Visible, not collapsed. The physical print comes out wrong unless the
                dialog is using the label stock, and a setting nobody opens is a
                setting nobody applies. */}
            {setupHidden ? (
              <button
                className="btn btn-secondary btn-sm"
                data-testid="printer-setup-show"
                onClick={() => setSetupHidden(false)}
                style={{ marginBottom: 'var(--spacing-md)' }}
              >
                {t('barcode.setup_show')}
              </button>
            ) : (
            <div
              data-testid="printer-setup"
              style={{
                marginBottom: 'var(--spacing-md)', padding: '.75rem .9rem',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-warning-bg, #fff4e5)',
                border: '1px solid var(--color-warning, #e0a030)',
              }}
            >
              <strong>{t('barcode.setup_title')}</strong>
              <div style={{ fontSize: 'var(--font-size-sm)', margin: '.35rem 0 .5rem' }}>
                {t('barcode.setup_why')}
              </div>
              <ol style={{ margin: 0, paddingInlineStart: '1.2rem', fontSize: 'var(--font-size-sm)', lineHeight: 1.75 }}>
                <li>{t('barcode.setup_stock', { size: LABEL_SIZES[size].label })}</li>
                <li>{t('barcode.setup_paper', { size: LABEL_SIZES[size].label })}</li>
                <li>{t('barcode.setup_scale')}</li>
                <li>{t('barcode.setup_headers')}</li>
                <li>{t('barcode.setup_rotated')}</li>
              </ol>
              <button
                className="btn btn-secondary btn-sm"
                data-testid="printer-setup-hide"
                onClick={() => setSetupHidden(true)}
                style={{ marginTop: '.6rem' }}
              >
                {t('barcode.setup_hide')}
              </button>
            </div>
            )}

            {missing.length > 0 && (
              <div className="alert alert-warning" style={{ marginBottom: 'var(--spacing-md)', padding: '.75rem', borderRadius: 'var(--radius-md)', background: 'var(--color-warning-bg, #fff4e5)', border: '1px solid var(--color-warning, #e0a030)' }}>
                <strong>{t('barcode.missing_barcodes', { count: missing.length })}</strong>
                <div style={{ fontSize: 'var(--font-size-sm)', margin: '.35rem 0 .6rem' }}>
                  {t('barcode.missing_hint')}
                </div>
                <button className="btn btn-primary btn-sm" onClick={generateMissing} disabled={generating}>
                  {generating ? t('common.loading') : t('barcode.generate_now')}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
              <label style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                <span>{t('barcode.label_size')}</span>
                <select className="form-input" value={size} data-testid="label-size" onChange={(e) => setSize(e.target.value)} style={{ width: 'auto' }}>
                  {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                <span>{t('barcode.orientation')}</span>
                <select
                  className="form-input" value={rotate} data-testid="label-rotate"
                  onChange={(e) => setRotate(Number(e.target.value))} style={{ width: 'auto' }}
                >
                  <option value={0}>{t('barcode.orient_normal')}</option>
                  <option value={90}>{t('barcode.orient_right')}</option>
                  <option value={270}>{t('barcode.orient_left')}</option>
                </select>
              </label>
              <div style={{ display: 'flex', gap: '.4rem' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => bulkSet((r) => r.stock_count || 0)}>{t('barcode.match_stock')}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => bulkSet(() => 1)}>{t('barcode.one_each')}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => bulkSet(() => 0)}>{t('barcode.clear_all')}</button>
              </div>
              <div style={{ marginInlineStart: 'auto', fontWeight: 600 }}>
                {t('barcode.total_labels', { count: totalLabels })}
              </div>
            </div>

            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--spacing-md)' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{t('products.size_generic')}</th>
                    <th>{t('barcode.barcode')}</th>
                    <th style={{ textAlign: 'center' }}>{t('barcode.in_stock')}</th>
                    <th style={{ textAlign: 'center' }}>{t('barcode.copies')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byColour.map(([colour, grp]) => (
                    <Fragment key={colour}>
                      {colour && (
                        <tr style={{ background: 'var(--color-bg-secondary)' }}>
                          <td colSpan={4} style={{ fontWeight: 700 }}>
                            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: grp.hex || '#ccc', marginInlineEnd: 6, border: '1px solid var(--color-border)' }} />
                            {colour}
                          </td>
                        </tr>
                      )}
                      {grp.rows.map((r) => (
                        <tr key={r.variant_id}>
                          <td>{formatSize(r, locale)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: '.85em' }}>
                            {r.barcode || <em style={{ color: 'var(--color-danger)' }}>{t('barcode.none')}</em>}
                            {r.barcode_source === 'manufacturer' && (
                              <span title={t('barcode.manufacturer')} style={{ marginInlineStart: 6, fontSize: '.8em', opacity: .7 }}>ⓜ</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'center' }}>{r.stock_count}</td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="number" min={0} max={999} className="form-input"
                              style={{ width: 72, textAlign: 'center' }}
                              value={copies[r.variant_id] ?? 0}
                              disabled={!r.barcode}
                              onChange={(e) => setCopy(r.variant_id, e.target.value)}
                            />
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <details style={{ marginBottom: 'var(--spacing-md)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('barcode.preview')}</summary>
              <div style={{ marginTop: '.6rem', background: '#fff', padding: '.5rem', borderRadius: 'var(--radius-md)', overflow: 'auto', maxHeight: 340 }}>
                <style>{labelCss(size, rotate)}</style>
                <LabelSheet rows={printable.slice(0, 6)} copies={Object.fromEntries(printable.slice(0, 6).map((r) => [r.variant_id, Math.min(1, copies[r.variant_id] || 0)]))} size={size} locale={locale} />
              </div>
            </details>

            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={handleTestPrint} disabled={printable.length === 0} data-testid="label-test-print" title={t('barcode.test_print_hint')}>
                {t('barcode.test_print')}
              </button>
              <button className="btn btn-secondary" onClick={handleTspl} disabled={totalLabels === 0} title={t('barcode.tspl_hint')}>
                {t('barcode.download_tspl')}
              </button>
              <button className="btn btn-primary" onClick={handlePrint} disabled={totalLabels === 0}>
                {t('barcode.print_n', { count: totalLabels })}
              </button>
            </div>

          </>
        )}

        {/* Off-screen full-size render; handlePrint copies this markup into the iframe.
            Kept out of the visible preview so the operator's collapsed <details> does
            not change what gets printed. */}
        <div
          ref={previewRef}
          aria-hidden="true"
          style={{ position: 'fixed', left: -99999, top: 0, width: 0, height: 0, overflow: 'hidden' }}
        >
          <LabelSheet rows={printable} copies={copies} size={size} locale={locale} />
        </div>
        <div
          ref={testRef}
          aria-hidden="true"
          style={{ position: 'fixed', left: -99999, top: 0, width: 0, height: 0, overflow: 'hidden' }}
        >
          <LabelSheet
            rows={printable.slice(0, 1)}
            copies={printable[0] ? { [printable[0].variant_id]: 1 } : {}}
            size={size}
            locale={locale}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
