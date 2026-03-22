import { useState, useEffect, useMemo } from 'react';
import { salesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

export default function SalesPage() {
  const [sales, setSales] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ search: '', store_id: '', dateFrom: '', dateTo: '' });
  const [detail, setDetail] = useState(null);

  useEffect(() => { fetchStores(); }, []);
  useEffect(() => { fetchSales(); }, []);

  const fetchStores = async () => {
    try { const { data } = await storesAPI.list(); setStores(data.data); } catch {}
  };

  const fetchSales = async () => {
    try {
      setLoading(true);
      const { data } = await salesAPI.list();
      setSales(data.data);
    } catch { toast.error('Failed to load sales'); }
    finally { setLoading(false); }
  };

  const filtered = useMemo(() => {
    let result = [...sales];
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(s =>
        s.sale_number.toLowerCase().includes(q) ||
        (s.customer_name && s.customer_name.toLowerCase().includes(q)) ||
        (s.customer_phone && s.customer_phone.includes(q))
      );
    }
    if (filters.store_id) result = result.filter(s => s.store_id === filters.store_id);
    if (filters.dateFrom) result = result.filter(s => s.created_at >= filters.dateFrom);
    if (filters.dateTo) result = result.filter(s => s.created_at.split('T')[0] <= filters.dateTo);
    return result;
  }, [sales, filters]);

  const openDetail = async (id) => {
    try { const { data } = await salesAPI.getById(id); setDetail(data.data); }
    catch { toast.error('Failed to load sale'); }
  };

  const fmt = (v) => parseFloat(v).toLocaleString();
  const totalRevenue = filtered.reduce((s, r) => s + (parseFloat(r.final_amount) - (parseFloat(r.refunded_amount) || 0)), 0);
  const activeFilterCount = [filters.store_id, filters.dateFrom, filters.dateTo].filter(Boolean).length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Sales History</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          <input className="form-input" placeholder="Search sale #, customer..." value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: 220 }} />
          <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters(!showFilters)}>
            🔍 Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>
        </div>
      </div>

      {/* Advanced Filters */}
      {showFilters && (
        <div className="filters-panel card">
          <div className="filters-grid">
            <div className="form-group">
              <label className="form-label">Store</label>
              <SearchableSelect
                options={[
                  { value: '', label: 'All Stores' },
                  ...stores.map((s) => ({ value: s.id, label: s.name }))
                ]}
                value={filters.store_id}
                onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
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
              {filtered.length} sales &nbsp;•&nbsp; Revenue: <strong style={{ color: 'var(--color-success)' }}>{totalRevenue.toLocaleString()} EGP</strong>
            </span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary"
              onClick={() => setFilters({ search: '', store_id: '', dateFrom: '', dateTo: '' })}>Clear All</button>}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>{detail.sale_number}</h2>
            <div style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
              <p>Store: <strong>{detail.store_name}</strong> &nbsp;•&nbsp;
                {detail.customer_name ? `Customer: ${detail.customer_name} (${detail.customer_phone})` : 'Walk-in customer'}</p>
              <p>Subtotal: {fmt(detail.total_amount)} EGP &nbsp;•&nbsp;
                Discount: {fmt(detail.discount_amount)} EGP &nbsp;•&nbsp;
                Final: {fmt(detail.final_amount)} EGP &nbsp;•&nbsp;
                Refunded: <span style={{ color: parseFloat(detail.refunded_amount) > 0 ? 'var(--color-danger)' : 'inherit' }}>{parseFloat(detail.refunded_amount) > 0 ? `-${fmt(detail.refunded_amount)} EGP` : '0 EGP'}</span> &nbsp;•&nbsp;
                <strong>Net Sale: {fmt(parseFloat(detail.final_amount) - (parseFloat(detail.refunded_amount) || 0))} EGP</strong></p>
              <p>Sold by: {detail.created_by_name} &nbsp;•&nbsp; {new Date(detail.created_at).toLocaleString()}</p>
            </div>

            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>Items</h3>
            <div className="table-container" style={{ maxHeight: 250, overflow: 'auto', marginBottom: 'var(--spacing-lg)' }}>
              <table className="table">
                <thead><tr><th>SKU</th><th>Product</th><th>Color</th><th>Size</th><th>Cost</th><th>Sold At</th><th>Profit</th></tr></thead>
                <tbody>
                  {detail.items.map((item) => {
                    const profit = parseFloat(item.sale_price) - parseFloat(item.cost_at_sale || item.cost);
                    const isReturned = item.is_returned;
                    return (
                      <tr key={item.id} style={{ backgroundColor: isReturned ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}>
                        <td><strong>{item.sku}</strong></td>
                        <td>
                          {item.product_code} — {item.product_name}
                          {isReturned && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: '0.7em' }}>Returned</span>}
                        </td>
                        <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                          {item.color_name}</span></td>
                        <td>EU {item.size_eu}</td>
                        <td>{fmt(item.cost_at_sale || item.cost)} EGP</td>
                        <td>{fmt(item.sale_price)} EGP</td>
                        <td style={{ color: profit >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>{fmt(profit)} EGP</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>Payments</h3>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
              {detail.payments.map((p) => (
                <div key={p.id} className="badge badge-neutral" style={{ padding: '6px 12px' }}>
                  {p.payment_method}: {fmt(p.amount)} EGP{p.reference_no && ` (${p.reference_no})`}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sales Table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>Sale #</th><th>Store</th><th>Customer</th><th>Items</th><th>Total</th><th>Discount</th><th>Final</th><th>Refunded</th><th>Net Sale</th><th>Date</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>No sales found.</td></tr>
              ) : filtered.map((s) => {
                const isRefunded = parseFloat(s.refunded_amount) > 0;
                const isFullyRefunded = parseFloat(s.refunded_amount) >= parseFloat(s.final_amount) && parseFloat(s.final_amount) > 0;
                
                return (
                  <tr key={s.id} className="product-row" onClick={() => openDetail(s.id)} style={{ backgroundColor: isRefunded ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{s.sale_number}</strong>
                        {isRefunded && (
                          <span className={`badge ${isFullyRefunded ? 'badge-danger' : 'badge-warning'}`} style={{ fontSize: '0.7em', padding: '2px 6px' }}>
                            {isFullyRefunded ? 'Returned entirely' : 'Partial Return'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>{s.store_name}</td>
                    <td>{s.customer_name || 'Walk-in'}{s.customer_phone ? ` (${s.customer_phone})` : ''}</td>
                    <td>—</td>
                    <td>{fmt(s.total_amount)} EGP</td>
                    <td>{parseFloat(s.discount_amount) > 0 ? `${fmt(s.discount_amount)} EGP` : '—'}</td>
                    <td style={{ textDecoration: isFullyRefunded ? 'line-through' : 'none', color: isFullyRefunded ? 'var(--color-text-muted)' : 'inherit' }}>
                      {fmt(s.final_amount)} EGP
                    </td>
                    <td style={{ color: isRefunded ? 'var(--color-danger)' : 'var(--color-text-muted)', fontWeight: isRefunded ? 600 : 400 }}>
                      {isRefunded ? `-${fmt(s.refunded_amount)} EGP` : '—'}
                    </td>
                    <td><strong style={{ color: isFullyRefunded ? 'var(--color-danger)' : 'inherit' }}>{fmt(parseFloat(s.final_amount) - (parseFloat(s.refunded_amount) || 0))} EGP</strong></td>
                    <td>{new Date(s.created_at).toLocaleString()}</td>
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
