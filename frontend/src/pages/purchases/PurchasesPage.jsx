import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { purchasesAPI, suppliersAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

export default function PurchasesPage() {
  const [invoices, setInvoices] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ search: '', supplier_id: '', status: '', dateFrom: '', dateTo: '' });
  const [form, setForm] = useState({
    supplier_id: '', total_amount: '', invoice_date: new Date().toISOString().split('T')[0], notes: '',
  });
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [inv, sup] = await Promise.all([purchasesAPI.listInvoices(), suppliersAPI.list()]);
      setInvoices(inv.data.data);
      setSuppliers(sup.data.data);
    } catch { toast.error('Failed to load data'); }
    finally { setLoading(false); }
  };

  const filtered = useMemo(() => {
    let result = [...invoices];
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(i => i.invoice_number.toLowerCase().includes(q) || (i.supplier_name && i.supplier_name.toLowerCase().includes(q)));
    }
    if (filters.supplier_id) result = result.filter(i => i.supplier_id === filters.supplier_id);
    if (filters.status) result = result.filter(i => i.status === filters.status);
    if (filters.dateFrom) result = result.filter(i => i.invoice_date >= filters.dateFrom);
    if (filters.dateTo) result = result.filter(i => i.invoice_date <= filters.dateTo);
    return result;
  }, [invoices, filters]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, total_amount: parseFloat(form.total_amount), boxes: [] };
      const { data } = await purchasesAPI.createInvoice(payload);
      toast.success(`Invoice ${data.data.invoice_number} created`);
      setShowForm(false);
      navigate(`/purchases/${data.data.id}`);
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const statusColors = { pending: 'badge-warning', partial: 'badge-info', paid: 'badge-success' };
  const activeFilterCount = [filters.supplier_id, filters.status, filters.dateFrom, filters.dateTo].filter(Boolean).length;
  const totalAmount = filtered.reduce((s, i) => s + parseFloat(i.total_amount), 0);
  const totalPaid = filtered.reduce((s, i) => s + parseFloat(i.paid_amount), 0);

  const handleDeleteInvoice = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this invoice?')) return;
    try {
      await purchasesAPI.deleteInvoice(id);
      toast.success('Invoice deleted successfully');
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete invoice');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Purchase Invoices</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          <input className="form-input" placeholder="Search invoices..." value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: 200 }} />
          <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters(!showFilters)}>
            🔍 Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>
          {hasPermission('purchases', 'write') && (
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ New Invoice</button>
          )}
        </div>
      </div>

      {/* Advanced Filters */}
      {showFilters && (
        <div className="filters-panel card">
          <div className="filters-grid">
            <div className="form-group">
              <label className="form-label">Supplier</label>
              <SearchableSelect
                options={[
                  { value: '', label: 'All Suppliers' },
                  ...suppliers.map(s => ({ value: s.id, label: s.name }))
                ]}
                value={filters.supplier_id}
                onChange={(e) => setFilters({ ...filters, supplier_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Status</label>
              <SearchableSelect
                options={[
                  { value: '', label: 'All' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'paid', label: 'Paid' }
                ]}
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Date From</label>
              <input className="form-input" type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Date To</label>
              <input className="form-input" type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-sm)' }}>
            <span className="filter-count">
              {filtered.length} invoices &nbsp;•&nbsp; Total: <strong>{totalAmount.toLocaleString()} EGP</strong> &nbsp;•&nbsp; Paid: <strong>{totalPaid.toLocaleString()} EGP</strong> &nbsp;•&nbsp; Remaining: <strong style={{ color: 'var(--color-danger)' }}>{(totalAmount - totalPaid).toLocaleString()} EGP</strong>
            </span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary"
              onClick={() => setFilters({ search: '', supplier_id: '', status: '', dateFrom: '', dateTo: '' })}>Clear All</button>}
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>New Purchase Invoice</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-group">
                <label className="form-label">Supplier *</label>
                <SearchableSelect
                  required
                  options={[
                    { value: '', label: 'Select supplier' },
                    ...suppliers.map(s => ({ value: s.id, label: s.name }))
                  ]}
                  value={form.supplier_id}
                  onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                />
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Total Amount *</label>
                  <input className="form-input" type="number" step="0.01" required value={form.total_amount}
                    onChange={(e) => setForm({ ...form, total_amount: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">Invoice Date *</label>
                  <input className="form-input" type="date" required value={form.invoice_date}
                    onChange={(e) => setForm({ ...form, invoice_date: e.target.value })} /></div>
              </div>
              <div className="form-group"><label className="form-label">Notes</label>
                <textarea className="form-input" rows={2} value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>Invoice #</th><th>Supplier</th><th>Date</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Status</th>{hasPermission('purchases', 'write') && <th style={{textAlign: 'right'}}>Actions</th>}</tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={hasPermission('purchases', 'write') ? 8 : 7} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>No invoices found.</td></tr>
              ) : filtered.map((inv) => {
                const remaining = parseFloat(inv.total_amount) - (parseFloat(inv.discount_amount) || 0) - parseFloat(inv.paid_amount);
                return (
                  <tr key={inv.id} className="product-row" onClick={() => navigate(`/purchases/${inv.id}`)}>
                    <td><strong>{inv.invoice_number}</strong></td>
                    <td>{inv.supplier_name}</td>
                    <td>{new Date(inv.invoice_date).toLocaleDateString()}</td>
                    <td>{parseFloat(inv.total_amount).toLocaleString()} EGP</td>
                    <td>{parseFloat(inv.paid_amount).toLocaleString()} EGP</td>
                    <td style={{ color: remaining > 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>
                      {remaining.toLocaleString()} EGP
                    </td>
                    <td><span className={`badge ${statusColors[inv.status]}`}>{inv.status}</span></td>
                    {hasPermission('purchases', 'write') && (
                      <td style={{textAlign: 'right'}}>
                        <button className="btn btn-sm btn-danger" onClick={(e) => handleDeleteInvoice(e, inv.id)}>Delete</button>
                      </td>
                    )}
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
