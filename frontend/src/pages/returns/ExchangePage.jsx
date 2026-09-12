import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineQrCode, HiOutlineMagnifyingGlass, HiOutlineArrowLeft } from 'react-icons/hi2';
import { exchangesAPI, salesAPI, inventoryAPI, storesAPI, barcodesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { formatSize, formatColor } from '../../utils/variantFormat';
import ClickableImage from '../../components/common/ClickableImage';
import useBarcodeScanner from '../../hooks/useBarcodeScanner';
import '../products/Products.css';
import './Exchange.css';

const BarcodeScannerModal = lazy(() => import('../../components/barcode/BarcodeScannerModal'));

/**
 * SWAPPING SOMETHING A CUSTOMER ALREADY BOUGHT.
 *
 * Rebuilt to follow the counter, in the order the counter actually happens:
 *
 *   1. FIND THE SALE   the customer hands over a receipt, or says their name, or the
 *                      shoe still has its label on
 *   2. PICK WHAT IS COMING BACK
 *   3. PICK WHAT IS GOING OUT   which is the till, so it behaves like the till
 *
 * WHAT WAS WRONG BEFORE
 *
 * Finding the sale ran a search and silently took `[0]` — the first row the API
 * happened to return. Search "Ahmed" with three Ahmeds and you got whichever one sorted
 * first, with nothing on screen to say there were others. That is not a search, it is a
 * guess. It now lists what it found and makes somebody choose.
 *
 * The outgoing side had a text box and a table. The people doing this are the same
 * people using the POS all day, with the same scanner in their hand, so it now scans:
 * hardware wedge always listening, phone camera behind a button, and a product grid
 * with pictures rather than a wall of SKUs.
 *
 * WHAT STAYED, DELIBERATELY
 *
 * A different size and a different product are ONE action, not two modes. The reason
 * stays optional — most exchanges are "wrong size", and a required dropdown just fills
 * the column with whatever is first in the list.
 *
 * The price of the new item may be higher, lower or identical; the difference is shown
 * as the customer will experience it — they pay, they are refunded, or nothing changes.
 */

const money = (v) => (Math.round((Number(v) || 0) * 100) / 100)
  .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SETTLEMENTS = ['cash', 'card', 'bank_transfer', 'instapay', 'vodafone_cash', 'account'];

export default function ExchangePage() {
  const { t, locale } = useTranslation();
  const { filterStores, hasPermission } = useAuth();
  const canWrite = hasPermission('exchanges', 'write');

  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [history, setHistory] = useState([]);
  const [detail, setDetail] = useState(null);

  // Step 1 — the sale
  const [saleSearch, setSaleSearch] = useState('');
  const [saleResults, setSaleResults] = useState(null); // null = not searched yet
  const [searchingSale, setSearchingSale] = useState(false);
  const [sale, setSale] = useState(null);

  // Step 2 — what comes back
  const [returning, setReturning] = useState({});

  // Step 3 — what goes out
  const [stockSearch, setStockSearch] = useState('');
  const [stock, setStock] = useState([]);
  const [searchingStock, setSearchingStock] = useState(false);
  const [taking, setTaking] = useState([]);
  const [showScanner, setShowScanner] = useState(false);
  const [lastScan, setLastScan] = useState(null);

  const [settlement, setSettlement] = useState('cash');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  // Refs, so the always-on scanner handler keeps a stable identity while still seeing
  // current state — the same pattern the POS uses for the same reason.
  const storeRef = useRef('');
  const takingRef = useRef([]);
  const saleRef = useRef(null);
  useEffect(() => { storeRef.current = storeId; }, [storeId]);
  useEffect(() => { takingRef.current = taking; }, [taking]);
  useEffect(() => { saleRef.current = sale; }, [sale]);

  useEffect(() => {
    storesAPI.list().then(({ data }) => {
      const all = data.data || [];
      setStores(all);
      const mine = filterStores(all);
      if (mine.length && !storeId) setStoreId(mine[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!storeId) return;
    exchangesAPI.list({ store_id: storeId, limit: 50 })
      .then(({ data }) => setHistory(data.data || [])).catch(() => {});
  }, [storeId]);

  // ---------------------------------------------------------------- step 1
  const findSale = async (e) => {
    e?.preventDefault();
    if (!saleSearch.trim()) return;
    try {
      setSearchingSale(true);
      const { data } = await salesAPI.list({ search: saleSearch.trim(), store_id: storeId, limit: 25 });
      const found = (data.data || []).filter((s) => !s.voided_at);
      setSaleResults(found);
      // One unambiguous hit is the common case — a scanned receipt number — so it opens
      // straight away. More than one, and the choice belongs to the person, not to me.
      if (found.length === 1) openSale(found[0].id);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally {
      setSearchingSale(false);
    }
  };

  const openSale = async (id) => {
    try {
      const full = await salesAPI.getById(id);
      setSale(full.data.data);
      setReturning({});
      setSaleResults(null);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const restart = () => {
    setSale(null); setReturning({}); setTaking([]); setStock([]);
    setSaleResults(null); setSaleSearch(''); setReason(''); setLastScan(null);
  };

  // ---------------------------------------------------------------- step 3
  const searchStock = async (e) => {
    e?.preventDefault();
    try {
      setSearchingStock(true);
      const { data } = await inventoryAPI.list({
        store_id: storeId, status: 'in_stock', search: stockSearch, limit: 60,
      });
      setStock(data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally {
      setSearchingStock(false);
    }
  };

  const addTaking = useCallback((item) => {
    setTaking((prev) => (prev.some((x) => x.id === item.id) ? prev : [...prev, item]));
  }, []);

  const scanQueue = useRef(Promise.resolve());
  const runScanRef = useRef(null);

  const handleScan = useCallback((code) => {
    // Queued, never dropped: somebody running a scanner across a shelf fires faster
    // than a round trip completes.
    scanQueue.current = scanQueue.current
      .then(() => runScanRef.current?.(code))
      .catch(() => {});
    return scanQueue.current;
  }, []);

  const runScan = useCallback(async (code) => {
    if (!storeRef.current) { toast.error(t('barcode.select_store_first')); return; }

    // Before a sale is chosen, a scan is a way of FINDING one: the shoe in the
    // customer's hand still has its label, and that is faster than asking for a
    // receipt nobody keeps. Afterwards, a scan picks the replacement.
    if (!saleRef.current) {
      setSaleSearch(code);
      try {
        setSearchingSale(true);
        const { data } = await salesAPI.list({ search: code, store_id: storeRef.current, limit: 25 });
        const found = (data.data || []).filter((s) => !s.voided_at);
        setSaleResults(found);
        if (found.length === 1) await openSale(found[0].id);
        else if (found.length === 0) toast.error(t('exchange.scan_no_sale'));
      } catch {
        toast.error(t('common.failed'));
      } finally { setSearchingSale(false); }
      return;
    }

    try {
      const res = await barcodesAPI.lookup({
        code,
        store_id: storeRef.current,
        exclude_ids: takingRef.current.map((x) => x.id).join(','),
      });
      const { item } = res.data.data;
      addTaking(item);
      setLastScan({
        ok: true,
        text: [item.product_name, formatColor(item), formatSize(item, locale)].filter(Boolean).join(' · '),
      });
    } catch (err) {
      const msg = err.response?.data?.message || t('common.failed');
      setLastScan({ ok: false, text: msg });
      toast.error(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, addTaking]);

  useEffect(() => { runScanRef.current = runScan; }, [runScan]);
  useBarcodeScanner(handleScan, { enabled: canWrite && !showScanner });

  // ---------------------------------------------------------------- the money
  const returnedValue = useMemo(() => {
    if (!sale) return 0;
    const total = Number(sale.total_amount) || 0;
    const disc = Number(sale.discount_amount) || 0;
    return (sale.items || [])
      .filter((i) => returning[i.id])
      .reduce((n, i) => {
        const gross = Number(i.sale_price) || 0;
        // The same pro-rata allocation the server uses, so the figure on screen is the
        // one that will actually be credited.
        const share = total > 0 ? (disc * gross) / total : 0;
        return n + gross - share;
      }, 0);
  }, [sale, returning]);

  const newValue = useMemo(
    () => taking.reduce((n, i) => n + (Number(i.store_selling_price ?? i.default_selling_price) || 0), 0),
    [taking]
  );
  const difference = Math.round((newValue - returnedValue) * 100) / 100;

  const returnedCount = Object.values(returning).filter(Boolean).length;
  const step = !sale ? 1 : returnedCount === 0 ? 2 : 3;

  const submit = async () => {
    const returned = Object.keys(returning).filter((k) => returning[k]);
    if (returned.length === 0) { toast.error(t('exchange.pick_returned')); return; }
    if (taking.length === 0) { toast.error(t('exchange.pick_new')); return; }
    try {
      setBusy(true);
      const { data } = await exchangesAPI.create({
        store_id: storeId,
        original_sale_id: sale.id,
        returned: returned.map((id) => ({ sale_item_id: id })),
        new_items: taking.map((i) => ({ id: i.id })),
        settlement: Math.abs(difference) < 0.01 ? 'none' : settlement,
        reason: reason || null,
      });
      toast.success(t('exchange.done', { number: data.data.exchange_number }));
      restart();
      const list = await exchangesAPI.list({ store_id: storeId, limit: 50 });
      setHistory(list.data.data || []);
      setDetail(data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('exchange.title')}</h1>
          <p className="section-hint">{t('exchange.page_hint')}</p>
        </div>
        <select className="form-input" style={{ maxWidth: 240 }} value={storeId}
          data-testid="exchange-store" onChange={(e) => setStoreId(e.target.value)}>
          {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {canWrite && (
        <>
          {/* Where we are, and what happens next. The three steps are the shape of the
              job, so they are on screen rather than implied by which panel is empty. */}
          <ol className="exchange-steps" data-testid="exchange-steps">
            {[1, 2, 3].map((n) => (
              <li key={n} className={`exchange-step${step === n ? ' is-current' : ''}${step > n ? ' is-done' : ''}`}>
                <span className="exchange-step__n">{n}</span>
                <span>{t(`exchange.step_${n}`)}</span>
              </li>
            ))}
          </ol>

          {/* ------------------------------------------------- step 1: the sale */}
          {!sale ? (
            <div className="card">
              <h3>{t('exchange.step_1')}</h3>
              <p className="section-hint">{t('exchange.find_sale_hint')}</p>
              <form onSubmit={findSale} className="exchange-search">
                <input className="form-input" data-testid="exchange-sale-search"
                  placeholder={t('exchange.find_sale')}
                  value={saleSearch} onChange={(e) => setSaleSearch(e.target.value)} />
                <button className="btn btn-primary" type="submit" disabled={searchingSale}>
                  <HiOutlineMagnifyingGlass /> {t('common.search')}
                </button>
                <button className="btn btn-secondary" type="button" data-testid="exchange-scan-sale"
                  onClick={() => setShowScanner(true)}>
                  <HiOutlineQrCode /> {t('barcode.scan')}
                </button>
              </form>

              {saleResults !== null && (
                saleResults.length === 0 ? (
                  <p className="section-hint" data-testid="exchange-no-sales">{t('exchange.sale_not_found')}</p>
                ) : (
                  <div className="table-container">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('sales.sale_number')}</th><th>{t('common.date')}</th>
                          <th>{t('common.customer')}</th><th>{t('sales.items')}</th>
                          <th>{t('common.total')}</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {/* Every match, with enough on each row to tell them apart.
                            Picking one is a decision, not something a search does. */}
                        {saleResults.map((s) => (
                          <tr key={s.id} data-testid={`exchange-sale-${s.id}`}>
                            <td><strong>{s.sale_number}</strong></td>
                            <td>{new Date(s.created_at).toLocaleDateString()}</td>
                            <td>{s.customer_name || t('pos.walk_in')}</td>
                            {/* The products, not just how many. Somebody who searched
                                for "Nike" is choosing between receipts, and the product
                                is the only thing on this row they recognise. */}
                            <td>
                              {s.item_count ? (
                                <>
                                  <strong>{s.item_count}</strong>
                                  {s.item_products?.length > 0 && (
                                    <div className="exchange-sale-products">
                                      {s.item_products.join(', ')}
                                      {s.item_products_more > 0 ? ` +${s.item_products_more}` : ''}
                                    </div>
                                  )}
                                </>
                              ) : '—'}
                            </td>
                            <td>{money(s.final_amount)}</td>
                            <td>
                              <button className="btn btn-sm btn-primary"
                                data-testid={`exchange-pick-sale-${s.id}`}
                                onClick={() => openSale(s.id)}>
                                {t('common.select')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="exchange-grid">
              {/* --------------------------------------------- coming back */}
              <div className="card">
                <div className="exchange-panel-head">
                  <h3>{t('exchange.coming_back')}</h3>
                  <button className="btn btn-sm btn-secondary" data-testid="exchange-change-sale"
                    onClick={restart}>
                    <HiOutlineArrowLeft /> {t('exchange.another_sale')}
                  </button>
                </div>

                <p className="section-hint">
                  <strong>{sale.sale_number}</strong> · {new Date(sale.created_at).toLocaleDateString()}
                  {sale.customer_name ? ` · ${sale.customer_name}` : ` · ${t('pos.walk_in')}`}
                </p>

                <div className="exchange-lines" data-testid="exchange-sale-items">
                  {(sale.items || []).map((i) => {
                    const picked = Boolean(returning[i.id]);
                    const already = i.returned_at || i.is_returned;
                    return (
                      <button key={i.id} type="button"
                        className={`exchange-line${picked ? ' is-picked' : ''}${already ? ' is-disabled' : ''}`}
                        data-testid={`exchange-return-${i.id}`}
                        disabled={already}
                        onClick={() => setReturning((p) => ({ ...p, [i.id]: !p[i.id] }))}>
                        <ClickableImage src={i.image_url} thumbSrc={i.thumb_url}
                          alt={i.product_name} width={44} height={44} className="exchange-line__img" />
                        <span className="exchange-line__text">
                          <span className="exchange-line__name">{i.product_name}</span>
                          <span className="count-sub">
                            {[formatSize(i, locale), formatColor(i)].filter(Boolean).join(' • ')}
                          </span>
                          {already && <span className="count-sub">{t('exchange.already_returned')}</span>}
                        </span>
                        <span className="exchange-line__price">{money(i.sale_price)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* --------------------------------------------- going out */}
              <div className="card">
                <h3>{t('exchange.going_out')}</h3>
                <p className="section-hint">{t('exchange.going_out_hint')}</p>

                <form onSubmit={searchStock} className="exchange-search">
                  <input className="form-input" data-testid="exchange-stock-search"
                    placeholder={t('exchange.find_stock')}
                    value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} />
                  <button className="btn btn-primary" type="submit" disabled={searchingStock}>
                    <HiOutlineMagnifyingGlass /> {t('common.search')}
                  </button>
                  <button className="btn btn-secondary" type="button" data-testid="exchange-scan-stock"
                    onClick={() => setShowScanner(true)}>
                    <HiOutlineQrCode /> {t('barcode.scan')}
                  </button>
                </form>

                {lastScan && (
                  <div className={`exchange-scan-note ${lastScan.ok ? 'is-ok' : 'is-bad'}`}
                    data-testid="exchange-scan-note">
                    {lastScan.text}
                  </div>
                )}

                {/* A grid of cards with pictures, the way the till shows stock — the
                    same people, the same shoes, the same glance. */}
                <div className="exchange-stock-grid" data-testid="exchange-stock-grid">
                  {stock.map((i) => (
                    <button key={i.id} type="button" className="exchange-stock-card"
                      data-testid={`exchange-take-${i.id}`} onClick={() => addTaking(i)}>
                      <ClickableImage src={i.color_image_url} thumbSrc={i.color_image_thumb_url}
                        alt={i.product_name} width={64} height={64} className="exchange-stock-card__img" />
                      <span className="exchange-stock-card__name">{i.product_name}</span>
                      <span className="count-sub">
                        {[formatSize(i, locale), formatColor(i)].filter(Boolean).join(' • ')}
                      </span>
                      <strong>{money(i.store_selling_price ?? i.default_selling_price)}</strong>
                    </button>
                  ))}
                </div>

                {taking.length > 0 && (
                  <div className="exchange-lines" data-testid="exchange-taking">
                    {taking.map((i) => (
                      <div key={i.id} className="exchange-line is-picked">
                        <ClickableImage src={i.color_image_url} thumbSrc={i.color_image_thumb_url}
                          alt={i.product_name} width={44} height={44} className="exchange-line__img" />
                        <span className="exchange-line__text">
                          <span className="exchange-line__name">{i.product_name}</span>
                          <span className="count-sub">
                            {[formatSize(i, locale), formatColor(i)].filter(Boolean).join(' • ')}
                          </span>
                        </span>
                        <span className="exchange-line__price">
                          {money(i.store_selling_price ?? i.default_selling_price)}
                        </span>
                        <button className="btn btn-sm btn-danger"
                          data-testid={`exchange-untake-${i.id}`}
                          onClick={() => setTaking((p) => p.filter((x) => x.id !== i.id))}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --------------------------------------------- the difference */}
          {sale && (
            <div className="card exchange-summary" data-testid="exchange-summary">
              <div className="exchange-summary__figures">
                <div>
                  <span className="count-sub">{t('exchange.coming_back')}</span>
                  <strong>{money(returnedValue)}</strong>
                </div>
                <div>
                  <span className="count-sub">{t('exchange.going_out')}</span>
                  <strong>{money(newValue)}</strong>
                </div>
                <div>
                  {/* Said the way the customer experiences it. "Difference: -150" makes
                      somebody work out who owes whom while a queue builds. */}
                  <span className="count-sub">{t('exchange.difference')}</span>
                  <strong className={difference > 0 ? 'shift-over' : difference < 0 ? 'shift-bad' : 'shift-good'}
                    data-testid="exchange-difference">
                    {Math.abs(difference) < 0.01
                      ? t('exchange.even_swap')
                      : difference > 0
                        ? t('exchange.customer_pays', { amount: money(difference) })
                        : t('exchange.customer_refunded', { amount: money(-difference) })}
                  </strong>
                </div>
              </div>

              <div className="exchange-summary__controls">
                {Math.abs(difference) >= 0.01 && (
                  <select className="form-input" value={settlement} data-testid="exchange-settlement"
                    onChange={(e) => setSettlement(e.target.value)}>
                    {SETTLEMENTS.map((s) => (
                      <option key={s} value={s}>{t(`payment_methods.${s}`)}</option>
                    ))}
                  </select>
                )}
                <input className="form-input" placeholder={t('exchange.reason_optional')}
                  data-testid="exchange-reason"
                  value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="btn btn-primary" data-testid="exchange-submit"
                  disabled={busy || returnedCount === 0 || taking.length === 0}
                  onClick={submit}>
                  {t('exchange.complete')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {showScanner && (
        <Suspense fallback={null}>
          <BarcodeScannerModal
            onDetected={(code) => { setShowScanner(false); handleScan(code); }}
            onClose={() => setShowScanner(false)}
          />
        </Suspense>
      )}

      {/* --------------------------------------------- history */}
      <div className="card" style={{ marginTop: 'var(--spacing-lg)' }}>
        <h3>{t('exchange.recent')}</h3>
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>#</th><th>{t('common.date')}</th><th>{t('common.store')}</th>
                <th>{t('exchange.difference')}</th><th>{t('common.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr><td colSpan={5} className="section-hint">{t('exchange.none_yet')}</td></tr>
              )}
              {history.map((x) => (
                <tr key={x.id} data-testid={`exchange-row-${x.id}`}
                  onClick={() => setDetail(x)} style={{ cursor: 'pointer' }}>
                  <td><strong>{x.exchange_number}</strong></td>
                  <td>{new Date(x.created_at).toLocaleString()}</td>
                  <td>{x.store_name}</td>
                  <td>{money(x.difference)}</td>
                  <td>{x.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2>{detail.exchange_number}</h2>
            <p className="section-hint">{t('exchange.detail_hint')}</p>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setDetail(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
