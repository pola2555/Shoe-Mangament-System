import { useState, useEffect, useMemo } from 'react';
import { loansAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

export default function LoansPage() {
  const [loans, setLoans] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { hasPermission, filterStores } = useAuth();
  const canWrite = hasPermission('loans', 'write');
  const { t } = useTranslation();

  const emptyForm = { borrower_name: '', borrower_phone: '', amount: '', loan_date: new Date().toISOString().split('T')[0], due_date: '', notes: '', store_id: '' };
  const [form, setForm] = useState(emptyForm);
  const emptyPayment = { amount: '', payment_method: 'cash', payment_date: new Date().toISOString().split('T')[0], notes: '' };
  const [paymentForm, setPaymentForm] = useState(emptyPayment);

  useEffect(() => {
    storesAPI.list().then(r => setStores(filterStores(r.data.data))).catch(() => {});
    fetchLoans();
  }, []);

  const fetchLoans = async () => {
    try { setLoading(true); const { data } = await loansAPI.list(); setLoans(data.data); }
    catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  };

  const openDetail = async (id) => {
    try { const { data } = await loansAPI.getById(id); setDetail(data.data); }
    catch { toast.error(t('common.error')); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, amount: parseFloat(form.amount) };
      if (!payload.store_id) delete payload.store_id;
      if (!payload.due_date) payload.due_date = null;
      if (editingId) { await loansAPI.update(editingId, payload); toast.success(t('common.updated')); }
      else { await loansAPI.create(payload); toast.success(t('common.created')); }
      setShowForm(false); setEditingId(null); setForm(emptyForm);
      fetchLoans();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleDelete = async (id) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try { await loansAPI.delete(id); toast.success(t('common.deleted')); fetchLoans(); if (detail?.id === id) setDetail(null); }
    catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleAddPayment = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...paymentForm, amount: parseFloat(paymentForm.amount) };
      const { data } = await loansAPI.addPayment(detail.id, payload);
      toast.success(t('common.created'));
      setDetail(data.data);
      setShowPaymentForm(false);
      setPaymentForm(emptyPayment);
      fetchLoans();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleDeletePayment = async (paymentId) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try {
      const { data } = await loansAPI.deletePayment(detail.id, paymentId);
      toast.success(t('common.deleted'));
      setDetail(data.data);
      fetchLoans();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const filtered = useMemo(() => {
    let result = [...loans];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l => l.borrower_name?.toLowerCase().includes(q) || l.borrower_phone?.toLowerCase().includes(q));
    }
    if (statusFilter) result = result.filter(l => l.status === statusFilter);
    return result;
  }, [loans, search, statusFilter]);

  const totalOutstanding = useMemo(() =>
    loans.filter(l => l.status !== 'paid').reduce((sum, l) => sum + parseFloat(l.amount) - parseFloat(l.paid_amount), 0), [loans]);

  const statusColors = { active: 'badge-warning', partial: 'badge-info', paid: 'badge-success' };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('loans.title')}</h1>
        {canWrite && <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true); }}>+ {t('loans.add_loan')}</button>}
      </div>

      {/* Summary */}
      <div className="card" style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-xl)', flexWrap: 'wrap', padding: 'var(--spacing-md)' }}>
        <div><span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.total_loaned')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em' }}>{loans.reduce((s, l) => s + parseFloat(l.amount), 0).toLocaleString()} {t('common.currency')}</div></div>
        <div><span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.total_collected')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em', color: 'var(--color-success)' }}>{loans.reduce((s, l) => s + parseFloat(l.paid_amount), 0).toLocaleString()} {t('common.currency')}</div></div>
        <div><span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.total_outstanding')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em', color: 'var(--color-danger)' }}>{totalOutstanding.toLocaleString()} {t('common.currency')}</div></div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap', alignItems: 'flex-end', padding: 'var(--spacing-md)' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 180 }}>
          <label className="form-label">{t('common.search')}</label>
          <input className="form-input" placeholder={t('loans.search_placeholder')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="form-group" style={{ minWidth: 140 }}>
          <label className="form-label">{t('common.status')}</label>
          <select className="form-input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">{t('common.all')}</option>
            <option value="active">{t('loans.active')}</option>
            <option value="partial">{t('loans.partial')}</option>
            <option value="paid">{t('loans.paid')}</option>
          </select>
        </div>
      </div>

      {/* Create/Edit Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('loans.edit_loan') : t('loans.add_loan')}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">{t('loans.borrower_name')} *</label>
                  <input className="form-input" required value={form.borrower_name} onChange={e => setForm({ ...form, borrower_name: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('common.phone')}</label>
                  <input className="form-input" value={form.borrower_phone} onChange={e => setForm({ ...form, borrower_phone: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.amount')} *</label>
                  <input className="form-input" type="number" step="0.01" min="0.01" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.loan_date')} *</label>
                  <input className="form-input" type="date" required value={form.loan_date} onChange={e => setForm({ ...form, loan_date: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.due_date')}</label>
                  <input className="form-input" type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('common.store')}</label>
                  <SearchableSelect
                    options={stores.map(s => ({ value: s.id, label: s.name }))}
                    value={form.store_id}
                    onChange={v => setForm({ ...form, store_id: v })}
                    placeholder={t('common.select')}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('common.notes')}</label>
                <textarea className="form-input" rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{editingId ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 600, maxHeight: '85vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
              <h2>{detail.borrower_name}</h2>
              <span className={`badge ${statusColors[detail.status]}`}>{t(`loans.${detail.status}`)}</span>
            </div>
            {detail.borrower_phone && <p style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>{t('common.phone')}: {detail.borrower_phone}</p>}
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
              {t('loans.amount')}: <strong>{parseFloat(detail.amount).toLocaleString()} {t('common.currency')}</strong> &nbsp;•&nbsp;
              {t('loans.paid_back')}: <strong style={{ color: 'var(--color-success)' }}>{parseFloat(detail.paid_amount).toLocaleString()} {t('common.currency')}</strong> &nbsp;•&nbsp;
              {t('loans.remaining')}: <strong style={{ color: 'var(--color-danger)' }}>{(parseFloat(detail.amount) - parseFloat(detail.paid_amount)).toLocaleString()} {t('common.currency')}</strong>
            </p>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 'var(--spacing-md)' }}>
              {t('loans.loan_date')}: {new Date(detail.loan_date).toLocaleDateString()}
              {detail.due_date && <> &nbsp;•&nbsp; {t('loans.due_date')}: {new Date(detail.due_date).toLocaleDateString()}</>}
              {detail.store_name && <> &nbsp;•&nbsp; {t('common.store')}: {detail.store_name}</>}
            </p>
            {detail.notes && <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 'var(--spacing-md)', fontStyle: 'italic' }}>{detail.notes}</p>}

            {/* Payments */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
              <h3>{t('loans.payments')} ({detail.payments?.length || 0})</h3>
              {canWrite && detail.status !== 'paid' && (
                <button className="btn btn-sm btn-primary" onClick={() => { setPaymentForm(emptyPayment); setShowPaymentForm(true); }}>+ {t('loans.add_payment')}</button>
              )}
            </div>

            {detail.payments?.length > 0 ? (
              <div className="table-container" style={{ maxHeight: 250, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr><th>{t('common.date')}</th><th>{t('loans.amount')}</th><th>{t('loans.method')}</th><th>{t('common.notes')}</th>{canWrite && <th></th>}</tr></thead>
                  <tbody>{detail.payments.map(p => (
                    <tr key={p.id}>
                      <td>{new Date(p.payment_date).toLocaleDateString()}</td>
                      <td><strong>{parseFloat(p.amount).toLocaleString()} {t('common.currency')}</strong></td>
                      <td>{p.payment_method}</td>
                      <td style={{ color: 'var(--color-text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.notes || '—'}</td>
                      {canWrite && <td><button className="btn btn-sm btn-danger" onClick={() => handleDeletePayment(p.id)}>✕</button></td>}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p style={{ color: 'var(--color-text-muted)' }}>{t('loans.no_payments')}</p>}

            {/* Add Payment Form (inline) */}
            {showPaymentForm && (
              <form onSubmit={handleAddPayment} className="card" style={{ marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)', border: '1px solid var(--color-border)' }}>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('loans.amount')} *</label>
                    <input className="form-input" type="number" step="0.01" min="0.01"
                      max={parseFloat(detail.amount) - parseFloat(detail.paid_amount)}
                      required value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('common.date')} *</label>
                    <input className="form-input" type="date" required value={paymentForm.payment_date} onChange={e => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('loans.method')}</label>
                    <select className="form-input" value={paymentForm.payment_method} onChange={e => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}>
                      <option value="cash">{t('common.cash')}</option>
                      <option value="bank_transfer">{t('common.bank_transfer')}</option>
                      <option value="instapay">{t('common.instapay')}</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.notes')}</label>
                  <input className="form-input" value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPaymentForm(false)}>{t('common.cancel')}</button>
                  <button type="submit" className="btn btn-primary btn-sm">{t('common.save')}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>{t('loans.borrower_name')}</th>
                <th>{t('common.phone')}</th>
                <th>{t('loans.amount')}</th>
                <th>{t('loans.paid_back')}</th>
                <th>{t('loans.remaining')}</th>
                <th>{t('common.status')}</th>
                <th>{t('loans.loan_date')}</th>
                <th>{t('loans.due_date')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('loans.no_loans')}</td></tr>
              ) : filtered.map(l => {
                const remaining = parseFloat(l.amount) - parseFloat(l.paid_amount);
                const overdue = l.due_date && new Date(l.due_date) < new Date() && l.status !== 'paid';
                return (
                  <tr key={l.id} className="product-row" onClick={() => openDetail(l.id)} style={overdue ? { borderInlineStart: '3px solid var(--color-danger)' } : undefined}>
                    <td><strong>{l.borrower_name}</strong></td>
                    <td>{l.borrower_phone || '—'}</td>
                    <td>{parseFloat(l.amount).toLocaleString()}</td>
                    <td style={{ color: 'var(--color-success)' }}>{parseFloat(l.paid_amount).toLocaleString()}</td>
                    <td style={{ color: remaining > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>{remaining.toLocaleString()}</td>
                    <td><span className={`badge ${statusColors[l.status]}`}>{t(`loans.${l.status}`)}</span></td>
                    <td>{new Date(l.loan_date).toLocaleDateString()}</td>
                    <td>{l.due_date ? new Date(l.due_date).toLocaleDateString() : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                        {canWrite && (
                          <>
                            <button className="btn btn-sm btn-secondary" onClick={() => {
                              setForm({
                                borrower_name: l.borrower_name, borrower_phone: l.borrower_phone || '',
                                amount: l.amount, loan_date: new Date(l.loan_date).toISOString().split('T')[0],
                                due_date: l.due_date ? new Date(l.due_date).toISOString().split('T')[0] : '',
                                notes: l.notes || '', store_id: l.store_id || '',
                              });
                              setEditingId(l.id); setShowForm(true);
                            }}>✏️</button>
                            <button className="btn btn-sm btn-danger" onClick={() => handleDelete(l.id)}>🗑</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
