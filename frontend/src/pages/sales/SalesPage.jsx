import { useState, useEffect } from 'react';
import { salesAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { formatSize, formatColor } from '../../utils/variantFormat';
import SearchableSelect from '../../components/common/SearchableSelect';
import ClickableImage from '../../components/common/ClickableImage';
import { useTranslation } from '../../i18n/i18nContext';
import ReceiptModal from '../../components/sales/ReceiptModal';
import Pagination from '../../components/common/Pagination';
import '../products/Products.css';

export default function SalesPage() {
  const [sales, setSales] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ search: '', store_id: '', dateFrom: '', dateTo: '' });
  const [detail, setDetail] = useState(null);
  const [receiptFor, setReceiptFor] = useState(null);
  const [exporting, setExporting] = useState(false);
  // Voided sales are hidden by default: they did not happen. The switch brings them
  // back, greyed, because the record still has to be reachable.
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ revenue: 0 });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const { filterStores, hasPermission } = useAuth();
  const canVoid = hasPermission('sale_void', 'write');
  const { t, locale } = useTranslation();

  useEffect(() => { fetchStores(); }, []);

  // Every filter runs on the SERVER — search (a sale is findable by its product, which
  // the rows here cannot see), store, and date range — so the page count and the total
  // describe the WHOLE record and not just the 200 rows the browser used to hold.
  // Debounced, so typing is one request, not one per keystroke.
  useEffect(() => {
    const id = setTimeout(() => fetchSales(), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVoided, filters, page, limit]);

  // Any filter change resets to the first page — page 4 of the old filter is meaningless
  // under the new one, and would read as an empty result.
  const setFilter = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };

  const fetchStores = async () => {
    try { const { data } = await storesAPI.list(); setStores(filterStores(data.data)); } catch {}
  };

  const fetchSales = async () => {
    try {
      setLoading(true);
      // Voided sales are excluded by the server unless asked for: they did not happen,
      // so they must not sit in the list looking like takings.
      const params = { page, limit };
      if (showVoided) params.include_voided = true;
      if (filters.search.trim()) params.search = filters.search.trim();
      if (filters.store_id) params.store_id = filters.store_id;
      if (filters.dateFrom) params.startDate = filters.dateFrom;
      if (filters.dateTo) params.endDate = filters.dateTo;
      const { data } = await salesAPI.list(params);
      setSales(data.data);
      if (data.pagination) setPagination(data.pagination);
      setSummary(data.summary || { revenue: 0 });
    } catch { toast.error('Failed to load sales'); }
    finally { setLoading(false); }
  };

  // The server has already applied every filter and the store scope, so the rows are
  // rendered as they arrive. (Kept as `filtered` so the table below is untouched.)
  const filtered = sales;

  /**
   * Void a sale: the stock goes back and it leaves every report.
   *
   * Not a return — a return is the customer bringing goods back, and that is recorded
   * separately. This is the till saying the sale never happened.
   */
  const handleVoid = async (id) => {
    if (!confirm(t('sales.void_confirm'))) return;
    const reason = prompt(t('sales.void_reason')) || '';
    try {
      setVoiding(true);
      await salesAPI.void(id, { reason });
      toast.success(t('sales.sale_voided'));
      setDetail(null);
      fetchSales();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setVoiding(false); }
  };

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
      // Export what is on screen. A search that narrowed the table to one product and
      // an export that quietly ignored it is the kind of mismatch nobody checks.
      if (filters.search.trim()) params.search = filters.search.trim();
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
  // The revenue over the WHOLE filtered set comes from the server now — a browser sum of
  // the fifty rows on screen would shrink every time you turned the page. Voided sales
  // are excluded there, even when shown for the record.
  const totalRevenue = summary.revenue;
  const activeFilterCount = [filters.store_id, filters.dateFrom, filters.dateTo].filter(Boolean).length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('sales.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          <input className="form-input" data-testid="sales-search"
            placeholder={t('sales.search_placeholder')} value={filters.search}
            onChange={(e) => setFilter({ search: e.target.value })} style={{ width: 220 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={showVoided} data-testid="show-voided"
              onChange={(e) => setShowVoided(e.target.checked)} />
            {t('sales.show_voided')}
          </label>
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
                onChange={(e) => setFilter({ store_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.from')}</label>
              <input className="form-input" type="date" value={filters.dateFrom} onChange={(e) => setFilter({ dateFrom: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.to')}</label>
              <input className="form-input" type="date" value={filters.dateTo} onChange={(e) => setFilter({ dateTo: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-sm)' }}>
            <span className="filter-count">
              {filtered.length} {t('sales.title').toLowerCase()} &nbsp;•&nbsp; {t('reports.revenue')}: <strong style={{ color: 'var(--color-success)' }}>{totalRevenue.toLocaleString()} {t('common.currency')}</strong>
            </span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary"
              onClick={() => { setFilters({ search: '', store_id: '', dateFrom: '', dateTo: '' }); setPage(1); }}>{t('common.clear')}</button>}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
            <div className="sale-detail-head">
              <h2>{detail.sale_number}</h2>
              {/* The receipt exists whether or not it was printed at the till, so a
                  customer who comes back for one can still be given it. */}
              <button className="btn btn-sm btn-secondary" data-testid="sale-receipt"
                onClick={() => setReceiptFor(detail.id)}>
                {t('receipt.show')}
              </button>
            </div>
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
                <thead><tr><th>{t('sales.image')}</th><th>{t('inventory.sku')}</th><th>{t('sidebar.products')}</th><th>{t('sales.color')}</th><th>{t('sales.size')}</th><th>{t('sales.cost')}</th><th>{t('sales.unit_price')}</th><th>{t('sales.profit')}</th></tr></thead>
                <tbody>
                  {detail.items.map((item) => {
                    const profit = parseFloat(item.sale_price) - parseFloat(item.cost_at_sale || item.cost);
                    const isReturned = item.is_returned;
                    return (
                      <tr key={item.id} style={{ backgroundColor: isReturned ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}>
                        {/* The thumbnail loads; the full picture opens on click. A sale
                            is far quicker to recognise by its photo than by its SKU. */}
                        <td>
                          <ClickableImage
                            src={item.color_image_url}
                            thumbSrc={item.color_image_thumb_url}
                            alt={item.product_name}
                            title={[item.product_name, formatColor(item)].filter(Boolean).join(' — ')}
                            width={44} height={44}
                            style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }}
                          />
                        </td>
                        <td><strong>{item.sku}</strong></td>
                        <td>
                          {item.product_code} — {item.product_name}
                          {isReturned && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: '0.7em' }}>{t('sales.refunded')}</span>}
                        </td>
                        {/* formatColor, not item.color_name. A colourless category —
                            a knife, a tool — carries a placeholder colour row so the
                            variant key and the SKU still work, and printing its name
                            raw put "Standard" in the Colour column as though it were a
                            colour somebody had chosen. formatSize on the next line was
                            already doing the equivalent for size; colour was missed. */}
                        <td><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {!item.color_is_placeholder && item.hex_code &&
                            <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                          {formatColor(item) || '—'}</span></td>
                        <td>{formatSize(item, locale) || '—'}</td>
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
                  <tr key={s.id} className="product-row" data-testid={`sale-row-${s.id}`}
                    onClick={() => openDetail(s.id)}
                    style={{
                      backgroundColor: isRefunded ? 'rgba(239, 68, 68, 0.05)' : 'transparent',
                      opacity: s.voided_at ? 0.5 : 1,
                      textDecoration: s.voided_at ? 'line-through' : 'none',
                    }}>
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
                    {/* What was actually sold. This column printed a dash until the
                        search could match a product — at which point a result with
                        nothing but a receipt number on it says nothing about why it
                        matched. */}
                    <td>
                      {s.item_count ? (
                        <>
                          <strong>{s.item_count}</strong>
                          {s.item_products?.length > 0 && (
                            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                              {s.item_products.join(', ')}
                              {s.item_products_more > 0 ? ` +${s.item_products_more}` : ''}
                            </div>
                          )}
                        </>
                      ) : '—'}
                    </td>
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
          <Pagination
            pagination={pagination}
            onPage={setPage}
            onLimit={(n) => { setLimit(n); setPage(1); }}
          />
        </div>
      )}
      {receiptFor && (
        <ReceiptModal saleId={receiptFor} onClose={() => setReceiptFor(null)} />
      )}
    </div>
  );
}
