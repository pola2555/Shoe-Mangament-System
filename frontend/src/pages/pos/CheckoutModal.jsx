import { useState } from 'react';
import { useTranslation } from '../../i18n/i18nContext';
import './POS.css';

/**
 * Taking the money.
 *
 * A registered customer may pay part of the total and owe the rest — that is what
 * `payNow` is. A walk-in may not: an unpaid balance against nobody is a debt with
 * no name and no phone number, so the field is disabled and says why.
 *
 * `customerName` doubles as the test for whether a customer is selected, and as what
 * to show beside their outstanding balance.
 */
export default function CheckoutModal({
  total, onClose, onConfirm, customerName, customerOutstanding = 0,
  // How much this sale may be left unpaid. `undefined` means no limit (the person
  // checking out can approve credit themselves); 0 means they must ask first.
  maxUnpaid,
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState('cash');
  const [amountReceived, setAmountReceived] = useState('');
  const [reference, setReference] = useState('');
  const [image, setImage] = useState(null);
  // What is actually being handed over now. Empty means the whole total, which is the
  // overwhelmingly common case and must stay a single keystroke.
  const [payNow, setPayNow] = useState('');

  const limited = maxUnpaid !== undefined;
  // A registered customer can owe; a walk-in cannot. On top of that, a cashier can
  // only leave unpaid what a manager has approved — the server enforces both, this
  // stops the sale being typed out and then refused at the last button.
  const canOwe = Boolean(customerName) && (!limited || maxUnpaid > 0);
  const paying = payNow === '' ? total : Math.max(0, Math.min(total, parseFloat(payNow) || 0));
  const owed = Math.round((total - paying) * 100) / 100;
  const overApproved = limited && owed > (maxUnpaid || 0) + 0.01;

  const handleConfirm = (e) => {
    e.preventDefault();
    if (owed > 0.01 && !canOwe) return;
    if (overApproved) return;
    onConfirm({ method, reference, image, amount: paying });
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) setImage(file);
  };

  const change = amountReceived ? Math.max(0, parseFloat(amountReceived) - paying) : 0;

  return (
    <div className="modal-overlay pos-checkout-modal" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{t('pos.complete_sale')}</h2>
        
        <div style={{ textAlign: 'center', marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md)', background: 'var(--color-bg-base)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: '0.25rem' }}>{t('pos.total_due')}</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--color-success)' }}>
            {total.toLocaleString()} <span style={{ fontSize: '1rem' }}>{t('common.currency')}</span>
          </div>
        </div>

        <form onSubmit={handleConfirm} className="product-form">
          {/* Paying less than the total puts the rest on the customer's account. */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pos.paying_now')}</label>
              <input
                type="number" step="0.01" min="0" max={total}
                className="form-input"
                data-testid="pos-pay-now"
                value={payNow}
                placeholder={total.toLocaleString()}
                disabled={!canOwe}
                onChange={(e) => setPayNow(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pos.on_account')}</label>
              <div data-testid="pos-on-account" style={{
                padding: '0.75rem', background: 'var(--color-bg-base)',
                borderRadius: 'var(--radius-sm)', fontWeight: 600,
                color: owed > 0 ? 'var(--color-danger)' : 'inherit',
              }}>
                {owed.toLocaleString()} {t('common.currency')}
              </div>
            </div>
          </div>

          {!canOwe ? (
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginTop: '-.5rem' }}
              data-testid="pos-walkin-note">
              {t('pos.walkin_must_pay')}
            </p>
          ) : overApproved ? (
            <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: '-.5rem' }}
              data-testid="pos-over-approved">
              {t('credit.over_approved', { amount: (maxUnpaid || 0).toLocaleString() })}
            </p>
          ) : customerOutstanding > 0 ? (
            <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: '-.5rem' }}
              data-testid="pos-customer-outstanding">
              {t('pos.customer_owes', { name: customerName, amount: customerOutstanding.toLocaleString() })}
            </p>
          ) : null}

          <div className="form-group">
            <label className="form-label">{t('pos.payment_method')}</label>
            <select className="form-input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">{t('pos.cash')}</option>
              <option value="card">{t('pos.card')}</option>
              <option value="instapay">{t('common.instapay')}</option>
              <option value="vodafone_cash">{t('common.vodafone_cash')}</option>
              <option value="fawry">{t('common.fawry')}</option>
              <option value="bank_transfer">{t('common.bank_transfer')}</option>
            </select>
          </div>

          {method === 'cash' ? (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('pos.amount_received')}</label>
                <input 
                  type="number" 
                  step="0.01"
                  className="form-input" 
                  value={amountReceived} 
                  onChange={(e) => setAmountReceived(e.target.value)} 
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">{t('pos.change_due')}</label>
                <div style={{ padding: '0.75rem', background: 'var(--color-bg-base)', borderRadius: 'var(--radius-sm)', fontWeight: 600, color: change > 0 ? 'var(--color-warning)' : 'inherit' }}>
                  {change.toLocaleString()} {t('common.currency')}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">{t('common.reference_no')} ({t('common.optional')})</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={reference} 
                  onChange={(e) => setReference(e.target.value)} 
                  placeholder={t('pos.reference_placeholder')}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">{t('pos.payment_proof')} ({t('common.optional')})</label>
                <input
                  type="file"
                  className="form-input"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleImageChange}
                />
                {image && (
                  <div style={{ marginTop: 'var(--spacing-xs)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    {image.name}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="form-actions" style={{ marginTop: 'var(--spacing-xl)' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={overApproved} data-testid="pos-confirm-payment">{t('pos.confirm_payment')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
