import { useState, useEffect, useMemo } from 'react';
import { salesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

export default function SalesPage() {
  const [sales, setSales] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ search: '', store_id: '', dateFrom: '', dateTo: '' });
  const [detail, setDetail] = useState(null);
  const [exporting, setExporting] = useState(false);
  const { filterStores } = useAuth();
  const { t } = useTranslation();

  useEffect(() => { fetchStores(); }, []);
  useEffect(() => { fetchSales(); }, []);

  const fetchStores = async () => {
    try { const { data } = await storesAPI.list(); setStores(filterStores(data.data)); } catch {}
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
    // Filter by assigned stores
    if (stores.length > 0) {
      const storeIds = stores.map(s => s.id);
      result = result.filter(s => storeIds.includes(s.store_id));
    }
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

  const handleExport = async () => {
    try {
      setExporting(true);
      const params = {};
      if (filters.store_id) params.store_id = filters.store_id;
      if (filters.dateFrom) params.startDate = filters.dateFrom;
      if (filters.dateTo) params.endDate = filters.dateTo;
      const { data } = await salesAPI.exportExcel(params);
      const url = window.URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `sales_export_${new Date().toISOString().split('T')[0]}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { toast.error(t('common.error')); }
    finally { setExporting(false); }
  };

  const fmt = (v) => parseFloat(v).toLocaleString();
  const totalRevenue = filtered.reduce((s, r) => s + (parseFloat(r.final_amount) - (parseFloat(r.refunded_amount) || 0)), 0);
  const activeFilterCount = [filters.store_id, filters.dateFrom, filters.dateTo].filter(Boolean).length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('sales.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          <input className="form-input" placeholder={t('sales.search_placeholder')} value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: 220 }} />
          <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters(!showFilters)}>
            🔍 {t('common.filters')}{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>
          <button className="btn btn-secondary" onClick={handleExport} disabled={exporting}>
            📥 {exporting ? t('common.loading') : t('common.export')}
          </button>
        </div>
      </div>

      {/* Advanced Filters */}
      {showFilters && (
        <div className="filters-panel card">
          <div className="filters-grid">
            <div className="form-group">
              <label className="form-label">{t('sales.store')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('stores.all_stores') },
                  ...stores.map((s) => ({ value: s.id, label: s.name }))
                ]}
                value={filters.store_id}
                onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.from')}</label>
              <input className="form-input" type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.to')}</label>
              <input className="form-input" type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-sm)' }}>
            <span className="filter-count">
              {filtered.length} {t('sales.title').toLowerCase()} &nbsp;•&nbsp; {t('reports.revenue')}: <strong style={{ color: 'var(--color-success)' }}>{totalRevenue.toLocaleString()} {t('common.currency')}</strong>
            </span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary"
              onClick={() => setFilters({ search: '', store_id: '', dateFrom: '', dateTo: '' })}>{t('common.clear')}</button>}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-md)' }}>{detail.sale_number}</h2>
            <div style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
              <p>{t('sales.store')}: <strong>{detail.store_name}</strong> &nbsp;•&nbsp;
                {detail.customer_name ? `Customer: ${detail.customer_name} (${detail.customer_phone})` : t('pos.walk_in')}</p>
              <p>{t('pos.subtotal')}: {fmt(detail.total_amount)} {t('common.currency')} &nbsp;•&nbsp;
                {t('pos.discount')}: {fmt(detail.discount_amount)} {t('common.currency')} &nbsp;•&nbsp;
                {t('sales.final_amount')}: {fmt(detail.final_amount)} {t('common.currency')} &nbsp;•&nbsp;
                {t('sales.refunded')}: <span style={{ color: parseFloat(detail.refunded_amount) > 0 ? 'var(--color-danger)' : 'inherit' }}>{parseFloat(detail.refunded_amount) > 0 ? `-${fmt(detail.refunded_amount)} ${t('common.currency')}` : `0 ${t('common.currency')}`}</span> &nbsp;•&nbsp;
                <strong>{t('reports.net_sales')}: {fmt(parseFloat(detail.final_amount) - (parseFloat(detail.refunded_amount) || 0))} {t('common.currency')}</strong></p>
              <p>Sold by: {detail.created_by_name} &nbsp;•&nbsp; {new Date(detail.created_at).toLocaleString()}</p>
            </div>

            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>{t('sales.items')}</h3>
            <div className="table-container" style={{ maxHeight: 250, overflow: 'auto', marginBottom: 'var(--spacing-lg)' }}>
              <table className="table">
                <thead><tr><th>{t('inventory.sku')}</th><th>{t('sidebar.products')}</th><th>{t('sales.color')}</th><th>{t('sales.size')}</th><th>{t('sales.cost')}</th><th>{t('sales.unit_price')}</th><th>{t('sales.profit')}</th></tr></thead>
                <tbody>
                  {detail.items.map((item) => {
                    const profit = parseFloat(item.sale_price) - parseFloat(item.cost_at_sale || item.cost);
                    const isReturned = item.is_returned;
                    return (
                      <tr key={item.id} style={{ backgroundColor: isReturned ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}>
                        <td><strong>{item.sku}</strong></td>
                        <td>
                          {item.product_code} — {item.product_name}
                          {isReturned && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: '0.7em' }}>{t('sales.refunded')}</span>}
                        </td>
                        <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                          {item.color_name}</span></td>
                        <td>EU {item.size_eu}</td>
                        <td>{fmt(item.cost_at_sale || item.cost)} {t('common.currency')}</td>
                        <td>{fmt(item.sale_price)} {t('common.currency')}</td>
                        <td style={{ color: profit >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>{fmt(profit)} {t('common.currency')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>{t('sales.payments')}</h3>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
              {detail.payments.map((p) => (
                <div key={p.id} className="badge badge-neutral" style={{ padding: '6px 12px' }}>
                  {p.payment_method}: {fmt(p.amount)} {t('common.currency')}{p.reference_no && ` (${p.reference_no})`}
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
            <thead><tr><th>{t('sales.sale_number')}</th><th>{t('sales.store')}</th><th>{t('sales.customer')}</th><th>{t('sales.items')}</th><th>{t('sales.total')}</th><th>{t('pos.discount')}</th><th>{t('sales.final_amount')}</th><th>{t('sales.refunded')}</th><th>{t('reports.net_sales')}</th><th>{t('sales.date')}</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('sales.no_sales')}</td></tr>
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
                            {isFullyRefunded ? t('sales.refunded') : t('sales.partial')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>{s.store_name}</td>
                    <td>{s.customer_name || t('pos.walk_in')}{s.customer_phone ? ` (${s.customer_phone})` : ''}</td>
                    <td>—</td>
                    <td>{fmt(s.total_amount)} {t('common.currency')}</td>
                    <td>{parseFloat(s.discount_amount) > 0 ? `${fmt(s.discount_amount)} ${t('common.currency')}` : '—'}</td>
                    <td style={{ textDecoration: isFullyRefunded ? 'line-through' : 'none', color: isFullyRefunded ? 'var(--color-text-muted)' : 'inherit' }}>
                      {fmt(s.final_amount)} {t('common.currency')}
                    </td>
                    <td style={{ color: isRefunded ? 'var(--color-danger)' : 'var(--color-text-muted)', fontWeight: isRefunded ? 600 : 400 }}>
                      {isRefunded ? `-${fmt(s.refunded_amount)} ${t('common.currency')}` : '—'}
                    </td>
                    <td><strong style={{ color: isFullyRefunded ? 'var(--color-danger)' : 'inherit' }}>{fmt(parseFloat(s.final_amount) - (parseFloat(s.refunded_amount) || 0))} {t('common.currency')}</strong></td>
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
