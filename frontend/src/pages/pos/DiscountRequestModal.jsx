import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { discountsAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';

/**
 * "Can I take 50 off?" — asked from the till, answered from anywhere.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The alternative is a manager walking to the counter and typing their own password
 * into someone else's session. That works in one shop with the manager on the floor,
 * fails in every other case, and teaches staff that a manager's password is a thing you
 * hand over.
 *
 * WHILE IT WAITS
 *
 * The cart is a PROPOSAL, not a reservation. The stock stays on the shelf and can be
 * sold to the next person who walks in — which is correct, because holding stock for an
 * unapproved discount would lose real sales. So this polls for an answer and, when one
 * arrives, hands the approval back to the till to sell against.
 *
 * Polling rather than a socket: this app has no realtime channel, the wait is measured
 * in minutes, and every five seconds against one endpoint is cheaper than the machinery
 * a socket would need.
 */

const POLL_MS = 5000;

/**
 * `kind` decides which question is being asked. Both use identical machinery — park,
 * notify, poll, hand the approval back — so a second modal would have been the same
 * two hundred lines with different labels, and the two copies would drift.
 */
export default function DiscountRequestModal({
  storeId, customerId, cart, total, onClose, onApproved, kind = 'discount',
}) {
  const isCredit = kind === 'credit';
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [request, setRequest] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  // Stop polling on unmount, or a closed modal keeps a timer alive for the session.
  useEffect(() => () => clearInterval(timer.current), []);

  useEffect(() => {
    if (!request || request.status !== 'pending') return undefined;
    timer.current = setInterval(async () => {
      try {
        const { data } = await discountsAPI.getById(request.id);
        const r = data.data;
        setRequest(r);
        if (r.status === 'approved') {
          clearInterval(timer.current);
          toast.success(t(isCredit ? 'credit.approved_toast' : 'discount.approved_toast', {
            amount: Number(isCredit ? r.approved_credit : r.approved_discount),
          }));
          onApproved(r);
        } else if (r.status === 'rejected') {
          clearInterval(timer.current);
          toast.error(t('discount.rejected_toast'));
        }
      } catch { /* a poll that fails is retried on the next tick */ }
    }, POLL_MS);
    return () => clearInterval(timer.current);
  }, [request, onApproved, t, isCredit]);

  const ask = async (e) => {
    e.preventDefault();
    const value = Number(amount);
    if (!(value > 0)) { toast.error(t('discount.enter_amount')); return; }
    if (value > total) { toast.error(t('discount.too_big')); return; }
    // A pay-later request needs somebody to collect from. The server refuses this too;
    // saying it here saves a round trip and explains it while the cart is still open.
    if (isCredit && !customerId) { toast.error(t('credit.needs_customer')); return; }
    try {
      setBusy(true);
      const { data } = await discountsAPI.request({
        store_id: storeId,
        customer_id: customerId || null,
        items: cart.map((c) => ({ id: c.id, sale_price: parseFloat(c.sale_price) || 0 })),
        kind,
        ...(isCredit ? { requested_credit: value } : { requested_discount: value }),
        reason,
      });
      setRequest(data.data);
      toast.success(t('discount.sent'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (request) await discountsAPI.cancel(request.id).catch(() => {});
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
        <h2>{t(isCredit ? 'credit.ask_title' : 'discount.ask_title')}</h2>

        {!request ? (
          <form onSubmit={ask} className="product-form">
            <p className="section-hint">{t(isCredit ? 'credit.ask_hint' : 'discount.ask_hint', { total })}</p>
            <div className="form-group">
              <label className="form-label">{t(isCredit ? 'credit.how_much' : 'discount.how_much')} *</label>
              <input type="number" step="0.01" min="0.01" max={total} className="form-input" required autoFocus
                data-testid="discount-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('discount.why')}</label>
              <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={t('discount.why_placeholder')} />
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy} data-testid="discount-send">
                {t('discount.send')}
              </button>
            </div>
          </form>
        ) : (
          <div className="discount-waiting" data-testid="discount-waiting">
            <p><strong>{request.request_number}</strong></p>
            {request.status === 'pending' && (
              <>
                <div className="spinner" />
                <p>{t('discount.waiting')}</p>
                {/* Said plainly, because it is the surprising part and the cashier has
                    to be able to explain it to the customer standing in front of them. */}
                <p className="section-hint">{t('discount.no_hold_warning')}</p>
              </>
            )}
            {request.status === 'rejected' && (
              <p className="shift-bad">
                {t('discount.rejected')}{request.decision_note ? ` — ${request.decision_note}` : ''}
              </p>
            )}
            {request.status === 'approved' && (
              <p className="shift-good">
                {t(isCredit ? 'credit.approved' : 'discount.approved', {
                  amount: Number(isCredit ? request.approved_credit : request.approved_discount),
                })}
              </p>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={cancel}>
                {request.status === 'pending' ? t('discount.cancel_request') : t('common.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
