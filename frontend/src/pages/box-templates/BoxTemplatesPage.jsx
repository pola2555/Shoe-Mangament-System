import { useState, useEffect } from 'react';
import { boxTemplatesAPI, productsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

export default function BoxTemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('products', 'write');

  const emptyForm = { name: '', product_id: '', notes: '', items: [{ color_label: '', size: '', quantity: '' }] };
  const [form, setForm] = useState(emptyForm);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [t, p] = await Promise.all([boxTemplatesAPI.list(), productsAPI.list()]);
      setTemplates(t.data.data);
      setProducts(p.data.data);
    } catch { toast.error('Failed to load templates'); }
    finally { setLoading(false); }
  };

  const startEdit = (tmpl) => {
    setForm({
      name: tmpl.name,
      product_id: tmpl.product_id || '',
      notes: tmpl.notes || '',
      items: tmpl.items.map(i => ({ color_label: i.color_label || '', size: i.size, quantity: String(i.quantity) })),
    });
    setEditingId(tmpl.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      name: form.name,
      product_id: form.product_id || null,
      notes: form.notes || null,
      items: form.items.filter(i => i.size && i.quantity).map(i => ({
        size: i.size,
        quantity: parseInt(i.quantity),
        color_label: i.color_label || null,
      })),
    };
    if (payload.items.length === 0) { toast.error('Add at least one size entry'); return; }
    try {
      if (editingId) {
        await boxTemplatesAPI.update(editingId, payload);
        toast.success('Template updated');
      } else {
        await boxTemplatesAPI.create(payload);
        toast.success('Template created');
      }
      setShowForm(false); setForm(emptyForm); setEditingId(null);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to save template');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this template?')) return;
    try {
      await boxTemplatesAPI.delete(id);
      toast.success('Template deleted');
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const addItem = () => setForm({ ...form, items: [...form.items, { color_label: '', size: '', quantity: '' }] });
  const removeItem = (idx) => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  const updateItem = (idx, field, value) => {
    const updated = form.items.map((item, i) => i === idx ? { ...item, [field]: value } : item);
    setForm({ ...form, items: updated });
  };

  // Group items by color_label for display
  const groupByColor = (items) => {
    const groups = {};
    items.forEach(i => {
      const label = i.color_label || 'No Color';
      if (!groups[label]) groups[label] = [];
      groups[label].push(i);
    });
    return groups;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Box Templates</h1>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true); }}>
            + New Template
          </button>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" style={{ maxWidth: 700, maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? 'Edit' : 'New'} Template</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Template Name *</label>
                  <input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Linked Product <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>(optional)</span></label>
                  <SearchableSelect
                    options={[
                      { value: '', label: 'Generic (any product)' },
                      ...products.map(p => ({ value: p.id, label: `${p.product_code} — ${p.model_name}` }))
                    ]}
                    value={form.product_id}
                    onChange={(e) => setForm({ ...form, product_id: e.target.value })}
                  />
                </div>
              </div>

              <h4 style={{ marginBottom: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)' }}>Size Distribution</h4>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
                Use <strong>Color Label</strong> to group sizes by color (e.g. "Black", "White"). Items with the same label will be grouped together when the template is applied.
              </p>

              <div className="table-container">
                <table className="table" style={{ minWidth: 400 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 150 }}>Color Label</th>
                      <th style={{ width: 80 }}>Size (EU) *</th>
                      <th style={{ width: 80 }}>Qty *</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((item, idx) => (
                      <tr key={idx}>
                        <td>
                          <input className="form-input" placeholder="e.g. Black" value={item.color_label} style={{ padding: '0.4rem' }}
                            onChange={(e) => updateItem(idx, 'color_label', e.target.value)} />
                        </td>
                        <td>
                          <input className="form-input" required value={item.size} style={{ padding: '0.4rem' }}
                            onChange={(e) => updateItem(idx, 'size', e.target.value)} />
                        </td>
                        <td>
                          <input className="form-input" required type="number" min="1" value={item.quantity} style={{ padding: '0.4rem' }}
                            onChange={(e) => updateItem(idx, 'quantity', e.target.value)} />
                        </td>
                        <td>
                          {form.items.length > 1 && (
                            <button type="button" className="btn btn-sm btn-danger" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeItem(idx)}>✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: 'var(--spacing-sm)' }} onClick={addItem}>+ Add Row</button>

              <div className="form-group" style={{ marginTop: 'var(--spacing-md)' }}>
                <label className="form-label">Notes</label>
                <textarea className="form-input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editingId ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Templates List */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        templates.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--spacing-2xl)' }}>
            No box templates yet. Create one to speed up box data entry.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--spacing-lg)' }}>
            {templates.map((tmpl) => {
              const groups = groupByColor(tmpl.items);
              const totalItems = tmpl.items.reduce((s, i) => s + i.quantity, 0);
              return (
                <div key={tmpl.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-md)' }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{tmpl.name}</h3>
                      {tmpl.product_name && (
                        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-primary-light)' }}>
                          {tmpl.product_code} — {tmpl.product_name}
                        </span>
                      )}
                      {!tmpl.product_id && (
                        <span className="badge badge-neutral" style={{ fontSize: '0.7em' }}>Generic</span>
                      )}
                    </div>
                    <span className="badge badge-info">{totalItems} items</span>
                  </div>

                  {/* Color groups preview */}
                  <div style={{ flex: 1, marginBottom: 'var(--spacing-md)' }}>
                    {Object.entries(groups).map(([label, items]) => (
                      <div key={label} style={{ marginBottom: 'var(--spacing-xs)' }}>
                        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: label === 'No Color' ? 'var(--color-text-muted)' : 'var(--color-primary-light)' }}>
                          {label}:
                        </span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                          {items.map(i => `EU ${i.size} ×${i.quantity}`).join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>

                  {tmpl.notes && (
                    <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 'var(--spacing-sm)' }}>{tmpl.notes}</p>
                  )}

                  {canWrite && (
                    <div style={{ display: 'flex', gap: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-sm)' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => startEdit(tmpl)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(tmpl.id)}>Delete</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
