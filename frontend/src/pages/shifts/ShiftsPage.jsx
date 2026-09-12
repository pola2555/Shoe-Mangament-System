import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { shiftsAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import DenominationCounter from '../../components/shifts/DenominationCounter';
import '../products/Products.css';
import './Shifts.css';

/**
 * The till drawer: starting a shift, and counting it at the end.
 *
 * THE ONE RULE THIS SCREEN ENFORCES BY DESIGN
 *
 * The counted figure is never pre-filled with the expected one, and the expected figure
 * is hidden until a count has been typed. A cash-up that shows you the answer first is
 * not a count — it is a rubber stamp, and it would report a perfect drawer every night
 * while money walked out of it.
 *
 * So: type what you found, THEN see whether it matches.
 */

const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString();

export default function ShiftsPage() {
  const { t } = useTranslation();
  const { filterStores, hasPermission } = useAuth();
  const canRun = hasPermission('shifts', 'write');
  const canMoveCash = hasPermission('cash_drawer', 'write');

  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loose, setLoose] = useState(null);

  const [openForm, setOpenForm] = useState({ opening_float: '', notes: '' });
  const [closeForm, setCloseForm] = useState({ counted_cash: '', notes: '' });
  // Typing a total is the quick path; counting note by note is the accurate one.
  const [countMode, setCountMode] = useState('total');
  // Correcting a count that was typed wrong, without reopening the shift for trading.
  const [recount, setRecount] = useState(null);
  const [recountForm, setRecountForm] = useState({ counted_cash: '', reason: '' });
  const [showClose, setShowClose] = useState(false);
  const [moveForm, setMoveForm] = useState({ type: 'owner_take', amount: '', reason: '' });
  const [showMove, setShowMove] = useState(false);

  const myStores = useMemo(() => filterStores(stores || []), [stores, filterStores]);

  useEffect(() => {
    storesAPI.list().then(({ data }) => {
      const list = data.data || [];
      setStores(list);
      const mine = filterStores(list);
      if (mine.length && !storeId) setStoreId(mine[0].id);
    }).catch(() => {});
    // filterStores is stable enough here; re-running on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!storeId) { setLoading(false); return; }
    try {
      setLoading(true);
      const [cur, list, unassigned] = await Promise.all([
        shiftsAPI.current(storeId),
        shiftsAPI.list({ store_id: storeId, limit: 50 }),
        shiftsAPI.unassignedCash({ store_id: storeId }).catch(() => ({ data: { data: null } })),
      ]);
      setCurrent(cur.data.data);
      setHistory(list.data.data || []);
      setLoose(unassigned.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => { load(); }, [load]);

  const openShift = async (e) => {
    e.preventDefault();
    try {
      await shiftsAPI.open({
        store_id: storeId,
        opening_float: Number(openForm.opening_float),
        notes: openForm.notes,
      });
      toast.success(t('shifts.opened'));
      setOpenForm({ opening_float: '', notes: '' });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const closeShift = async (e) => {
    e.preventDefault();
    try {
      const { data } = await shiftsAPI.close(current.id, {
        counted_cash: Number(closeForm.counted_cash),
        notes: closeForm.notes,
      });
      const diff = Number(data.data.difference) || 0;
      if (Math.abs(diff) < 0.01) toast.success(t('shifts.balanced'));
      else if (diff < 0) toast.error(t('shifts.short', { amount: money(-diff) }));
      else toast(t('shifts.over', { amount: money(diff) }));
      setShowClose(false);
      setCloseForm({ counted_cash: '', notes: '' });
      setDetail(data.data);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const addMovement = async (e) => {
    e.preventDefault();
    try {
      await shiftsAPI.addMovement({
        store_id: storeId,
        type: moveForm.type,
        amount: Number(moveForm.amount),
        reason: moveForm.reason,
      });
      toast.success(t('shifts.movement_recorded'));
      setShowMove(false);
      setMoveForm({ type: 'owner_take', amount: '', reason: '' });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const openDetail = async (id) => {
    try {
      const { data } = await shiftsAPI.getById(id);
      setDetail(data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  const p = current?.position;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('shifts.title')}</h1>
          <p className="section-hint">{t('shifts.page_hint')}</p>
        </div>
        <select className="form-input shift-store" value={storeId}
          onChange={(e) => setStoreId(e.target.value)}>
          {myStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {loose?.amount > 0 && (
        <div className="shift-warning" data-testid="unassigned-cash">
          {t('shifts.unassigned_warning', { amount: money(loose.amount), n: loose.payments })}
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <>
          {/* ------------------------------------------------ the open drawer */}
          {current ? (
            <div className="card shift-open" data-testid="shift-open">
              <div className="shift-open-head">
                <div>
                  <h2>{current.shift_number}</h2>
                  <p className="section-hint">
                    {t('shifts.opened_by', {
                      who: current.opened_by_name || '—',
                      when: new Date(current.opened_at).toLocaleString(),
                    })}
                  </p>
                </div>
                <div className="shift-open-actions">
                  {canMoveCash && (
                    <button className="btn btn-secondary" onClick={() => setShowMove(true)}>
                      {t('shifts.take_money')}
                    </button>
                  )}
                  {canRun && (
                    <button className="btn btn-primary" data-testid="shift-close-open"
                      onClick={() => setShowClose(true)}>
                      {t('shifts.close_and_count')}
                    </button>
                  )}
                </div>
              </div>

              <div className="shift-grid">
                <Cell label={t('shifts.opening_float')} value={money(p.opening_float)} />
                <Cell label={t('shifts.cash_sales')} value={money(p.cash_sales)} sub={`${p.cash_sales_count} ${t('shifts.payments')}`} good />
                <Cell label={t('shifts.cash_refunds')} value={`-${money(p.cash_refunds)}`} sub={`${p.cash_refunds_count}`} bad={p.cash_refunds > 0} />
                <Cell label={t('shifts.drawer_expenses')} value={`-${money(p.drawer_expenses)}`} sub={`${p.drawer_expenses_count}`} bad={p.drawer_expenses > 0} />
                <Cell label={t('shifts.taken_out')} value={`-${money(p.taken_out)}`} bad={p.taken_out > 0} />
                <Cell label={t('shifts.expected_now')} value={money(p.expected_cash)} strong />
              </div>
              <p className="section-hint">
                {t('shifts.non_cash_note', { amount: money(p.non_cash_taken) })}
              </p>
            </div>
          ) : (
            <div className="card shift-closed-state">
              <h2>{t('shifts.no_open_shift')}</h2>
              <p className="section-hint">{t('shifts.no_open_hint')}</p>
              {canRun && (
                <form onSubmit={openShift} className="shift-open-form">
                  <div className="form-group">
                    <label className="form-label">{t('shifts.count_the_float')} *</label>
                    <input type="number" step="0.01" min="0" className="form-input" required
                      data-testid="shift-float"
                      value={openForm.opening_float}
                      onChange={(e) => setOpenForm({ ...openForm, opening_float: e.target.value })} />
                    <div className="form-hint">{t('shifts.float_hint')}</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('common.notes')}</label>
                    <input className="form-input" value={openForm.notes}
                      onChange={(e) => setOpenForm({ ...openForm, notes: e.target.value })} />
                  </div>
                  <button className="btn btn-primary" type="submit" data-testid="shift-open-submit">
                    {t('shifts.start_shift')}
                  </button>
                </form>
              )}
            </div>
          )}

          {/* ------------------------------------------------ history */}
          <div className="card">
            <h3>{t('shifts.history')}</h3>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th><th>{t('shifts.opened')}</th><th>{t('shifts.closed')}</th>
                    <th>{t('shifts.opening_float')}</th><th>{t('shifts.expected')}</th>
                    <th>{t('shifts.counted')}</th><th>{t('shifts.difference')}</th><th>{t('common.status')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 && (
                    <tr><td colSpan={9} className="section-hint">{t('shifts.no_shifts')}</td></tr>
                  )}
                  {history.map((s) => {
                    const diff = Number(s.difference);
                    return (
                      <tr key={s.id} className="product-row" data-testid={`shift-row-${s.id}`}
                        onClick={() => openDetail(s.id)}>
                        <td><strong>{s.shift_number}</strong></td>
                        <td>{new Date(s.opened_at).toLocaleString()}</td>
                        <td>{s.closed_at ? new Date(s.closed_at).toLocaleString() : '—'}</td>
                        <td>{money(s.opening_float)}</td>
                        <td>{s.expected_cash != null ? money(s.expected_cash) : '—'}</td>
                        <td>
                          {s.counted_cash != null ? money(s.counted_cash) : '—'}
                          {/* A corrected count says so, with what it was first. A
                              recount that looked identical to an accurate count would
                              make "we were short, then we weren't" unanswerable. */}
                          {s.recount_count > 0 && (
                            <div className="count-sub" data-testid={`shift-recounted-${s.id}`}>
                              {t('shifts.was_counted', { amount: money(s.counted_cash_original) })}
                            </div>
                          )}
                        </td>
                        <td className={diff < -0.001 ? 'shift-bad' : diff > 0.001 ? 'shift-over' : ''}>
                          {s.difference != null ? money(s.difference) : '—'}
                        </td>
                        <td>
                          <span className={`badge ${s.status === 'open' ? 'badge-warning' : 'badge-success'}`}>
                            {t(`shifts.status_${s.status}`)}
                          </span>
                        </td>
                        <td>
                          {s.status === 'closed' && canRun && (
                            <button className="btn btn-sm btn-secondary"
                              data-testid={`shift-recount-${s.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRecount(s);
                                setRecountForm({ counted_cash: '', reason: '' });
                              }}>
                              {t('shifts.recount')}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------------------------ close & count */}
      {showClose && current && (
        <div className="modal-overlay" onClick={() => setShowClose(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2>{t('shifts.close_and_count')}</h2>
            {/* The expected figure is deliberately NOT shown here. See the file header. */}
            <p className="section-hint">{t('shifts.count_first_hint')}</p>
            <form onSubmit={closeShift} className="product-form">
              <div className="form-group">
                <label className="form-label">{t('shifts.what_is_in_the_drawer')} *</label>

                {/* Two ways to arrive at the same number. Counting note by note is
                    offered because the total is otherwise mental arithmetic done at
                    the end of a long day, and a slip there looks exactly like missing
                    money. */}
                <div className="shift-count-modes">
                  <button type="button" data-testid="count-mode-total"
                    className={`btn btn-sm ${countMode === 'total' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setCountMode('total')}>
                    {t('shifts.type_total')}
                  </button>
                  <button type="button" data-testid="count-mode-denoms"
                    className={`btn btn-sm ${countMode === 'denoms' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setCountMode('denoms')}>
                    {t('shifts.count_notes')}
                  </button>
                </div>

                {countMode === 'denoms' && (
                  <DenominationCounter
                    value={closeForm.counted_cash}
                    onChange={(v) => setCloseForm((f) => ({ ...f, counted_cash: v === '' ? '' : String(v) }))}
                  />
                )}

                <input type="number" step="0.01" min="0" className="form-input" required autoFocus
                  data-testid="shift-counted"
                  style={{ marginTop: countMode === 'denoms' ? 'var(--spacing-sm)' : 0 }}
                  value={closeForm.counted_cash}
                  onChange={(e) => setCloseForm({ ...closeForm, counted_cash: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.notes')}</label>
                <input className="form-input" value={closeForm.notes}
                  onChange={(e) => setCloseForm({ ...closeForm, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowClose(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" data-testid="shift-close-submit">
                  {t('shifts.close_shift')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ correct a count */}
      {recount && (
        <div className="modal-overlay" onClick={() => setRecount(null)}>
          <div className="modal-content card" data-testid="recount-dialog"
            onClick={(e) => e.stopPropagation()}>
            <h2>{t('shifts.recount_title', { number: recount.shift_number })}</h2>
            <p className="section-hint">{t('shifts.recount_hint')}</p>

            {/* Shown here, unlike at close: the shift is already balanced against a
                figure, so hiding it would just make correcting a typo guesswork. */}
            <div className="confirm-facts">
              <div className="confirm-fact">
                <span>{t('shifts.expected')}</span>
                <strong>{money(recount.expected_cash)}</strong>
              </div>
              <div className="confirm-fact">
                <span>{t('shifts.counted_before')}</span>
                <strong>{money(recount.counted_cash)}</strong>
              </div>
            </div>

            <form className="product-form" onSubmit={async (e) => {
              e.preventDefault();
              try {
                await shiftsAPI.recount(recount.id, {
                  counted_cash: Number(recountForm.counted_cash),
                  reason: recountForm.reason,
                });
                toast.success(t('shifts.recounted'));
                setRecount(null);
                setRecountForm({ counted_cash: '', reason: '' });
                await load();
              } catch (err) {
                toast.error(err.response?.data?.message || t('common.failed'));
              }
            }}>
              <div className="form-group">
                <label className="form-label">{t('shifts.recounted_amount')} *</label>
                <DenominationCounter
                  value={recountForm.counted_cash}
                  onChange={(v) => setRecountForm((f) => ({ ...f, counted_cash: v === '' ? '' : String(v) }))}
                />
                <input type="number" step="0.01" min="0" className="form-input" required
                  data-testid="recount-amount"
                  style={{ marginTop: 'var(--spacing-sm)' }}
                  value={recountForm.counted_cash}
                  onChange={(e) => setRecountForm({ ...recountForm, counted_cash: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.reason')}</label>
                <input className="form-input" data-testid="recount-reason"
                  placeholder={t('shifts.recount_reason_placeholder')}
                  value={recountForm.reason}
                  onChange={(e) => setRecountForm({ ...recountForm, reason: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setRecount(null)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" data-testid="recount-submit">
                  {t('shifts.save_recount')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ take money out */}
      {showMove && (
        <div className="modal-overlay" onClick={() => setShowMove(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2>{t('shifts.take_money')}</h2>
            <form onSubmit={addMovement} className="product-form">
              <div className="form-group">
                <label className="form-label">{t('common.type')}</label>
                <select className="form-input" value={moveForm.type}
                  onChange={(e) => setMoveForm({ ...moveForm, type: e.target.value })}>
                  {['owner_take', 'drop', 'float_in', 'correction'].map((ty) => (
                    <option key={ty} value={ty}>{t(`shifts.move_${ty}`)}</option>
                  ))}
                </select>
                <div className="form-hint">{t(`shifts.move_${moveForm.type}_hint`)}</div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.amount')} *</label>
                <input type="number" step="0.01" min="0.01" className="form-input" required
                  data-testid="movement-amount"
                  value={moveForm.amount}
                  onChange={(e) => setMoveForm({ ...moveForm, amount: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('shifts.reason')}</label>
                <input className="form-input" value={moveForm.reason}
                  onChange={(e) => setMoveForm({ ...moveForm, reason: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowMove(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">{t('common.save')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ one shift */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card shift-detail" onClick={(e) => e.stopPropagation()}>
            <h2>{detail.shift_number}</h2>
            <p className="section-hint">
              {detail.store_name} · {new Date(detail.opened_at).toLocaleString()}
              {detail.closed_at && ` → ${new Date(detail.closed_at).toLocaleString()}`}
            </p>

            <div className="shift-grid">
              <Cell label={t('shifts.opening_float')} value={money(detail.position.opening_float)} />
              <Cell label={t('shifts.cash_sales')} value={money(detail.position.cash_sales)} good />
              <Cell label={t('shifts.cash_refunds')} value={`-${money(detail.position.cash_refunds)}`} />
              <Cell label={t('shifts.drawer_expenses')} value={`-${money(detail.position.drawer_expenses)}`} />
              <Cell label={t('shifts.taken_out')} value={`-${money(detail.position.taken_out)}`} />
              <Cell label={t('shifts.expected')} value={money(detail.position.expected_cash)} strong />
              {detail.status === 'closed' && (
                <>
                  <Cell label={t('shifts.counted')} value={money(detail.counted_cash)} strong />
                  <Cell label={t('shifts.difference')} value={money(detail.difference)}
                    bad={Number(detail.difference) < -0.001} strong />
                </>
              )}
            </div>

            {detail.sellers?.length > 0 && (
              <>
                <h3>{t('shifts.who_sold')}</h3>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>{t('shifts.seller')}</th><th>{t('common.quantity')}</th><th>{t('common.total')}</th></tr></thead>
                    <tbody>
                      {detail.sellers.map((s, i) => (
                        <tr key={i}><td>{s.seller}</td><td>{s.sales_count}</td><td>{money(s.revenue)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {detail.movements?.length > 0 && (
              <>
                <h3>{t('shifts.movements')}</h3>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>{t('common.type')}</th><th>{t('common.amount')}</th><th>{t('shifts.reason')}</th><th>{t('common.by')}</th></tr></thead>
                    <tbody>
                      {detail.movements.map((m) => (
                        <tr key={m.id}>
                          <td>{t(`shifts.move_${m.type}`)}</td>
                          <td>{money(m.amount)}</td>
                          <td>{m.reason || '—'}</td>
                          <td>{m.created_by_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {detail.expenses?.length > 0 && (
              <>
                <h3>{t('shifts.expenses_from_drawer')}</h3>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>{t('common.description')}</th><th>{t('common.amount')}</th><th>{t('common.by')}</th></tr></thead>
                    <tbody>
                      {detail.expenses.map((e) => (
                        <tr key={e.id}>
                          <td>{e.description}</td><td>{money(e.amount)}</td><td>{e.created_by_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, sub, good, bad, strong }) {
  return (
    <div className={`shift-cell ${strong ? 'shift-cell--strong' : ''}`}>
      <div className="shift-cell-label">{label}</div>
      <div className={`shift-cell-value ${good ? 'shift-good' : ''} ${bad ? 'shift-bad' : ''}`}>{value}</div>
      {sub && <div className="shift-cell-sub">{sub}</div>}
    </div>
  );
}
