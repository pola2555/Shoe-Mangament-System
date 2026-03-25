import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { suppliersAPI, purchasesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

export default function SupplierDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { t } = useTranslation();
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
      toast.error(t('suppliers.no_suppliers'));
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
      toast.success(t('common.success'));
      setShowPaymentForm(false);
      setPaymentForm({ total_amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], reference_no: '', notes: '' });
      fetchSupplier(); // Refresh to recalculate balances
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
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
            ← {t('suppliers.back_to_suppliers')}
          </button>
          <h1 className="page-title">{supplier.name}</h1>
          <p style={{ color: 'var(--color-text-secondary)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {supplier.phone && <span>📞 {supplier.phone}</span>}
            {supplier.email && <span>✉️ {supplier.email}</span>}
          </p>
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <span className={`badge ${supplier.is_active ? 'badge-success' : 'badge-danger'}`}>
              {supplier.is_active ? t('common.active') : t('common.inactive')}
            </span>
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowPaymentForm(true)}>
            + {t('suppliers.record_payment')}
          </button>
        )}
      </div>

      {/* Financial Overview Cards */}
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 'var(--spacing-xl)' }}>
        <div className="stat-card">
          <div className="stat-label">{t('suppliers.total_invoiced')}</div>
          <div className="stat-value">{fmt(supplier.total_invoiced)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('suppliers.total_returned')}</div>
          <div className="stat-value">{fmt(supplier.total_returns)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('suppliers.total_paid')}</div>
          <div className="stat-value" style={{ color: 'var(--color-primary-light)' }}>{fmt(supplier.total_paid)}</div>
        </div>
        <div className={`stat-card ${oweUs ? '' : 'stat-card--danger'}`} style={{ border: `1px solid ${oweUs ? 'var(--color-success)' : 'var(--color-danger)'}` }}>
          <div className="stat-label">{oweUs ? t('suppliers.advance_payment') : t('suppliers.account_balance')}</div>
          <div className="stat-value" style={{ color: oweUs ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {fmt(absBalance)}
          </div>
        </div>
      </div>

      {/* Payment Form Modal */}
      {showPaymentForm && (
        <div className="modal-overlay" onClick={() => setShowPaymentForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>{t('suppliers.record_payment')}</h2>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
              {t('suppliers.payment_allocation_note')}
            </p>
            <form onSubmit={handleCreatePayment} className="product-form">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('common.amount')} (EGP) *</label>
                  <input className="form-input" type="number" step="0.01" required value={paymentForm.total_amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, total_amount: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('sales.payment_date')} *</label>
                  <input className="form-input" type="date" required value={paymentForm.payment_date}
                    onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('pos.payment_method')} *</label>
                  <SearchableSelect
                    required
                    options={[
                      { value: 'cash', label: t('common.cash') },
                      { value: 'bank_transfer', label: t('common.bank_transfer') },
                      { value: 'cheque', label: t('common.cheque') },
                      { value: 'instapay', label: t('common.instapay') },
                      { value: 'vodafone_cash', label: t('common.vodafone_cash') },
                      { value: 'other', label: t('common.other') }
                    ]}
                    value={paymentForm.payment_method}
                    onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.reference_no')}</label>
                  <input className="form-input" value={paymentForm.reference_no}
                    onChange={(e) => setPaymentForm({ ...paymentForm, reference_no: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.notes')}</label>
                <textarea className="form-input" rows={2} value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowPaymentForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{t('suppliers.save_payment')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {['invoices', 'payments', 'returns'].map((tab) => (
          <button key={tab} className={`tab ${activeTab === tab ? 'tab--active' : ''}`} onClick={() => setActiveTab(tab)}>
            {t(`suppliers.${tab}`)} ({supplier[tab]?.length || 0})
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
                    <th>{t('purchases.invoice_number')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('purchases.total_amount')}</th>
                    <th>{t('purchases.paid_amount')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.actions')}</th>
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
                        <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/purchases/${inv.id}`); }}>{t('common.view_details')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
              {t('suppliers.no_invoices')}
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
                    <th>{t('common.date')}</th>
                    <th>{t('pos.payment_method')}</th>
                    <th>{t('common.reference_no')}</th>
                    <th>{t('common.amount')}</th>
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
              {t('suppliers.no_payments')}
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
                    <th>{t('returns.return_number')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('returns.reason')}</th>
                    <th>{t('returns.refund_amount')}</th>
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
              {t('suppliers.no_returns')}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
