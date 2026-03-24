import { useState, useEffect } from 'react';
import { customersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ phone: '', name: '', notes: '' });
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('sales', 'write');
  const { t } = useTranslation();

  useEffect(() => { fetchCustomers(); }, []);

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const params = search ? { search } : {};
      const { data } = await customersAPI.list(params);
      setCustomers(data.data);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) { await customersAPI.update(editingId, form); toast.success('Updated'); }
      else { await customersAPI.create(form); toast.success('Created'); }
      setShowForm(false); setEditingId(null);
      setForm({ phone: '', name: '', notes: '' });
      fetchCustomers();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const openDetail = async (id) => {
    try { const { data } = await customersAPI.getById(id); setDetail(data.data); }
    catch { toast.error('Failed'); }
  };

  const handleSearch = (e) => { e.preventDefault(); fetchCustomers(); };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('customers.title')}</h1>
        {canWrite && <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm({ phone: '', name: '', notes: '' }); setShowForm(true); }}>{`+ ${t('customers.add_customer')}`}</button>}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="card" style={{ marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label">{t('customers.search_placeholder')}</label>
          <input className="form-input" value={search} placeholder={t('customers.search_placeholder')} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-secondary">{t('common.search')}</button>
      </form>

      {/* Create/Edit Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('common.edit') : t('common.create')} {t('sidebar.customers')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-row">
                <div className="form-group"><label className="form-label">{`${t('common.phone')} *`}</label>
                  <input className="form-input" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t('common.name')}</label>
                  <input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              </div>
              <div className="form-group"><label className="form-label">{t('common.notes')}</label>
                <textarea className="form-input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
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
          <div className="modal-content card" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
            <h2>{detail.name || 'Unknown'}</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>{`${t('common.phone')}:`} <strong>{detail.phone}</strong></p>
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>{t('customers.total_purchases')} ({detail.sales?.length || 0})</h3>
            {detail.sales?.length > 0 ? (
              <div className="table-container" style={{ maxHeight: 300, overflow: 'auto' }}>
                <table className="table"><thead><tr><th>{t('sales.sale_number')}</th><th>{t('sales.store')}</th><th>{t('common.total')}</th><th>{t('common.date')}</th></tr></thead>
                  <tbody>{detail.sales.map((s) => (
                    <tr key={s.id}><td>{s.sale_number}</td><td>{s.store_name}</td>
                      <td>{parseFloat(s.final_amount).toLocaleString()} EGP</td>
                      <td>{new Date(s.created_at).toLocaleDateString()}</td></tr>
                  ))}</tbody></table>
              </div>
            ) : <p style={{ color: 'var(--color-text-muted)' }}>{t('customers.no_customers')}</p>}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>{t('common.phone')}</th><th>{t('common.name')}</th><th>{t('common.notes')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {customers.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('customers.no_customers')}</td></tr>
              ) : customers.map((c) => (
                <tr key={c.id} className="product-row" onClick={() => openDetail(c.id)}>
                  <td><strong>{c.phone}</strong></td>
                  <td>{c.name || '—'}</td>
                  <td style={{ color: 'var(--color-text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.notes || '—'}</td>
                  <td>{canWrite && <button className="btn btn-sm btn-secondary" onClick={(e) => {
                    e.stopPropagation(); setForm({ phone: c.phone, name: c.name || '', notes: c.notes || '' }); setEditingId(c.id); setShowForm(true);
                  }}>{t('common.edit')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
