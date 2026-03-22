import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

// Direct API calls since usersAPI wasn't previously exported
import api from '../../api/client';

const usersAPI = {
  list: (params) => api.get('/users', { params }),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
};

const rolesAPI = {
  list: () => api.get('/users/roles'),
};

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', full_name: '', role_id: '', store_id: '' });
  const [editingId, setEditingId] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('users', 'write');

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [u, s] = await Promise.all([
        usersAPI.list(),
        api.get('/stores'),
      ]);
      setUsers(u.data.data);
      setStores(s.data.data);
      // Try to get roles
      try { const r = await rolesAPI.list(); setRoles(r.data.data); } catch {}
    } catch { toast.error('Failed'); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        role_id: form.role_id ? parseInt(form.role_id) : undefined,
        store_id: form.store_id || null,
      };
      if (editingId) {
        if (!payload.password) delete payload.password;
        delete payload.username;
        await usersAPI.update(editingId, payload);
        toast.success('Updated');
      } else {
        await usersAPI.create(payload);
        toast.success('Created');
      }
      setShowForm(false); setEditingId(null);
      setForm({ username: '', password: '', full_name: '', role_id: '', store_id: '' });
      fetchAll();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Users</h1>
        {canWrite && <button className="btn btn-primary" onClick={() => {
          setEditingId(null);
          setForm({ username: '', password: '', full_name: '', role_id: '', store_id: '' });
          setShowForm(true);
        }}>+ Add User</button>}
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? 'Edit' : 'New'} User</h2>
            <form onSubmit={handleSubmit} className="product-form">
              {!editingId && (
                <div className="form-group"><label className="form-label">Username *</label>
                  <input className="form-input" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
              )}
              <div className="form-group"><label className="form-label">{editingId ? 'New Password (leave empty to keep)' : 'Password *'}</label>
                <input className="form-input" type="password" required={!editingId} value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
              <div className="form-group"><label className="form-label">Full Name *</label>
                <input className="form-input" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Role</label>
                  <SearchableSelect
                    options={[
                      { value: '', label: 'Select' },
                      ...roles.map((r) => ({ value: r.id, label: r.name }))
                    ]}
                    value={form.role_id}
                    onChange={(e) => setForm({ ...form, role_id: e.target.value })}
                  />
                </div>
                <div className="form-group"><label className="form-label">Store (optional)</label>
                  <SearchableSelect
                    options={[
                      { value: '', label: 'All stores / HQ' },
                      ...stores.map((s) => ({ value: s.id, label: s.name }))
                    ]}
                    value={form.store_id}
                    onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                  />
                </div>
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
            <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Store</th><th>Status</th>{canWrite && <th>Actions</th>}</tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.username}</strong></td>
                  <td>{u.full_name}</td>
                  <td><span className="badge badge-info">{u.role_name}</span></td>
                  <td>{u.store_name || 'All / HQ'}</td>
                  <td><span className={`badge ${u.is_active ? 'badge-success' : 'badge-danger'}`}>{u.is_active ? 'Active' : 'Inactive'}</span></td>
                  {canWrite && <td><button className="btn btn-sm btn-secondary" onClick={() => {
                    setForm({ username: u.username, password: '', full_name: u.full_name, role_id: u.role_id || '', store_id: u.store_id || '' });
                    setEditingId(u.id); setShowForm(true);
                  }}>Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
