import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { discountsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import ClickableImage from '../../components/common/ClickableImage';
import { formatSize, formatColor } from '../../utils/variantFormat';
import '../products/Products.css';
import '../shifts/Shifts.css';
import './Approvals.css';

/**
 * THE MANAGER'S SIDE OF THE COUNTER.
 *
 * Two questions arrive here, and they are different questions:
 *
 *   DISCOUNT   — may I give away some margin?
 *   PAY LATER  — may this customer take the goods and owe us?
 *
 * They share a screen because they share a moment: a cashier is standing at a till with
 * a customer waiting, and the answer has to arrive quickly. They do not share a
 * permission, because a shop may well trust somebody with the first and not the second.
 *
 * WHAT CHANGED, AND WHY
 *
 * The old version showed a row per request with a product CODE and two numbers. That is
 * not enough to answer with. Somebody deciding whether 100 off is reasonable is usually
 * not the person holding the shoe, so this now shows the goods — picture, size, colour,
 * price — the way the customer is seeing them at the counter.
 *
 * And it shows the floor. A discount that takes the sale under what the items are
 * allowed to sell for is permitted, because the owner asked for it to be, but never by
 * accident: the server refuses the first attempt and names both numbers, and this
 * screen shows the shortfall before the button is pressed.
 */

const money = (v) => (Math.round((Number(v) || 0) * 100) / 100)
  .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ApprovalsPage() {
  const { t, locale } = useTranslation();
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();

  const canDecideDiscount = hasPermission('discount_approval', 'write');
  const canDecideCredit = hasPermission('credit_approval', 'write');

  // A notification links straight to the request it is about, so the tab and the
  // highlighted row both come from the URL rather than from wherever the user last was.
  const kind = params.get('tab') === 'credit' ? 'credit' : 'discount';
  const highlight = params.get('request');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('pending');
  const [deciding, setDeciding] = useState(null);
  const [form, setForm] = useState({ amount: '', note: '' });
  const [belowMin, setBelowMin] = useState(null);
  const [saving, setSaving] = useState(false);

  const canDecide = kind === 'credit' ? canDecideCredit : canDecideDiscount;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await discountsAPI.list({ status: status || undefined, kind, limit: 100 });
      setRows(data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [status, kind, t]);

  useEffect(() => { load(); }, [load]);

  const setTab = (next) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    p.delete('request');
    setParams(p, { replace: true });
  };

  const openDecision = (r) => {
    setDeciding(r);
    setBelowMin(null);
    setForm({
      amount: String(kind === 'credit' ? r.requested_credit : r.requested_discount),
      note: '',
    });
  };

  /**
   * What the sale comes to if this manager approves the amount currently typed, and
   * whether that is under the floor. Recomputed as they type, because the whole point
   * is to see it BEFORE deciding — the server's refusal is the backstop, not the UI.
   */
  const preview = useMemo(() => {
    if (!deciding) return null;
    const total = Number(deciding.cart_total) || 0;
    const floor = Number(deciding.min_total) || 0;
    const amount = form.amount === '' ? 0 : Number(form.amount) || 0;
    if (kind === 'credit') {
      return { total, floor, amount, after: total, unpaid: amount, under: false, shortfall: 0 };
    }
    const after = Math.round((total - amount) * 100) / 100;
    return {
      total, floor, amount, after,
      under: floor > 0 && after < floor,
      shortfall: Math.round(Math.max(0, floor - after) * 100) / 100,
    };
  }, [deciding, form.amount, kind]);

  const decide = async (approve, acknowledge = false) => {
    try {
      setSaving(true);
      await discountsAPI.decide(deciding.id, {
        approve,
        amount: approve && form.amount !== '' ? Number(form.amount) : null,
        note: form.note,
        acknowledge_below_min: acknowledge,
      });
      toast.success(approve ? t('discount.you_approved') : t('discount.you_rejected'));
      setDeciding(null);
      setBelowMin(null);
      setForm({ amount: '', note: '' });
      await load();
    } catch (err) {
      // 409 with details means "this goes under the floor, say so again". The dialog
      // stays open and grows a confirmation rather than throwing a toast and losing
      // what was typed.
      const details = err.response?.data?.details;
      if (err.response?.status === 409 && details?.below_min) {
        setBelowMin(details);
      } else {
        toast.error(err.response?.data?.message || t('common.failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = (s) => (s === 'approved' ? 'badge-success'
    : s === 'rejected' ? 'badge-danger'
      : s === 'used' ? 'badge-info'
        : s === 'cancelled' ? 'badge-secondary' : 'badge-warning');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {kind === 'credit' ? t('credit.queue_title') : t('discount.queue_title')}
          </h1>
          <p className="section-hint">
            {kind === 'credit' ? t('credit.queue_hint') : t('discount.queue_hint')}
          </p>
        </div>
        <select className="form-input" style={{ maxWidth: 220 }} value={status}
          data-testid="approvals-status"
          onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">{t('discount.status_pending')}</option>
          <option value="approved">{t('discount.status_approved')}</option>
          <option value="rejected">{t('discount.status_rejected')}</option>
          <option value="used">{t('discount.status_used')}</option>
          <option value="">{t('common.all')}</option>
        </select>
      </div>

      <div className="tabs">
        <button className={`tab ${kind === 'discount' ? 'tab--active' : ''}`}
          data-testid="approvals-tab-discount" onClick={() => setTab('discount')}>
          {t('discount.tab')}
        </button>
        <button className={`tab ${kind === 'credit' ? 'tab--active' : ''}`}
          data-testid="approvals-tab-credit" onClick={() => setTab('credit')}>
          {t('credit.tab')}
        </button>
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="approval-list" data-testid="approval-list">
          {rows.length === 0 && (
            <div className="card section-hint" data-testid="approvals-empty">
              {kind === 'credit' ? t('credit.queue_empty') : t('discount.queue_empty')}
            </div>
          )}

          {rows.map((r) => {
            const asked = Number(kind === 'credit' ? r.requested_credit : r.requested_discount) || 0;
            const total = Number(r.cart_total) || 0;
            const pct = total > 0 ? Math.round((asked / total) * 1000) / 10 : 0;
            const floor = Number(r.min_total) || 0;
            const wouldBeUnder = kind === 'discount' && floor > 0 && (total - asked) < floor;

            return (
              <div key={r.id}
                className={`card approval-card${highlight === r.id ? ' approval-card--highlight' : ''}`}
                data-testid={`approval-row-${r.id}`}>
                <div className="approval-card__head">
                  <div>
                    <strong>{r.request_number}</strong>
                    <span className={`badge ${statusBadge(r.status)}`} style={{ marginInlineStart: 8 }}>
                      {t(`discount.status_${r.status}`)}
                    </span>
                    <div className="count-sub">
                      {r.requested_by_name || '—'} · {r.store_name} ·{' '}
                      {new Date(r.created_at).toLocaleString()}
                    </div>
                    {r.customer_name && (
                      <div className="count-sub">{t('common.customer')}: <strong>{r.customer_name}</strong></div>
                    )}
                  </div>

                  <div className="approval-card__figures">
                    <div>
                      <span className="count-sub">{t('discount.cart')}</span>
                      <strong>{money(total)}</strong>
                    </div>
                    <div>
                      <span className="count-sub">
                        {kind === 'credit' ? t('credit.unpaid') : t('discount.asked_for')}
                      </span>
                      <strong className={pct >= 25 ? 'shift-bad' : pct >= 10 ? 'shift-over' : ''}>
                        {money(asked)} <small>({pct}%)</small>
                      </strong>
                    </div>
                    {/* The floor is what turns "is 100 off reasonable?" into a question
                        with an answer. Only shown when the request would breach it. */}
                    {wouldBeUnder && (
                      <div data-testid={`approval-below-min-${r.id}`}>
                        <span className="count-sub">{t('discount.min_total')}</span>
                        <strong className="shift-bad">{money(floor)}</strong>
                      </div>
                    )}
                  </div>
                </div>

                {r.reason && <p className="approval-card__reason"><em>{r.reason}</em></p>}

                {/* The goods. A code and a number is not something anyone can judge. */}
                <div className="approval-card__items">
                  {(r.cart || []).map((line) => (
                    <div key={line.id} className="approval-item" data-testid={`approval-item-${line.id}`}>
                      <ClickableImage
                        src={line.image_url}
                        thumbSrc={line.thumb_url}
                        alt={line.model_name || line.name}
                        width={48}
                        height={48}
                        className="approval-item__img"
                      />
                      <div className="approval-item__text">
                        <div className="approval-item__name">
                          {[line.brand, line.model_name || line.name].filter(Boolean).join(' ')}
                        </div>
                        <div className="count-sub">
                          {[formatSize(line, locale), formatColor(line), line.product_code || line.code]
                            .filter(Boolean).join(' • ')}
                        </div>
                      </div>
                      <div className="approval-item__price">
                        <strong>{money(line.sale_price)}</strong>
                        {/* Per-line floor, so a manager can see WHICH item is the one
                            pulling the sale under. */}
                        {kind === 'discount' && line.min_price !== undefined
                          && Number(line.min_price) < Number(line.sale_price) && (
                          <div className="count-sub">{t('discount.floor')} {money(line.min_price)}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {r.status === 'approved' && (
                  <div className="approval-card__decided">
                    {t('discount.approved_amount')}:{' '}
                    <strong>{money(kind === 'credit' ? r.approved_credit : r.approved_discount)}</strong>
                    {r.decided_by_name ? ` — ${r.decided_by_name}` : ''}
                    {r.below_min_acknowledged && (
                      <span className="badge badge-danger" style={{ marginInlineStart: 8 }}>
                        {t('discount.went_below_min')}
                      </span>
                    )}
                  </div>
                )}

                {canDecide && r.status === 'pending' && (
                  <div className="approval-card__actions">
                    <button className="btn btn-primary" data-testid={`approval-decide-${r.id}`}
                      onClick={() => openDecision(r)}>
                      {t('discount.decide')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {deciding && (
        <div className="modal-overlay" onClick={() => setDeciding(null)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2>{deciding.request_number}</h2>
            <p className="section-hint">
              {kind === 'credit'
                ? t('credit.decide_hint', {
                  who: deciding.requested_by_name || '—',
                  customer: deciding.customer_name || '—',
                  asked: money(deciding.requested_credit),
                  total: money(deciding.cart_total),
                })
                : t('discount.decide_hint', {
                  who: deciding.requested_by_name || '—',
                  asked: money(deciding.requested_discount),
                  total: money(deciding.cart_total),
                })}
            </p>
            {deciding.reason && <p><em>{deciding.reason}</em></p>}

            <div className="form-group">
              <label className="form-label">
                {kind === 'credit' ? t('credit.approve_amount') : t('discount.approve_amount')}
              </label>
              <input type="number" step="0.01" min="0" max={deciding.cart_total} className="form-input"
                data-testid="approval-amount"
                value={form.amount}
                onChange={(e) => { setForm({ ...form, amount: e.target.value }); setBelowMin(null); }} />
              <div className="form-hint">
                {kind === 'credit' ? t('credit.approve_less_hint') : t('discount.approve_less_hint')}
              </div>
            </div>

            {/* Live arithmetic, so the consequence is on screen before the click. */}
            {preview && (
              <div className="confirm-facts" data-testid="approval-preview">
                <div className="confirm-fact">
                  <span>{t('discount.cart')}</span><strong>{money(preview.total)}</strong>
                </div>
                {kind === 'credit' ? (
                  <>
                    <div className="confirm-fact">
                      <span>{t('credit.paid_now')}</span>
                      <strong>{money(preview.total - preview.unpaid)}</strong>
                    </div>
                    <div className="confirm-fact confirm-fact--danger">
                      <span>{t('credit.on_account')}</span><strong>{money(preview.unpaid)}</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="confirm-fact">
                      <span>{t('discount.customer_pays')}</span><strong>{money(preview.after)}</strong>
                    </div>
                    {preview.floor > 0 && (
                      <div className={`confirm-fact${preview.under ? ' confirm-fact--danger' : ''}`}>
                        <span>{t('discount.min_total')}</span><strong>{money(preview.floor)}</strong>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {preview?.under && (
              <p className="approval-warning" data-testid="approval-under-floor">
                {t('discount.below_min_warning', { amount: money(preview.shortfall) })}
              </p>
            )}

            <div className="form-group">
              <label className="form-label">{t('discount.note')}</label>
              <input className="form-input" value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>

            {/* The server refused once and said why. Going ahead is a second, separate
                press — not a box ticked before the numbers were known. */}
            {belowMin && (
              <div className="approval-blocked" data-testid="approval-below-min-confirm">
                <p>{t('discount.below_min_blocked', {
                  after: money(belowMin.after),
                  min: money(belowMin.min_total),
                  shortfall: money(belowMin.shortfall),
                })}</p>
                <button className="btn btn-danger" data-testid="approval-force"
                  disabled={saving} onClick={() => decide(true, true)}>
                  {t('discount.approve_anyway')}
                </button>
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setDeciding(null)}>{t('common.cancel')}</button>
              <button className="btn btn-danger" data-testid="approval-reject"
                disabled={saving} onClick={() => decide(false)}>
                {t('discount.reject')}
              </button>
              <button className="btn btn-primary" data-testid="approval-approve"
                disabled={saving} onClick={() => decide(true)}>
                {t('discount.approve')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
