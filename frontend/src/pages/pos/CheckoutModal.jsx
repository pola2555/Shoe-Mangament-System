import { useState } from 'react';
import { useTranslation } from '../../i18n/i18nContext';
import './POS.css';

export default function CheckoutModal({ total, onClose, onConfirm }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState('cash');
  const [amountReceived, setAmountReceived] = useState('');
  const [reference, setReference] = useState('');

  const handleConfirm = (e) => {
    e.preventDefault();
    onConfirm({ method, reference });
  };

  const change = amountReceived ? Math.max(0, parseFloat(amountReceived) - total) : 0;

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
          )}

          <div className="form-actions" style={{ marginTop: 'var(--spacing-xl)' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>{t('pos.confirm_payment')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
