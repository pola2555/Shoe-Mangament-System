import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { suppliersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import '../products/Products.css';

export default function SuppliersListPage() {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', phone: '', email: '', address: '', notes: '' });
  const [editingId, setEditingId] = useState(null);
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { fetchSuppliers(); }, []);

  const fetchSuppliers = async () => {
    try {
      setLoading(true);
      const { data } = await suppliersAPI.list();
      setSuppliers(data.data);
    } catch { toast.error('Failed to load suppliers'); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        await suppliersAPI.update(editingId, formData);
        toast.success('Supplier updated');
      } else {
        await suppliersAPI.create(formData);
        toast.success('Supplier created');
      }
      setShowForm(false);
      setFormData({ name: '', phone: '', email: '', address: '', notes: '' });
      setEditingId(null);
      fetchSuppliers();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to save');
    }
  };

  const startEdit = (s) => {
    setFormData({ name: s.name, phone: s.phone || '', email: s.email || '', address: s.address || '', notes: s.notes || '' });
    setEditingId(s.id);
    setShowForm(true);
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this supplier? Cannot delete if they have invoices.')) return;
    try {
      await suppliersAPI.delete(id);
      toast.success('Supplier deleted');
      fetchSuppliers();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const fmt = (v) => v != null ? `${parseFloat(v).toLocaleString()} EGP` : '—';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Suppliers</h1>
        {hasPermission('purchases', 'write') && (
          <button className="btn btn-primary" onClick={() => { setEditingId(null); setFormData({ name: '', phone: '', email: '', address: '', notes: '' }); setShowForm(true); }}>
            + Add Supplier
          </button>
        )}
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? 'Edit' : 'New'} Supplier</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input className="form-input" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Address</label>
                <textarea className="form-input" rows={2} value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editingId ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Phone</th><th>Total Invoiced</th><th>Total Paid</th><th>Balance</th><th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className="product-row" onClick={() => navigate(`/suppliers/${s.id}`)}>
                  <td><strong>{s.name}</strong></td>
                  <td>{s.phone || '—'}</td>
                  <td>{fmt(s.total_invoiced)}</td>
                  <td>{fmt(s.total_paid)}</td>
                  <td style={{ color: s.balance > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>
                    {fmt(s.balance)}
                  </td>
                  <td><span className={`badge ${s.is_active ? 'badge-success' : 'badge-danger'}`}>{s.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    {hasPermission('purchases', 'write') && (
                      <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                        <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); startEdit(s); }}>Edit</button>
                        <button className="btn btn-sm btn-danger" onClick={(e) => handleDelete(e, s.id)}>Delete</button>
                      </div>
                    )}
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
