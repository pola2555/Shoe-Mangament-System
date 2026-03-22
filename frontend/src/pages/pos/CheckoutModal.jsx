import { useState } from 'react';

export default function CheckoutModal({ total, onClose, onConfirm }) {
  const [method, setMethod] = useState('cash');
  const [amountReceived, setAmountReceived] = useState('');
  const [reference, setReference] = useState('');

  const handleConfirm = (e) => {
    e.preventDefault();
    onConfirm({ method, reference });
  };

  const change = amountReceived ? Math.max(0, parseFloat(amountReceived) - total) : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content card" style={{ maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>Complete Sale</h2>
        
        <div style={{ textAlign: 'center', marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md)', background: 'var(--color-bg-base)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: '0.25rem' }}>Total Due</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--color-success)' }}>
            {total.toLocaleString()} <span style={{ fontSize: '1rem' }}>EGP</span>
          </div>
        </div>

        <form onSubmit={handleConfirm} className="product-form">
          <div className="form-group">
            <label className="form-label">Payment Method</label>
            <select className="form-input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="card">Card (POS)</option>
              <option value="instapay">InstaPay</option>
              <option value="vodafone_cash">Vodafone Cash</option>
              <option value="fawry">Fawry</option>
              <option value="bank_transfer">Bank Transfer</option>
            </select>
          </div>

          {method === 'cash' ? (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Amount Received</label>
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
                <label className="form-label">Change Due</label>
                <div style={{ padding: '0.75rem', background: 'var(--color-bg-base)', borderRadius: 'var(--radius-sm)', fontWeight: 600, color: change > 0 ? 'var(--color-warning)' : 'inherit' }}>
                  {change.toLocaleString()} EGP
                </div>
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">Reference Number (Optional)</label>
              <input 
                type="text" 
                className="form-input" 
                value={reference} 
                onChange={(e) => setReference(e.target.value)} 
                placeholder="Transaction ID, Receipt No..."
                autoFocus
              />
            </div>
          )}

          <div className="form-actions" style={{ marginTop: 'var(--spacing-xl)' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Confirm Payment</button>
          </div>
        </form>
      </div>
    </div>
  );
}
