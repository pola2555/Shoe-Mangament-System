import { useState, useEffect, useCallback, useRef } from 'react';
import { loansAPI, storesAPI, usersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import ClickableImage from '../../components/common/ClickableImage';
import { useTranslation } from '../../i18n/i18nContext';
import { today, dateInput, money } from '../expenses/expenseHelpers';
import '../products/Products.css';

const PAYMENT_METHODS = ['cash', 'bank', 'instapay', 'wallet', 'cheque', 'card', 'salary_deduction', 'other'];
const statusColors = { active: 'badge-warning', partial: 'badge-info', paid: 'badge-success' };

/**
 * Loans.
 *
 * The form on this page could not create a loan at all. Both SearchableSelects were
 * wired as `onChange={v => setForm({...form, x: v})}`, but that component hands back an
 * event-like `{ target: { value } }` — so the field held an object, the picker rendered
 * blank because `options.find(o => o.value === value)` never matched, and the server
 * rejected the payload. Every other page in the app reads `e.target.value`; this one
 * did not, and the loans table was empty as a result.
 *
 * Two other things changed with it: a borrower no longer has to be a system user (a
 * shop lends to customers and drivers, not only staff), and overdue is shown as its own
 * state, because a debt nobody is chasing is the whole reason to track loans.
 */
export default function LoansPage() {
  const { hasPermission, filterStores } = useAuth();
  const { t } = useTranslation();
  const canWrite = hasPermission('loans', 'write');
  const currency = t('common.currency');
  const proofRef = useRef(null);

  const [loans, setLoans] = useState([]);
  const [totals, setTotals] = useState({ total: 0, overdue: 0, count: 0, overdue_count: 0 });
  const [stores, setStores] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [planCount, setPlanCount] = useState('');
  const [uploadingFor, setUploadingFor] = useState(null);

  // 'staff' picks from the user list; 'other' is a typed name. The API accepts either,
  // and demanding a user account is what made this page unusable for a shop.
  const [borrowerMode, setBorrowerMode] = useState('staff');

  const emptyForm = {
    borrower_user_id: '', borrower_name: '', borrower_phone: '',
    amount: '', loan_date: today(), due_date: '', notes: '', store_id: '',
    installments: '',
  };
  const [form, setForm] = useState(emptyForm);
  const emptyPayment = { amount: '', payment_method: 'cash', payment_date: today(), notes: '' };
  const [paymentForm, setPaymentForm] = useState(emptyPayment);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    storesAPI.list().then((r) => setStores(filterStores(r.data.data))).catch(() => {});
    usersAPI.list().then((r) => setUsers(r.data.data || [])).catch(() => {});
  }, []);

  const fetchLoans = useCallback(async () => {
    try {
      setLoading(true);
      // Filtering happens on the server now, so a store-scoped user cannot be handed
      // another branch's loans and then have them hidden in the browser.
      const params = {};
      if (debounced) params.search = debounced;
      if (statusFilter) params.status = statusFilter;
      if (storeFilter) params.store_id = storeFilter;
      if (overdueOnly) params.overdue_only = true;
      const [list, out] = await Promise.all([
        loansAPI.list(params),
        loansAPI.outstanding(storeFilter ? { store_id: storeFilter } : {}),
      ]);
      setLoans(list.data.data || []);
      setTotals(out.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setLoading(false); }
  }, [debounced, statusFilter, storeFilter, overdueOnly]);

  useEffect(() => { fetchLoans(); }, [fetchLoans]);

  const openDetail = async (id) => {
    try {
      const { data } = await loansAPI.getById(id);
      setDetail(data.data);
      setPlanCount(String(data.data.installments?.length || ''));
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, amount: parseFloat(form.amount) };
      // Send exactly one identity, so the server is never guessing which the user meant.
      if (borrowerMode === 'staff') {
        delete payload.borrower_name;
        if (!payload.borrower_user_id) return toast.error(t('loans.borrower_hint'));
      } else {
        payload.borrower_user_id = null;
        if (!payload.borrower_name?.trim()) return toast.error(t('loans.borrower_hint'));
      }
      if (!payload.store_id) delete payload.store_id;
      if (!payload.due_date) payload.due_date = null;
      if (!payload.borrower_phone) delete payload.borrower_phone;
      if (payload.installments && Number(payload.installments) > 1) {
        payload.installments = Number(payload.installments);
      } else {
        delete payload.installments;
      }

      if (editingId) {
        delete payload.installments;
        await loansAPI.update(editingId, payload);
        toast.success(t('common.updated'));
      } else {
        await loansAPI.create(payload);
        toast.success(t('common.created'));
      }
      setShowForm(false); setEditingId(null); setForm(emptyForm);
      fetchLoans();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleDelete = async (id) => {
    if (!confirm(t('common.are_you_sure'))) return;
    try {
      await loansAPI.delete(id);
      toast.success(t('common.deleted'));
      fetchLoans();
      if (detail?.id === id) setDetail(null);
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleAddPayment = async (e) => {
    e.preventDefault();
    try {
      const { data } = await loansAPI.addPayment(detail.id, { ...paymentForm, amount: parseFloat(paymentForm.amount) });
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

  const savePlan = async () => {
    try {
      await loansAPI.setInstallments(detail.id, { count: Number(planCount) || 0 });
      toast.success(t('loans.plan_saved'));
      await openDetail(detail.id);
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const uploadProof = async (paymentId, file) => {
    if (!file) return;
    try {
      setUploadingFor(paymentId);
      const fd = new FormData();
      fd.append('image', file);
      await loansAPI.uploadPaymentProof(detail.id, paymentId, fd);
      toast.success(t('loans.proof_added'));
      await openDetail(detail.id);
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally {
      setUploadingFor(null);
      if (proofRef.current) proofRef.current.value = '';
    }
  };

  const startEdit = (l) => {
    setForm({
      borrower_user_id: l.borrower_user_id || '',
      borrower_name: l.borrower_user_id ? '' : (l.borrower_name || ''),
      borrower_phone: l.borrower_phone || '',
      amount: l.amount,
      loan_date: dateInput(l.loan_date),
      due_date: dateInput(l.due_date),
      notes: l.notes || '',
      store_id: l.store_id || '',
      installments: '',
    });
    setBorrowerMode(l.borrower_user_id ? 'staff' : 'other');
    setEditingId(l.id);
    setShowForm(true);
  };

  const dueLabel = (l) => {
    if (l.is_overdue) return <span className="badge badge-danger">{t('loans.overdue_by', { n: Math.abs(l.days_to_due) })}</span>;
    if (l.days_to_due === null || l.days_to_due === undefined || l.status === 'paid') return null;
    if (l.days_to_due === 0) return <span className="badge badge-warning">{t('loans.due_today')}</span>;
    if (l.days_to_due <= 7) return <span className="badge badge-warning">{t('loans.due_in', { n: l.days_to_due })}</span>;
    return null;
  };

  const printStatement = () => {
    // Printed from the detail already on screen, so it cannot disagree with what the
    // user is looking at.
    window.print();
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('loans.title')}</h1>
        {canWrite && (
          <button className="btn btn-primary" data-testid="add-loan"
            onClick={() => { setEditingId(null); setForm(emptyForm); setBorrowerMode('staff'); setShowForm(true); }}>
            + {t('loans.add_loan')}
          </button>
        )}
      </div>

      {/* Totals come from the server, over every loan the user may see — not from the
          rows currently on screen, which a filter would quietly change. */}
      <div className="card" style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-xl)', flexWrap: 'wrap', padding: 'var(--spacing-md)' }}>
        <div>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.outstanding')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em', color: 'var(--color-danger)' }} data-testid="loans-outstanding">
            {money(totals.total, currency)}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.overdue_total')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em', color: totals.overdue > 0 ? 'var(--color-danger)' : undefined }}
            data-testid="loans-overdue-total">
            {money(totals.overdue, currency)}
            {totals.overdue_count > 0 && (
              <span className="badge badge-danger" style={{ marginInlineStart: 8 }}>{totals.overdue_count}</span>
            )}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{t('loans.title')}</span>
          <div style={{ fontWeight: 700, fontSize: '1.1em' }}>{totals.count}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap', alignItems: 'flex-end', padding: 'var(--spacing-md)' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 180, marginBottom: 0 }}>
          <label className="form-label">{t('common.search')}</label>
          <input className="form-input" data-testid="loan-search" placeholder={t('loans.search_placeholder')}
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="form-group" style={{ minWidth: 150, marginBottom: 0 }}>
          <label className="form-label">{t('common.status')}</label>
          <SearchableSelect
            options={[
              { value: '', label: t('loans.all_statuses') },
              { value: 'active', label: t('loans.active') },
              { value: 'partial', label: t('loans.partial') },
              { value: 'paid', label: t('loans.paid') },
            ]}
            value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} />
        </div>
        <div className="form-group" style={{ minWidth: 150, marginBottom: 0 }}>
          <label className="form-label">{t('common.store')}</label>
          <SearchableSelect
            options={[{ value: '', label: t('stores.all_stores') }, ...stores.map((s) => ({ value: s.id, label: s.name }))]}
            value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={overdueOnly} data-testid="loan-overdue-only"
              onChange={(e) => setOverdueOnly(e.target.checked)} />
            {t('loans.only_overdue')}
          </label>
        </div>
      </div>

      {/* ---------------------------------------------------------------- form */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" style={{ maxWidth: 560, maxHeight: '88vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()} data-testid="loan-form">
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('loans.edit_loan') : t('loans.add_loan')}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">{t('loans.borrower')} *</label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button type="button" data-testid="borrower-mode-staff"
                    className={`btn btn-sm ${borrowerMode === 'staff' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBorrowerMode('staff')}>{t('loans.staff_member')}</button>
                  <button type="button" data-testid="borrower-mode-other"
                    className={`btn btn-sm ${borrowerMode === 'other' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBorrowerMode('other')}>{t('loans.someone_else')}</button>
                </div>

                {borrowerMode === 'staff' ? (
                  <SearchableSelect
                    options={users.map((u) => ({ value: u.id, label: u.full_name || u.username }))}
                    value={form.borrower_user_id}
                    // e.target.value — SearchableSelect passes an event-like object, and
                    // reading it as a raw value is what broke this form entirely.
                    onChange={(e) => setForm({ ...form, borrower_user_id: e.target.value })}
                    placeholder={t('common.select')}
                  />
                ) : (
                  <input className="form-input" data-testid="borrower-name" value={form.borrower_name}
                    onChange={(e) => setForm({ ...form, borrower_name: e.target.value })}
                    placeholder={t('loans.borrower')} />
                )}
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('loans.borrower_hint')}</small>
              </div>

              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.amount')} *</label>
                  <input className="form-input" type="number" step="0.01" min="0.01" required data-testid="loan-amount"
                    value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.phone')}</label>
                  <input className="form-input" value={form.borrower_phone}
                    onChange={(e) => setForm({ ...form, borrower_phone: e.target.value })} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.loan_date')} *</label>
                  <input className="form-input" type="date" required value={form.loan_date}
                    onChange={(e) => setForm({ ...form, loan_date: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('loans.due_date')}</label>
                  <input className="form-input" type="date" data-testid="loan-due-date" value={form.due_date}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">{t('common.store')}</label>
                  <SearchableSelect
                    options={[{ value: '', label: t('common.select') }, ...stores.map((s) => ({ value: s.id, label: s.name }))]}
                    value={form.store_id}
                    onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                    placeholder={t('common.select')}
                  />
                </div>
                {!editingId && (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('loans.installment_count')}</label>
                    <input className="form-input" type="number" min="2" max="60" data-testid="loan-installments"
                      value={form.installments} placeholder={t('loans.no_plan')}
                      onChange={(e) => setForm({ ...form, installments: e.target.value })} />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">{t('common.notes')}</label>
                <textarea className="form-input" rows={2} value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" data-testid="loan-save">
                  {editingId ? t('common.update') : t('common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- detail */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700, maxHeight: '88vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()} data-testid="loan-detail">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>{detail.borrower_full_name || detail.borrower_name}</h2>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {detail.is_overdue && <span className="badge badge-danger">{t('loans.overdue')}</span>}
                <span className={`badge ${statusColors[detail.status]}`}>{t(`loans.${detail.status}`)}</span>
                <button className="btn btn-sm btn-secondary" onClick={printStatement}>{t('loans.print_statement')}</button>
              </div>
            </div>

            {detail.borrower_username && <p style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>@{detail.borrower_username}</p>}
            {detail.borrower_phone && <p style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>{detail.borrower_phone}</p>}

            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
              {t('loans.amount')}: <strong>{money(detail.amount, currency)}</strong> &nbsp;•&nbsp;
              {t('loans.paid_back')}: <strong style={{ color: 'var(--color-success)' }}>{money(detail.paid_amount, currency)}</strong> &nbsp;•&nbsp;
              {t('loans.remaining')}: <strong style={{ color: 'var(--color-danger)' }}>{money(detail.remaining, currency)}</strong>
            </p>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 'var(--spacing-md)' }}>
              {t('loans.loan_date')}: {dateInput(detail.loan_date)}
              {detail.due_date && <> &nbsp;•&nbsp; {t('loans.due_date')}: {dateInput(detail.due_date)}</>}
              {detail.store_name && <> &nbsp;•&nbsp; {t('common.store')}: {detail.store_name}</>}
            </p>
            {detail.notes && <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 'var(--spacing-md)', fontStyle: 'italic' }}>{detail.notes}</p>}

            {/* ---- instalment plan ---- */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>{t('loans.installments')}</h3>
              {canWrite && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input className="form-input" type="number" min="0" max="60" style={{ width: 90 }}
                    data-testid="plan-count" value={planCount} placeholder={t('loans.no_plan')}
                    onChange={(e) => setPlanCount(e.target.value)} />
                  <button className="btn btn-sm btn-secondary" data-testid="save-plan" onClick={savePlan}>
                    {t('loans.set_plan')}
                  </button>
                </div>
              )}
            </div>
            {detail.installments?.length > 0 ? (
              <div className="table-container" style={{ marginTop: 8, marginBottom: 'var(--spacing-md)' }}>
                <table className="table" style={{ fontSize: '.9em' }}>
                  <thead><tr>
                    <th>#</th><th>{t('loans.due_date')}</th><th>{t('loans.amount')}</th>
                    <th>{t('loans.paid_back')}</th><th>{t('common.status')}</th>
                  </tr></thead>
                  <tbody>{detail.installments.map((i) => (
                    <tr key={i.id} data-testid={`installment-${i.seq}`}>
                      <td>{i.seq}</td>
                      <td>{dateInput(i.due_date)}</td>
                      <td>{money(i.amount, currency)}</td>
                      <td style={{ color: 'var(--color-success)' }}>{money(i.paid, currency)}</td>
                      <td>
                        {i.is_settled
                          ? <span className="badge badge-success">{t('loans.settled')}</span>
                          : i.is_overdue
                            ? <span className="badge badge-danger">{t('loans.overdue')}</span>
                            : i.paid > 0
                              ? <span className="badge badge-info">{t('loans.part_paid')}</span>
                              : <span className="badge badge-neutral">—</span>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '.9em', marginBottom: 'var(--spacing-md)' }}>
                {t('loans.no_plan')}
              </p>
            )}

            {/* ---- payments ---- */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
              <h3 style={{ margin: 0 }}>{t('loans.payments')} ({detail.payments?.length || 0})</h3>
              {canWrite && detail.status !== 'paid' && (
                <button className="btn btn-sm btn-primary" data-testid="add-loan-payment"
                  onClick={() => { setPaymentForm(emptyPayment); setShowPaymentForm(true); }}>
                  + {t('loans.add_payment')}
                </button>
              )}
            </div>

            {detail.payments?.length > 0 ? (
              <div className="table-container" style={{ maxHeight: 280, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr>
                    <th>{t('common.date')}</th><th>{t('loans.amount')}</th><th>{t('loans.method')}</th>
                    <th>{t('loans.proof')}</th><th>{t('common.notes')}</th>{canWrite && <th></th>}
                  </tr></thead>
                  <tbody>{detail.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{dateInput(p.payment_date)}</td>
                      <td><strong>{money(p.amount, currency)}</strong></td>
                      <td>{t(`payment_methods.${p.payment_method}`, {}) || p.payment_method}</td>
                      <td>
                        {p.proof_count > 0 && <span className="badge badge-success">{p.proof_count}</span>}
                        {canWrite && (
                          <label className="btn btn-sm btn-secondary" style={{ marginInlineStart: 6, cursor: 'pointer' }}>
                            {uploadingFor === p.id ? '…' : '+'}
                            <input type="file" accept="image/*" capture="environment" hidden
                              onChange={(e) => uploadProof(p.id, e.target.files?.[0])} />
                          </label>
                        )}
                      </td>
                      <td style={{ color: 'var(--color-text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.notes || '—'}</td>
                      {canWrite && <td><button className="btn btn-sm btn-danger" onClick={() => handleDeletePayment(p.id)}>✕</button></td>}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p style={{ color: 'var(--color-text-muted)' }}>{t('loans.no_payments')}</p>}

            {showPaymentForm && (
              <form onSubmit={handleAddPayment} className="card" style={{ marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)', border: '1px solid var(--color-border)' }}>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('loans.amount')} *</label>
                    <input className="form-input" type="number" step="0.01" min="0.01" data-testid="payment-amount"
                      max={detail.remaining} required value={paymentForm.amount}
                      onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('common.date')} *</label>
                    <input className="form-input" type="date" required value={paymentForm.payment_date}
                      onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">{t('loans.method')}</label>
                    <select className="form-input" value={paymentForm.payment_method}
                      onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>{t(`payment_methods.${m}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.notes')}</label>
                  <input className="form-input" value={paymentForm.notes}
                    onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPaymentForm(false)}>{t('common.cancel')}</button>
                  <button type="submit" className="btn btn-primary btn-sm" data-testid="payment-save">{t('common.save')}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table" data-testid="loans-table">
            <thead>
              <tr>
                <th>{t('loans.borrower')}</th>
                <th style={{ textAlign: 'end' }}>{t('loans.amount')}</th>
                <th style={{ textAlign: 'end' }}>{t('loans.paid_back')}</th>
                <th style={{ textAlign: 'end' }}>{t('loans.remaining')}</th>
                <th>{t('common.status')}</th>
                <th>{t('loans.due_date')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loans.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('loans.no_loans')}</td></tr>
              ) : loans.map((l) => (
                <tr key={l.id} className="product-row" data-testid={`loan-row-${l.id}`}
                  onClick={() => openDetail(l.id)}
                  style={l.is_overdue ? { borderInlineStart: '3px solid var(--color-danger)' } : undefined}>
                  <td>
                    <strong>{l.borrower_full_name || l.borrower_name}</strong>
                    {!l.borrower_user_id && (
                      <span className="badge badge-neutral" style={{ marginInlineStart: 6 }}>{t('loans.someone_else')}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'end' }}>{money(l.amount, '')}</td>
                  <td style={{ textAlign: 'end', color: 'var(--color-success)' }}>{money(l.paid_amount, '')}</td>
                  <td style={{ textAlign: 'end', color: Number(l.remaining) > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>
                    {money(l.remaining, '')}
                  </td>
                  <td>
                    <span className={`badge ${statusColors[l.status]}`}>{t(`loans.${l.status}`)}</span>
                  </td>
                  <td>
                    {l.due_date ? dateInput(l.due_date) : '—'}
                    <div style={{ marginTop: 2 }}>{dueLabel(l)}</div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                      {canWrite && (
                        <>
                          <button className="btn btn-sm btn-secondary" data-testid={`edit-loan-${l.id}`}
                            onClick={() => startEdit(l)}>{t('common.edit')}</button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(l.id)}>✕</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
