import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { stockIntakesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../../components/common/ConfirmDialog';
import '../products/Products.css';
import './StockIntake.css';

/**
 * Stock entered without a purchase invoice.
 *
 * Three things live on this page, because they are three views of one problem:
 *
 *  1. THE SHEETS — what was entered, when, by whom, and whether it has been posted.
 *  2. WHAT IS STILL A GUESS — products whose cost was estimated and has not yet been
 *     confirmed by a real invoice. Some of it never will be: stock that is discontinued
 *     is never bought again, so its guess is permanent and this is the only place it
 *     can be improved by hand.
 *  3. CORRECTIONS — every time a real invoice replaced a guess, what it was, what it
 *     became, and a button to undo it. The invoiced cost is TODAY's cost and the stock
 *     may have been bought a year ago at a different price, so an automatic correction
 *     can be worse than the guess it replaced. Automatic is only safe because it is
 *     reversible.
 */

const fmt = (v) => `${(Math.round((Number(v) || 0) * 100) / 100).toLocaleString()} EGP`;
const day = (v) => (v ? String(v).slice(0, 10) : '—');

export default function StockIntakesPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { filterStores, hasPermission } = useAuth();
  const canWrite = hasPermission('stock_intake', 'write');

  const [tab, setTab] = useState('sheets');
  const [sheets, setSheets] = useState([]);
  const [estimated, setEstimated] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');

  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = { ...(storeId ? { store_id: storeId } : {}), ...(status ? { status } : {}) };
      const [list, est, corr] = await Promise.all([
        stockIntakesAPI.list(params),
        stockIntakesAPI.estimated(storeId ? { store_id: storeId } : {}),
        stockIntakesAPI.corrections({ limit: 50 }),
      ]);
      setSheets(list.data.data || []);
      setEstimated(est.data.data || []);
      setCorrections(corr.data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [storeId, status, t]);

  useEffect(() => { load(); }, [load]);

  // The auth context exposes filterStores but not the list itself; every page fetches
  // its own and filters it through the same rule.
  useEffect(() => {
    storesAPI.list().then(({ data }) => setStores(data.data || [])).catch(() => {});
  }, []);

  const startSheet = async () => {
    const store = storeId || myStores[0]?.id;
    if (!store) { toast.error(t('intake.no_store')); return; }
    try {
      const { data } = await stockIntakesAPI.create({
        store_id: store,
        reason: 'opening',
        intake_date: new Date().toISOString().slice(0, 10),
        lines: [],
      });
      navigate(`/stock-intakes/${data.data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const recost = async (row) => {
    const value = await confirm.prompt({
      title: t('intake.recost_title'),
      message: t('intake.recost_prompt', { product: row.product_code, pairs: row.pairs }),
      label: t('intake.unit_cost'),
      type: 'number',
      min: '0',
      initial: String(row.max_cost),
      confirmText: t('common.save'),
    });
    if (value === null) return;
    const cost = Number(value);
    if (!Number.isFinite(cost) || cost < 0) { toast.error(t('intake.cost_required')); return; }
    // Asked plainly, because the answer decides whether a future invoice may overwrite
    // this number: "known" retires it from healing for good.
    const stillGuess = await confirm({
      title: t('intake.recost_still_guess_title'),
      message: t('intake.recost_still_guess'),
      confirmText: t('intake.still_a_guess'),
      cancelText: t('intake.this_is_the_real_cost'),
    });
    try {
      await stockIntakesAPI.recost(row.product_id, { unit_cost: cost, still_estimated: stillGuess });
      toast.success(t('intake.recost_done'));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const undo = async (batchId) => {
    if (!await confirm({
      title: t('intake.undo_title'),
      message: t('intake.undo_confirm'),
      danger: true,
      confirmText: t('intake.undo'),
    })) return;
    try {
      await stockIntakesAPI.revertCorrection(batchId);
      toast.success(t('intake.undo_done'));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const totalGuessedPairs = estimated.reduce((n, r) => n + r.pairs, 0);
  const totalGuessedSold = estimated.reduce((n, r) => n + r.sold_pairs, 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('intake.title')}</h1>
          <p className="section-hint">{t('intake.page_hint')}</p>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={startSheet}>{`+ ${t('intake.new_sheet')}`}</button>
        )}
      </div>

      <div className="intake-filters">
        <select className="form-input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          <option value="">{t('common.all_stores')}</option>
          {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {tab === 'sheets' && (
          <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {['draft', 'posted', 'cancelled'].map((s) => (
              <option key={s} value={s}>{t(`intake.status_${s}`)}</option>
            ))}
          </select>
        )}
      </div>

      {totalGuessedPairs > 0 && (
        <div className="intake-banner">
          {t('intake.banner', { pairs: totalGuessedPairs, sold: totalGuessedSold })}
        </div>
      )}

      <div className="tabs">
        {['sheets', 'estimated', 'corrections'].map((key) => (
          <button key={key} className={`tab ${tab === key ? 'tab--active' : ''}`}
            data-testid={`intake-tab-${key}`} onClick={() => setTab(key)}>
            {t(`intake.tab_${key}`)}
          </button>
        ))}
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="tab-content">
          {tab === 'sheets' && (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th><th>{t('common.date')}</th><th>{t('common.store')}</th>
                    <th>{t('intake.reason')}</th><th>{t('common.quantity')}</th>
                    <th>{t('common.value')}</th><th>{t('common.status')}</th><th>{t('common.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sheets.length === 0 && (
                    <tr><td colSpan={8} className="section-hint">{t('intake.no_sheets')}</td></tr>
                  )}
                  {sheets.map((s) => (
                    <tr key={s.id} className="product-row" data-testid={`intake-row-${s.id}`}
                      onClick={() => navigate(`/stock-intakes/${s.id}`)}>
                      <td><strong>{s.intake_number}</strong></td>
                      <td>{day(s.intake_date)}</td>
                      <td>{s.store_name}</td>
                      <td>{t(`intake.reason_${s.reason}`)}</td>
                      <td>
                        {s.total_units}
                        {s.estimated_units > 0 && (
                          <span className="badge badge-warning" style={{ marginInlineStart: 6 }}>
                            {t('intake.n_guessed', { n: s.estimated_units })}
                          </span>
                        )}
                      </td>
                      <td>{fmt(s.total_value)}</td>
                      <td>
                        <span className={`badge ${s.status === 'posted' ? 'badge-success'
                          : s.status === 'cancelled' ? 'badge-danger' : 'badge-warning'}`}>
                          {t(`intake.status_${s.status}`)}
                        </span>
                      </td>
                      <td>{s.created_by_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'estimated' && (
            <>
              <p className="section-hint">{t('intake.estimated_hint')}</p>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.product')}</th><th>{t('intake.pairs_guessed')}</th>
                      <th>{t('intake.already_sold')}</th><th>{t('intake.cost_range')}</th>
                      <th>{t('common.value')}</th>{canWrite && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {estimated.length === 0 && (
                      <tr><td colSpan={6} className="section-hint">{t('intake.nothing_guessed')}</td></tr>
                    )}
                    {estimated.map((r) => (
                      <tr key={r.product_id}>
                        <td><strong>{r.product_code}</strong><br />{r.product_name}</td>
                        <td>{r.pairs}</td>
                        <td>
                          {r.sold_pairs > 0
                            ? <span className="badge badge-warning">{r.sold_pairs}</span>
                            : '—'}
                        </td>
                        <td>{r.min_cost === r.max_cost ? fmt(r.min_cost) : `${fmt(r.min_cost)} – ${fmt(r.max_cost)}`}</td>
                        <td>{fmt(r.guessed_value)}</td>
                        {canWrite && (
                          <td>
                            <button className="btn btn-sm btn-secondary" onClick={() => recost(r)}>
                              {t('intake.set_cost')}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'corrections' && (
            <>
              <p className="section-hint">{t('intake.corrections_hint')}</p>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th><th>{t('common.product')}</th>
                      <th>{t('intake.was')}</th><th>{t('intake.now')}</th>
                      <th>{t('intake.pairs')}</th><th>{t('intake.already_sold')}</th>
                      <th>{t('intake.caused_by')}</th>{canWrite && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.length === 0 && (
                      <tr><td colSpan={8} className="section-hint">{t('intake.no_corrections')}</td></tr>
                    )}
                    {corrections.map((c) => (
                      <tr key={c.batch_id} style={{ opacity: c.reverted ? 0.5 : 1 }}>
                        <td>{day(c.applied_at)}</td>
                        <td><strong>{c.product_code}</strong><br />{c.product_name}</td>
                        <td>{c.old_cost_min === c.old_cost_max
                          ? fmt(c.old_cost_min)
                          : `${fmt(c.old_cost_min)} – ${fmt(c.old_cost_max)}`}</td>
                        <td><strong>{fmt(c.new_cost)}</strong></td>
                        <td>{c.pairs}</td>
                        <td>{c.sold_pairs > 0
                          ? <span className="badge badge-warning">{c.sold_pairs}</span>
                          : '—'}</td>
                        <td>{c.source_invoice_number || '—'}</td>
                        {canWrite && (
                          <td>
                            {c.reverted
                              ? <span className="badge">{t('intake.undone')}</span>
                              : <button className="btn btn-sm btn-danger" onClick={() => undo(c.batch_id)}>
                                  {t('intake.undo')}
                                </button>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
