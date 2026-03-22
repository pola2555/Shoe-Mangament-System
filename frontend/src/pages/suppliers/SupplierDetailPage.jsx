import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { suppliersAPI, purchasesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

export default function SupplierDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('purchases', 'write');

  const [supplier, setSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('invoices'); // invoices, payments, returns

  // Payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    total_amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], reference_no: '', notes: '',
  });

  useEffect(() => { fetchSupplier(); }, [id]);

  const fetchSupplier = async () => {
    try {
      setLoading(true);
      const { data } = await suppliersAPI.getById(id);
      setSupplier(data.data);
    } catch {
      toast.error('Supplier not found');
      navigate('/suppliers');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePayment = async (e) => {
    e.preventDefault();
    try {
      await purchasesAPI.createPayment({
        supplier_id: id,
        total_amount: parseFloat(paymentForm.total_amount),
        payment_method: paymentForm.payment_method,
        payment_date: paymentForm.payment_date,
        reference_no: paymentForm.reference_no || null,
        notes: paymentForm.notes || null,
      });
      toast.success('Payment recorded successfully');
      setShowPaymentForm(false);
      setPaymentForm({ total_amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], reference_no: '', notes: '' });
      fetchSupplier(); // Refresh to recalculate balances
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to record payment');
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!supplier) return null;

  const fmt = (v) => v != null ? `${parseFloat(v).toLocaleString()} EGP` : '—';
  const oweUs = supplier.balance < 0; // If balance is negative, they owe us (advance payment)
  const absBalance = Math.abs(supplier.balance);

  return (
    <div className="product-detail">
      {/* Header & Summary */}
      <div className="page-header">
        <div>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/suppliers')} style={{ marginBottom: 8 }}>
            ← Back to Suppliers
          </button>
          <h1 className="page-title">{supplier.name}</h1>
          <p style={{ color: 'var(--color-text-secondary)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {supplier.phone && <span>📞 {supplier.phone}</span>}
            {supplier.email && <span>✉️ {supplier.email}</span>}
          </p>
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <span className={`badge ${supplier.is_active ? 'badge-success' : 'badge-danger'}`}>
              {supplier.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowPaymentForm(true)}>
            + Record Payment
          </button>
        )}
      </div>

      {/* Financial Overview Cards */}
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 'var(--spacing-xl)' }}>
        <div className="stat-card">
          <div className="stat-label">Total Invoiced</div>
          <div className="stat-value">{fmt(supplier.total_invoiced)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Returned</div>
          <div className="stat-value">{fmt(supplier.total_returns)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Paid</div>
          <div className="stat-value" style={{ color: 'var(--color-primary-light)' }}>{fmt(supplier.total_paid)}</div>
        </div>
        <div className={`stat-card ${oweUs ? '' : 'stat-card--danger'}`} style={{ border: `1px solid ${oweUs ? 'var(--color-success)' : 'var(--color-danger)'}` }}>
          <div className="stat-label">{oweUs ? 'Advance Payment (They owe you)' : 'Account Balance (You owe them)'}</div>
          <div className="stat-value" style={{ color: oweUs ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {fmt(absBalance)}
          </div>
        </div>
      </div>

      {/* Payment Form Modal */}
      {showPaymentForm && (
        <div className="modal-overlay" onClick={() => setShowPaymentForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Record Payment</h2>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
              Any payment recorded here will automatically be allocated to the oldest unpaid invoices first (FIFO). If the payment exceeds the owed amount, the remaining funds will be stored as an <strong>Advance Payment</strong> on the supplier's account balance.
            </p>
            <form onSubmit={handleCreatePayment} className="product-form">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Amount (EGP) *</label>
                  <input className="form-input" type="number" step="0.01" required value={paymentForm.total_amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, total_amount: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Payment Date *</label>
                  <input className="form-input" type="date" required value={paymentForm.payment_date}
                    onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Payment Method *</label>
                  <SearchableSelect
                    required
                    options={[
                      { value: 'cash', label: 'Cash' },
                      { value: 'bank_transfer', label: 'Bank Transfer' },
                      { value: 'cheque', label: 'Cheque' },
                      { value: 'instapay', label: 'InstaPay' },
                      { value: 'vodafone_cash', label: 'Vodafone Cash' },
                      { value: 'other', label: 'Other' }
                    ]}
                    value={paymentForm.payment_method}
                    onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Reference #</label>
                  <input className="form-input" value={paymentForm.reference_no}
                    onChange={(e) => setPaymentForm({ ...paymentForm, reference_no: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-input" rows={2} value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowPaymentForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save Payment</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {['invoices', 'payments', 'returns'].map((tab) => (
          <button key={tab} className={`tab ${activeTab === tab ? 'tab--active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({supplier[tab]?.length || 0})
          </button>
        ))}
      </div>

      {/* Tab Content: Invoices */}
      {activeTab === 'invoices' && (
        <div className="tab-content">
          {supplier.invoices?.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Date</th>
                    <th>Total Amnt</th>
                    <th>Paid Amnt</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {supplier.invoices.map((inv) => (
                    <tr key={inv.id} className="product-row" onClick={() => navigate(`/purchases/${inv.id}`)}>
                      <td><strong>{inv.invoice_number}</strong></td>
                      <td>{new Date(inv.invoice_date).toLocaleDateString()}</td>
                      <td>{fmt(inv.total_amount)}</td>
                      <td>{fmt(inv.paid_amount)}</td>
                      <td>
                        <span className={`badge ${inv.status === 'paid' ? 'badge-success' : inv.status === 'partial' ? 'badge-info' : 'badge-warning'}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/purchases/${inv.id}`); }}>View Details</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
              No purchase invoices recorded for this supplier.
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Payments */}
      {activeTab === 'payments' && (
        <div className="tab-content">
          {supplier.payments?.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {supplier.payments.map((pay) => (
                    <tr key={pay.id}>
                      <td>{new Date(pay.payment_date).toLocaleDateString()}</td>
                      <td><span className="badge badge-neutral">{pay.payment_method}</span></td>
                      <td>{pay.reference_no || '—'}</td>
                      <td><strong style={{ color: 'var(--color-success)' }}>{fmt(pay.total_amount)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
              No payments have been recorded for this supplier.
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Returns */}
      {activeTab === 'returns' && (
        <div className="tab-content">
          {supplier.returns?.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Return #</th>
                    <th>Date</th>
                    <th>Reason</th>
                    <th>Refund Value</th>
                  </tr>
                </thead>
                <tbody>
                  {supplier.returns.map((ret) => (
                    <tr key={ret.id}>
                      <td><strong>{ret.return_number}</strong></td>
                      <td>{new Date(ret.created_at).toLocaleDateString()}</td>
                      <td>{ret.reason || '—'}</td>
                      <td>{fmt(ret.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
              No supplier returns recorded.
            </div>
          )}
        </div>
      )}

    </div>
  );
}
