import { useState, useEffect } from 'react';
import { storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

export default function StoresPage() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', phone: '' });
  const [editingId, setEditingId] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('stores', 'write');
  const { t } = useTranslation();

  useEffect(() => { fetchStores(); }, []);

  const fetchStores = async () => {
    try { setLoading(true); const { data } = await storesAPI.list(); setStores(data.data); }
    catch { toast.error('Failed'); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) { await storesAPI.update(editingId, form); toast.success(t('common.success')); }
      else { await storesAPI.create(form); toast.success(t('common.success')); }
      setShowForm(false); setEditingId(null);
      setForm({ name: '', address: '', phone: '' });
      fetchStores();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('stores.title')}</h1>
        {canWrite && <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm({ name: '', address: '', phone: '' }); setShowForm(true); }}>+ {t('stores.add_store')}</button>}
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('common.edit') : t('common.create')} {t('sidebar.stores')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-group"><label className="form-label">{t('common.name')} *</label>
                <input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('common.phone')}</label>
                  <input className="form-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t('common.address')}</label>
                  <input className="form-input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{editingId ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.phone')}</th><th>{t('common.address')}</th><th>{t('common.status')}</th>{canWrite && <th>{t('common.actions')}</th>}</tr></thead>
            <tbody>
              {stores.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td>{s.phone || '—'}</td>
                  <td>{s.address || '—'}</td>
                  <td><span className={`badge ${s.is_active ? 'badge-success' : 'badge-danger'}`}>{s.is_active ? t('common.active') : t('common.inactive')}</span></td>
                  {canWrite && <td><button className="btn btn-sm btn-secondary" onClick={() => {
                    setForm({ name: s.name, phone: s.phone || '', address: s.address || '' }); setEditingId(s.id); setShowForm(true);
                  }}>{t('common.edit')}</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
