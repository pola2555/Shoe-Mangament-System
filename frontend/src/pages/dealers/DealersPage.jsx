import { useState, useEffect } from 'react';
import { dealersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../../components/common/ConfirmDialog';
import '../products/Products.css';

export default function DealersPage() {
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', notes: '' });
  const [editingId, setEditingId] = useState(null);
  const [detail, setDetail] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('dealers', 'write');
  // Recording that money arrived, and taking that back, is a separate authority from
  // maintaining a contact record — and the server gates it separately too.
  const canPay = hasPermission('dealer_payments', 'write');
  const { t } = useTranslation();
  const confirm = useConfirm();

  const BLANK_PAYMENT = {
    total_amount: '', payment_method: 'cash',
    payment_date: new Date().toISOString().slice(0, 10), reference_no: '', notes: '',
  };
  const [payForm, setPayForm] = useState(null);     // null = closed; {id?} = open
  const [savingPay, setSavingPay] = useState(false);

  useEffect(() => { fetchDealers(); }, []);

  const fetchDealers = async () => {
    try { setLoading(true); const { data } = await dealersAPI.list(); setDealers(data.data); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) { await dealersAPI.update(editingId, form); toast.success('Updated'); }
      else { await dealersAPI.create(form); toast.success('Created'); }
      setShowForm(false); setEditingId(null); fetchDealers();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const openDetail = async (id) => {
    try { const { data } = await dealersAPI.getById(id); setDetail(data.data); }
    catch { toast.error('Failed'); }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!await confirm({
      title: t('dealers.deactivate_title'),
      message: t('dealers.deactivate_confirm'),
      danger: true,
      confirmText: t('common.confirm'),
    })) return;
    try {
      await dealersAPI.delete(id);
      toast.success('Dealer deleted');
      fetchDealers();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const fmt = (v) => v != null ? `${parseFloat(v).toLocaleString()} EGP` : '—';

  /** Re-read the open dealer so the modal reflects what just changed. */
  const refreshDetail = async (dealerId) => {
    const { data } = await dealersAPI.getById(dealerId);
    setDetail(data.data);
    fetchDealers();          // the row's balance moved too
  };

  const savePayment = async (e) => {
    e.preventDefault();
    const amount = parseFloat(payForm.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) { toast.error(t('dealers.payment_amount')); return; }
    try {
      setSavingPay(true);
      const body = {
        total_amount: amount,
        payment_method: payForm.payment_method,
        payment_date: payForm.payment_date,
        reference_no: payForm.reference_no || null,
        notes: payForm.notes || null,
      };
      if (payForm.id) await dealersAPI.updatePayment(payForm.id, body);
      else await dealersAPI.createPayment({ ...body, dealer_id: detail.id });
      toast.success(t('dealers.payment_saved'));
      setPayForm(null);
      await refreshDetail(detail.id);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    } finally { setSavingPay(false); }
  };

  /**
   * Deleting a payment names what it is about to undo.
   *
   * "Are you sure?" is not a question anybody can answer. This payment may be the only
   * thing holding two invoices in "paid", and removing it puts them back to owing —
   * so the warning says which invoices, by number, before anything happens.
   */
  const deletePayment = async (p) => {
    const applied = (p.allocations || []).length;
    const message = applied
      ? t('dealers.delete_payment_applied', {
        amount: fmt(p.total_amount),
        count: applied,
        invoices: p.allocations.map((a) => a.invoice_number).join(', '),
      })
      : t('dealers.delete_payment_simple', { amount: fmt(p.total_amount) });

    if (!await confirm({
      title: t('dealers.delete_payment_title'),
      message: `${message} ${t('dealers.delete_payment_warning')}`,
      danger: true,
      confirmText: t('common.delete'),
    })) return;

    try {
      await dealersAPI.deletePayment(p.id);
      toast.success(t('dealers.payment_deleted'));
      await refreshDetail(detail.id);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('dealers.title')}</h1>
        {canWrite && <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm({ name: '', phone: '', email: '', address: '', notes: '' }); setShowForm(true); }}>{`+ ${t('dealers.add_dealer')}`}</button>}
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('common.edit') : t('common.create')} {t('sidebar.dealers')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-group"><label className="form-label">{t('common.name')} *</label><input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('common.phone')}</label><input className="form-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t('common.email')}</label><input className="form-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{editingId ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Recording or correcting a payment. Rendered above the dealer modal rather than
          inside it, so closing this one does not close that one. */}
      {payForm && (
        <div className="modal-overlay" style={{ zIndex: 250 }} onClick={() => setPayForm(null)}>
          <div className="modal-content card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>
              {payForm.id ? t('dealers.edit_payment') : t('dealers.record_payment')}
            </h2>
            <form onSubmit={savePayment} className="product-form">
              <div className="form-group">
                <label className="form-label">{t('dealers.payment_amount')} *</label>
                <input className="form-input" type="number" step="0.01" min="0.01" required
                  data-testid="dealer-payment-amount"
                  value={payForm.total_amount}
                  onChange={(e) => setPayForm({ ...payForm, total_amount: e.target.value })} />
                {/* Said plainly, because the split is not preserved: the money is taken
                    back off every invoice and re-applied against what is outstanding
                    now, which may not be what was outstanding when it was first taken. */}
                <div className="form-hint">{t('dealers.reallocate_note')}</div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('sales.payment_method')}</label>
                  <select className="form-input" data-testid="dealer-payment-method"
                    value={payForm.payment_method}
                    onChange={(e) => setPayForm({ ...payForm, payment_method: e.target.value })}>
                    <option value="cash">cash</option>
                    <option value="bank_transfer">bank_transfer</option>
                    <option value="instapay">instapay</option>
                    <option value="vodafone_cash">vodafone_cash</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.date')}</label>
                  <input className="form-input" type="date" required
                    value={payForm.payment_date}
                    onChange={(e) => setPayForm({ ...payForm, payment_date: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Ref</label>
                <input className="form-input" value={payForm.reference_no}
                  onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setPayForm(null)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingPay}
                  data-testid="dealer-payment-save">
                  {savingPay ? t('common.loading') : t('common.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 650 }} onClick={(e) => e.stopPropagation()}>
            <h2>{detail.name}</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
              {t('dealers.total_invoices')}: <strong>{fmt(detail.total_invoiced)}</strong> &nbsp;•&nbsp;
              {t('dealers.total_paid')}: <strong>{fmt(detail.total_paid)}</strong> &nbsp;•&nbsp;
              <span style={{ color: detail.balance > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>{t('dealers.balance')}: {fmt(detail.balance)}</span>
            </p>
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>{t('suppliers.invoices')} ({detail.invoices.length})</h3>
            <div className="table-container" style={{ maxHeight: 200, overflow: 'auto', marginBottom: 'var(--spacing-md)' }}>
              <table className="table"><thead><tr><th>#</th><th>{t('common.date')}</th><th>{t('common.total')}</th><th>{t('sales.paid')}</th><th>{t('common.status')}</th></tr></thead>
                <tbody>{detail.invoices.map((inv) => (
                  <tr key={inv.id}><td>{inv.invoice_number}</td><td>{new Date(inv.invoice_date).toLocaleDateString()}</td>
                    <td>{fmt(inv.total_amount)}</td><td>{fmt(inv.paid_amount)}</td>
                    <td><span className={`badge ${inv.status === 'paid' ? 'badge-success' : inv.status === 'partial' ? 'badge-info' : 'badge-warning'}`}>{inv.status}</span></td>
                  </tr>
                ))}</tbody></table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
              <h3 style={{ margin: 0 }}>{t('suppliers.payments')} ({detail.payments.length})</h3>
              {canPay && (
                <button className="btn btn-sm btn-primary" data-testid="dealer-record-payment"
                  onClick={() => setPayForm({ ...BLANK_PAYMENT })}>
                  {`+ ${t('dealers.record_payment')}`}
                </button>
              )}
            </div>
            <div className="table-container" style={{ maxHeight: 240, overflow: 'auto' }}>
              <table className="table" data-testid="dealer-payments">
                <thead><tr>
                  <th>{t('common.date')}</th><th>{t('sales.payment_method')}</th>
                  <th>{t('common.amount')}</th><th>{t('dealers.applied_to')}</th><th>Ref</th>
                  {canPay && <th>{t('common.actions')}</th>}
                </tr></thead>
                <tbody>
                  {detail.payments.length === 0 && (
                    <tr><td colSpan={canPay ? 6 : 5} style={{ color: 'var(--color-text-secondary)' }}>
                      {t('dealers.no_payments')}
                    </td></tr>
                  )}
                  {detail.payments.map((p) => (
                    <tr key={p.id} data-testid={`dealer-payment-${p.id}`}>
                      <td>{new Date(p.payment_date).toLocaleDateString()}</td>
                      <td>{p.payment_method}</td>
                      <td>{fmt(p.total_amount)}</td>
                      {/* What this payment is holding up. Without it, deleting one is a
                          guess about which invoices are about to reopen. */}
                      <td style={{ fontSize: '0.85em' }}>
                        {(p.allocations || []).length
                          ? p.allocations.map((a) => a.invoice_number).join(', ')
                          : <span style={{ color: 'var(--color-text-secondary)' }}>{t('dealers.settles_nothing')}</span>}
                        {p.unallocated_amount > 0 && (p.allocations || []).length > 0 && (
                          <div style={{ color: 'var(--color-text-secondary)' }}>
                            {t('dealers.held_as_credit', { amount: fmt(p.unallocated_amount) })}
                          </div>
                        )}
                      </td>
                      <td>{p.reference_no || '—'}</td>
                      {canPay && (
                        <td>
                          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                            <button className="btn btn-sm btn-secondary"
                              data-testid={`dealer-payment-edit-${p.id}`}
                              onClick={() => setPayForm({
                                id: p.id,
                                total_amount: String(p.total_amount),
                                payment_method: p.payment_method,
                                payment_date: String(p.payment_date).slice(0, 10),
                                reference_no: p.reference_no || '',
                                notes: p.notes || '',
                              })}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger"
                              data-testid={`dealer-payment-delete-${p.id}`}
                              onClick={() => deletePayment(p)}>{t('common.delete')}</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table"><thead><tr><th>{t('common.name')}</th><th>{t('common.phone')}</th><th>{t('dealers.total_invoices')}</th><th>{t('dealers.total_paid')}</th><th>{t('dealers.balance')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>{dealers.map((d) => (
              <tr key={d.id} className="product-row" onClick={() => openDetail(d.id)}>
                <td><strong>{d.name}</strong></td><td>{d.phone || '—'}</td>
                <td>{fmt(d.total_invoiced)}</td><td>{fmt(d.total_paid)}</td>
                <td style={{ color: d.balance > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>{fmt(d.balance)}</td>
                <td>
                  {canWrite && (
                    <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); setForm({ name: d.name, phone: d.phone || '', email: d.email || '', address: d.address || '', notes: d.notes || '' }); setEditingId(d.id); setShowForm(true); }}>{t('common.edit')}</button>
                      <button className="btn btn-sm btn-danger" onClick={(e) => handleDelete(e, d.id)}>{t('common.delete')}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}</tbody></table>
        </div>
      )}
    </div>
  );
}
