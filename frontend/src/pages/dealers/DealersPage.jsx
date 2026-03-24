import { useState, useEffect } from 'react';
import { dealersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from '../../i18n/i18nContext';
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
  const { t } = useTranslation();

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
    if (!window.confirm(t('common.are_you_sure'))) return;
    try {
      await dealersAPI.delete(id);
      toast.success('Dealer deleted');
      fetchDealers();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const fmt = (v) => v != null ? `${parseFloat(v).toLocaleString()} EGP` : '—';

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
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>{t('suppliers.payments')} ({detail.payments.length})</h3>
            <div className="table-container" style={{ maxHeight: 200, overflow: 'auto' }}>
              <table className="table"><thead><tr><th>{t('common.date')}</th><th>{t('sales.payment_method')}</th><th>{t('common.amount')}</th><th>Ref</th></tr></thead>
                <tbody>{detail.payments.map((p) => (
                  <tr key={p.id}><td>{new Date(p.payment_date).toLocaleDateString()}</td><td>{p.payment_method}</td><td>{fmt(p.total_amount)}</td><td>{p.reference_no || '—'}</td></tr>
                ))}</tbody></table>
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
