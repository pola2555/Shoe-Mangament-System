import { useState, useEffect, useMemo, useCallback, lazy, Suspense, Fragment } from 'react';
import toast from 'react-hot-toast';
import { printQueueAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { formatSize, formatColor } from '../../utils/variantFormat';
import { promptSuppressed, setPromptSuppressed } from '../../utils/printQueuePrompt';
import {
  HiOutlinePrinter, HiOutlineTrash, HiOutlineArrowPath, HiOutlineCheckCircle,
} from 'react-icons/hi2';
import '../products/Products.css';
import './PrintQueue.css';

// The label dialog pulls in the barcode renderer and the TSPL writer; both stay out of
// this page's chunk until somebody actually prints.
const PrintLabelsModal = lazy(() => import('../../components/barcode/PrintLabelsModal'));

/**
 * THE PRINT QUEUE — labels the shop owes itself.
 *
 * Stock is received at a desk and labels come out of a printer, and those are rarely
 * the same place or the same minute. Before this page the only way to print was to be
 * standing in front of the document that created the stock, so a morning spent
 * receiving four invoices meant four trips to the printer, or reconstructing afterwards
 * from memory which boxes still needed labels.
 *
 * Two lists, because they answer different questions:
 *
 *   TO PRINT   what is still owed. This is the page's job.
 *   PRINTED    what has been done, so "did I already do that box?" is answerable, and
 *              so a run that jammed can be sent again.
 *
 * WHY MARKING PRINTED IS A SEPARATE ACT
 *
 * A browser cannot see whether a print dialog was cancelled, let alone whether the
 * paper came out straight. So printing does not tick anything off by itself — it offers
 * to, and the person who watched the printer answers. Anything else would quietly empty
 * the queue for a run that never happened, which is the one failure that loses labels
 * rather than wasting them.
 */

const day = (v) => (v ? String(v).slice(0, 10) : '—');

export default function PrintQueuePage() {
  const { t, locale } = useTranslation();
  const confirm = useConfirm();
  const { filterStores, hasPermission } = useAuth();
  const canWrite = hasPermission('print_queue', 'write');

  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [search, setSearch] = useState('');
  // The list reloads whenever this changes, so the raw box would fire a request per
  // keystroke. `search` is what the input shows; `query` is what the server is asked.
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [printIds, setPrintIds] = useState(null);
  const [asking, setAsking] = useState(!promptSuppressed());
  const [summary, setSummary] = useState({ items: 0, labels: 0 });

  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = {
        status: tab,
        ...(storeId ? { store_id: storeId } : {}),
        ...(query ? { search: query } : {}),
      };
      const [list, sum] = await Promise.all([
        printQueueAPI.list(params),
        printQueueAPI.summary(storeId ? { store_id: storeId } : {}),
      ]);
      setRows(list.data.data || []);
      setSummary(sum.data.data || { items: 0, labels: 0 });
      // A selection that survived a reload would silently include rows that are no
      // longer on screen, and "print selected" would send labels nobody can see.
      setSelected(new Set());
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [tab, storeId, query, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // The auth context exposes filterStores but not the list itself; every page fetches
  // its own and filters it through the same rule.
  useEffect(() => {
    storesAPI.list().then(({ data }) => setStores(data.data || [])).catch(() => {});
  }, []);

  /** Tell the sidebar badge the queue moved, without it having to poll. */
  const announce = () => window.dispatchEvent(new CustomEvent('print-queue-changed'));

  // ---------------------------------------------------------------- grouping

  /**
   * Product → colour → rows. The queue is read standing at a printer with a pile of
   * boxes, so it has to be arranged the way the stock is, not by when it was queued.
   */
  const grouped = useMemo(() => {
    const byProduct = new Map();
    for (const r of rows) {
      const pKey = r.product_id;
      if (!byProduct.has(pKey)) {
        byProduct.set(pKey, {
          product_id: r.product_id,
          name: [r.brand, r.product_name].filter(Boolean).join(' ') || r.product_code,
          code: r.product_code,
          colours: new Map(),
          labels: 0,
        });
      }
      const p = byProduct.get(pKey);
      const cKey = formatColor(r) || '';
      if (!p.colours.has(cKey)) p.colours.set(cKey, { name: cKey, hex: r.hex_code, rows: [] });
      p.colours.get(cKey).rows.push(r);
      p.labels += tab === 'pending' ? r.remaining : r.printed_qty;
    }
    return [...byProduct.values()];
  }, [rows, tab]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedLabels = useMemo(
    () => selectedRows.reduce((n, r) => n + r.remaining, 0),
    [selectedRows]
  );
  const allLabels = useMemo(() => rows.reduce((n, r) => n + r.remaining, 0), [rows]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => setSelected((s) => (
    s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))
  ));

  const toggleGroup = (groupRows) => setSelected((s) => {
    const next = new Set(s);
    const allIn = groupRows.every((r) => next.has(r.id));
    groupRows.forEach((r) => (allIn ? next.delete(r.id) : next.add(r.id)));
    return next;
  });

  // ----------------------------------------------------------------- actions

  function openPrint(ids) {
    if (!ids.length) { toast.error(t('print_queue.nothing_selected')); return; }
    setPrintIds(ids);
  }

  /**
   * Work out which queue rows the labels that just printed belong to.
   *
   * One size can be owed by two documents, and the print dialog only knows sizes — so
   * each size's copies are poured into its queue rows in turn, filling the first before
   * the next. Any surplus (somebody typed more copies than the queue owed) is dropped
   * rather than recorded, because the queue cannot owe less than nothing.
   */
  function distribute(labelRows, copies) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [];
    for (const lr of labelRows) {
      let left = Number(copies[lr.variant_id]) || 0;
      for (const qid of (lr.queue_ids || [])) {
        if (left <= 0) break;
        const owed = byId.get(qid)?.remaining;
        const take = owed == null ? left : Math.min(left, owed);
        if (take > 0) out.push({ id: qid, quantity: take });
        left -= take;
      }
    }
    return out;
  }

  async function afterPrint(total, copies, labelRows) {
    const items = distribute(labelRows, copies);
    if (!items.length) return;
    const ok = await confirm({
      title: t('print_queue.mark_printed_title'),
      message: t('print_queue.mark_printed_confirm', { count: total }),
      confirmText: t('print_queue.mark_printed'),
      cancelText: t('print_queue.not_yet'),
    });
    if (!ok) return;
    await markPrinted(items);
  }

  async function markPrinted(items) {
    try {
      const { data } = await printQueueAPI.markPrinted(items);
      toast.success(t('print_queue.marked', { count: data.data.labels }));
      announce();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  async function changeQty(row, value) {
    const n = Math.max(1, Math.min(999, Number(value) || 0));
    if (n === row.quantity) return;
    try {
      await printQueueAPI.update(row.id, { quantity: n });
      announce();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  async function removeRow(row) {
    const ok = await confirm({
      title: t('print_queue.remove_title'),
      message: t('print_queue.remove_confirm', {
        count: row.remaining,
        product: [row.brand, row.product_name].filter(Boolean).join(' '),
      }),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await printQueueAPI.remove(row.id);
      announce();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  async function requeue(row) {
    try {
      await printQueueAPI.requeue(row.id);
      toast.success(t('print_queue.requeued', { count: row.quantity }));
      announce();
      setTab('pending');
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  async function clearHistory() {
    const ok = await confirm({
      title: t('print_queue.clear_title'),
      message: t('print_queue.clear_confirm'),
      confirmText: t('print_queue.clear'),
      danger: true,
    });
    if (!ok) return;
    try {
      const { data } = await printQueueAPI.clear({
        status: 'done',
        ...(storeId ? { store_id: storeId } : {}),
      });
      toast.success(t('print_queue.cleared', { count: data.data.removed }));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  function toggleAsking(next) {
    setAsking(next);
    setPromptSuppressed(!next);
  }

  // ------------------------------------------------------------------ render

  const isPending = tab === 'pending';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('print_queue.title')}</h1>
          <p className="pq-subtitle">{t('print_queue.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          {isPending && canWrite && (
            <button
              className="btn btn-primary"
              data-testid="pq-print-all"
              disabled={rows.length === 0}
              onClick={() => openPrint(rows.map((r) => r.id))}
            >
              <HiOutlinePrinter size={18} />
              {t('print_queue.print_all', { count: allLabels })}
            </button>
          )}
          {!isPending && canWrite && (
            <button className="btn btn-secondary" onClick={clearHistory} disabled={rows.length === 0} data-testid="pq-clear">
              <HiOutlineTrash size={18} />
              {t('print_queue.clear')}
            </button>
          )}
        </div>
      </div>

      {/* What the page is for, in one line. The queue only works if people know it
          fills itself — otherwise it reads as another list to maintain by hand. */}
      <div className="pq-explainer card" data-testid="pq-explainer">
        <div>
          <strong>{t('print_queue.how_title')}</strong>
          <div>{t('print_queue.how_body')}</div>
        </div>
        <label className="pq-ask-toggle">
          <input
            type="checkbox"
            checked={asking}
            data-testid="pq-ask-toggle"
            onChange={(e) => toggleAsking(e.target.checked)}
          />
          <span>{t('print_queue.ask_after_receiving')}</span>
        </label>
      </div>

      <div className="tabs">
        <button
          className={`tab ${isPending ? 'tab--active' : ''}`}
          data-testid="pq-tab-pending"
          onClick={() => setTab('pending')}
        >
          {t('print_queue.tab_pending')}
          {summary.items > 0 && <span className="pq-pill">{summary.labels}</span>}
        </button>
        <button
          className={`tab ${!isPending ? 'tab--active' : ''}`}
          data-testid="pq-tab-done"
          onClick={() => setTab('done')}
        >
          {t('print_queue.tab_done')}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div className="pq-filters">
          <select
            className="form-input"
            value={storeId}
            data-testid="pq-store"
            onChange={(e) => setStoreId(e.target.value)}
          >
            <option value="">{t('print_queue.all_branches')}</option>
            {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            className="form-input"
            placeholder={t('print_queue.search_hint')}
            value={search}
            data-testid="pq-search"
            onChange={(e) => setSearch(e.target.value)}
          />
          {isPending && rows.length > 0 && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={toggleAll} data-testid="pq-select-all">
                {selected.size === rows.length ? t('print_queue.select_none') : t('print_queue.select_all')}
              </button>
              {canWrite && selected.size > 0 && (
                <>
                  <button className="btn btn-primary btn-sm" onClick={() => openPrint([...selected])} data-testid="pq-print-selected">
                    <HiOutlinePrinter size={16} />
                    {t('print_queue.print_selected', { count: selectedLabels })}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    data-testid="pq-mark-selected"
                    onClick={() => markPrinted(selectedRows.map((r) => ({ id: r.id })))}
                  >
                    <HiOutlineCheckCircle size={16} />
                    {t('print_queue.mark_printed')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <div className="card pq-empty" data-testid="pq-empty">
          <strong>{isPending ? t('print_queue.empty_title') : t('print_queue.empty_done_title')}</strong>
          <p>{isPending ? t('print_queue.empty_body') : t('print_queue.empty_done_body')}</p>
        </div>
      ) : (
        grouped.map((p) => (
          <div className="card pq-product" key={p.product_id}>
            <div className="pq-product__head">
              <div>
                <h3>{p.name}</h3>
                <span className="pq-code">{p.code}</span>
              </div>
              <div className="pq-product__actions">
                <span className="pq-count">
                  {isPending
                    ? t('print_queue.labels_owed', { count: p.labels })
                    : t('print_queue.labels_printed', { count: p.labels })}
                </span>
                {isPending && canWrite && (
                  <button
                    className="btn btn-secondary btn-sm"
                    data-testid="pq-print-product"
                    onClick={() => openPrint(
                      [...p.colours.values()].flatMap((c) => c.rows.map((r) => r.id))
                    )}
                  >
                    <HiOutlinePrinter size={16} />
                    {t('barcode.print_labels')}
                  </button>
                )}
              </div>
            </div>

            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    {isPending && <th style={{ width: 34 }} />}
                    <th>{t('products.size_generic')}</th>
                    <th>{t('barcode.barcode')}</th>
                    <th>{t('print_queue.branch')}</th>
                    <th>{t('print_queue.source')}</th>
                    <th style={{ textAlign: 'center' }}>
                      {isPending ? t('print_queue.labels') : t('print_queue.printed')}
                    </th>
                    <th style={{ width: 96 }} />
                  </tr>
                </thead>
                <tbody>
                  {[...p.colours.values()].map((c) => (
                    <Fragment key={c.name || '_'}>
                      {c.name && (
                        <tr className="pq-colour-row">
                          <td colSpan={isPending ? 7 : 6}>
                            <label className="pq-colour">
                              {isPending && (
                                <input
                                  type="checkbox"
                                  checked={c.rows.every((r) => selected.has(r.id))}
                                  onChange={() => toggleGroup(c.rows)}
                                />
                              )}
                              <span className="pq-swatch" style={{ background: c.hex || '#ccc' }} />
                              {c.name}
                            </label>
                          </td>
                        </tr>
                      )}
                      {c.rows.map((r) => (
                        <tr key={r.id} data-testid="pq-row">
                          {isPending && (
                            <td>
                              <input
                                type="checkbox"
                                checked={selected.has(r.id)}
                                data-testid="pq-select-row"
                                onChange={() => toggle(r.id)}
                              />
                            </td>
                          )}
                          <td>{formatSize(r, locale)}</td>
                          <td className="pq-mono">
                            {r.barcode || <em className="pq-missing">{t('barcode.none')}</em>}
                          </td>
                          <td>{r.store_name}</td>
                          <td>
                            <span className="pq-source">{t(`print_queue.src_${r.source_type}`)}</span>
                            {r.source_ref && <div className="pq-ref">{r.source_ref}</div>}
                            <div className="pq-when">{day(isPending ? r.created_at : r.completed_at)}</div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {isPending && canWrite ? (
                              <input
                                // Uncontrolled so typing is not fought by a reload, but
                                // keyed on the stored value so a server-side clamp
                                // (cutting below what already printed) shows the number
                                // that was actually kept rather than the one typed.
                                key={`${r.id}-${r.quantity}`}
                                type="number" min={1} max={999} className="form-input pq-qty"
                                defaultValue={r.quantity}
                                data-testid="pq-qty"
                                onBlur={(e) => changeQty(r, e.target.value)}
                              />
                            ) : (
                              <strong>{isPending ? r.quantity : r.printed_qty}</strong>
                            )}
                            {isPending && r.printed_qty > 0 && (
                              <div className="pq-part">{t('print_queue.part_printed', { n: r.printed_qty })}</div>
                            )}
                          </td>
                          <td>
                            {canWrite && (
                              <div className="pq-row-actions">
                                {isPending ? (
                                  <>
                                    <button
                                      className="pq-icon-btn" title={t('barcode.print_labels')}
                                      data-testid="pq-print-row" onClick={() => openPrint([r.id])}
                                    >
                                      <HiOutlinePrinter size={16} />
                                    </button>
                                    <button
                                      className="pq-icon-btn pq-icon-btn--danger" title={t('common.remove')}
                                      data-testid="pq-remove" onClick={() => removeRow(r)}
                                    >
                                      <HiOutlineTrash size={16} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="pq-icon-btn" title={t('print_queue.print_again')}
                                    data-testid="pq-requeue" onClick={() => requeue(r)}
                                  >
                                    <HiOutlineArrowPath size={16} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {printIds && (
        <Suspense fallback={null}>
          <PrintLabelsModal
            queueIds={printIds}
            title={t('print_queue.title')}
            onPrinted={afterPrint}
            onClose={() => setPrintIds(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
