
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { productsAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import ClickableImage from '../../components/common/ClickableImage';
import { useTranslation } from '../../i18n/i18nContext';
import './Products.css';

export default function ProductsListPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [viewMode, setViewMode] = useState('table'); // 'table' | 'grid'
  const [formData, setFormData] = useState({
    product_code: '', brand: '', model_name: '',
    net_price: '', default_selling_price: '', min_selling_price: '', max_selling_price: '',
    description: '',
  });
  const [editingId, setEditingId] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    search: '', brand: '', priceMin: '', priceMax: '', status: '',
    sortBy: 'model_name', sortDir: 'asc',
  });
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => { fetchProducts(); }, []);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const { data } = await productsAPI.list();
      setProducts(data.data);
    } catch (err) { toast.error('Failed to load products'); }
    finally { setLoading(false); }
  };

  // Client-side filtering & sorting for responsiveness
  const filteredProducts = useMemo(() => {
    let result = [...products];

    // Text search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(p =>
        p.product_code.toLowerCase().includes(q) ||
        p.model_name.toLowerCase().includes(q) ||
        (p.brand && p.brand.toLowerCase().includes(q))
      );
    }

    // Brand filter
    if (filters.brand) {
      result = result.filter(p => p.brand === filters.brand);
    }

    // Price range
    if (filters.priceMin) {
      result = result.filter(p => p.default_selling_price != null && parseFloat(p.default_selling_price) >= parseFloat(filters.priceMin));
    }
    if (filters.priceMax) {
      result = result.filter(p => p.default_selling_price != null && parseFloat(p.default_selling_price) <= parseFloat(filters.priceMax));
    }

    // Status filter
    if (filters.status === 'active') result = result.filter(p => p.is_active);
    else if (filters.status === 'inactive') result = result.filter(p => !p.is_active);

    // Sorting
    result.sort((a, b) => {
      let va = a[filters.sortBy], vb = b[filters.sortBy];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return filters.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return filters.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [products, filters]);

  // Extract unique brands for filter dropdown
  const brands = useMemo(() =>
    [...new Set(products.map(p => p.brand).filter(Boolean))].sort(),
    [products]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...formData };
      ['net_price', 'default_selling_price', 'min_selling_price', 'max_selling_price'].forEach((f) => {
        payload[f] = payload[f] === '' ? null : parseFloat(payload[f]);
      });

      if (editingId) { await productsAPI.update(editingId, payload); toast.success('Product updated'); }
      else { await productsAPI.create(payload); toast.success('Product created'); }
      setShowForm(false); resetForm(); fetchProducts();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to save product'); }
  };

  const startEdit = (product) => {
    setFormData({
      product_code: product.product_code, brand: product.brand || '', model_name: product.model_name,
      net_price: product.net_price ?? '', default_selling_price: product.default_selling_price ?? '',
      min_selling_price: product.min_selling_price ?? '', max_selling_price: product.max_selling_price ?? '',
      description: product.description || '',
    });
    setEditingId(product.id); setShowForm(true);
  };

  const resetForm = () => {
    setFormData({ product_code: '', brand: '', model_name: '', net_price: '', default_selling_price: '', min_selling_price: '', max_selling_price: '', description: '' });
    setEditingId(null);
  };

  const clearFilters = () => setFilters({ search: '', brand: '', priceMin: '', priceMax: '', status: '', sortBy: 'model_name', sortDir: 'asc' });

  const fmt = (v) => v != null ? parseFloat(v).toLocaleString() : '—';
  const activeFilterCount = [filters.brand, filters.priceMin, filters.priceMax, filters.status].filter(Boolean).length;

  return (
    <div className="products-page">
      <div className="page-header">
        <h1 className="page-title">{t('products.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
          {/* Search */}
          <div className="search-box">
            <input className="form-input" placeholder={t('products.search_placeholder')} value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: 220 }} />
          </div>

          {/* Filter Toggle */}
          <button className={`btn ${showFilters || activeFilterCount ? 'btn-accent' : 'btn-secondary'}`}
            onClick={() => setShowFilters(!showFilters)}>
            🔍 Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>

          {/* View Toggle */}
          <div className="view-toggle">
            <button className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setViewMode('table')} title={t('products.table_view')}>☰</button>
            <button className={`btn btn-sm ${viewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setViewMode('grid')} title={t('products.grid_view')}>⊞</button>
          </div>

          {hasPermission('products', 'write') && (
            <button className="btn btn-primary" onClick={() => { resetForm(); setShowForm(true); }}>+ {t('products.add_product')}</button>
          )}
        </div>
      </div>

      {/* Advanced Filters Panel */}
      {showFilters && (
        <div className="filters-panel card">
          <div className="filters-grid">
            <div className="form-group">
              <label className="form-label">{t('products.brand')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('common.all') },
                  ...brands.map(b => ({ value: b, label: b }))
                ]}
                value={filters.brand}
                onChange={(e) => setFilters({ ...filters, brand: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Price Min</label>
              <input className="form-input" type="number" placeholder="0" value={filters.priceMin}
                onChange={(e) => setFilters({ ...filters, priceMin: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Price Max</label>
              <input className="form-input" type="number" placeholder="∞" value={filters.priceMax}
                onChange={(e) => setFilters({ ...filters, priceMax: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.status')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('common.all') },
                  { value: 'active', label: t('common.active') },
                  { value: 'inactive', label: t('common.inactive') }
                ]}
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Sort By</label>
              <SearchableSelect
                options={[
                  { value: 'model_name', label: t('common.name') },
                  { value: 'product_code', label: t('products.product_code') },
                  { value: 'brand', label: t('products.brand') },
                  { value: 'default_selling_price', label: t('products.selling_price') },
                  { value: 'net_price', label: t('products.cost_price') }
                ]}
                value={filters.sortBy}
                onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
                isClearable={false}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Direction</label>
              <SearchableSelect
                options={[
                  { value: 'asc', label: 'A → Z / Low → High' },
                  { value: 'desc', label: 'Z → A / High → Low' }
                ]}
                value={filters.sortDir}
                onChange={(e) => setFilters({ ...filters, sortDir: e.target.value })}
                isClearable={false}
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--spacing-sm)' }}>
            <span className="filter-count">{filteredProducts.length} / {products.length} {t('products.title')}</span>
            {activeFilterCount > 0 && <button className="btn btn-sm btn-secondary" onClick={clearFilters}>Clear All</button>}
          </div>
        </div>
      )}

      {/* Product Form Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('products.edit_product') : t('products.add_product')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('products.product_code')} *</label>
                  <input className="form-input" required value={formData.product_code}
                    onChange={(e) => setFormData({ ...formData, product_code: e.target.value })}
                    placeholder="e.g. NAM90" disabled={!!editingId} /></div>
                <div className="form-group"><label className="form-label">{t('products.brand')}</label>
                  <input className="form-input" value={formData.brand}
                    onChange={(e) => setFormData({ ...formData, brand: e.target.value })} placeholder="e.g. Nike" /></div>
              </div>
              <div className="form-group"><label className="form-label">{t('products.model_name')} *</label>
                <input className="form-input" required value={formData.model_name}
                  onChange={(e) => setFormData({ ...formData, model_name: e.target.value })} placeholder="e.g. Air Max 90" /></div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">{t('products.cost_price')}</label>
                  <input className="form-input" type="number" step="0.01" value={formData.net_price}
                    onChange={(e) => setFormData({ ...formData, net_price: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">{t('products.selling_price')}</label>
                  <input className="form-input" type="number" step="0.01" value={formData.default_selling_price}
                    onChange={(e) => setFormData({ ...formData, default_selling_price: e.target.value })} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Min Price</label>
                  <input className="form-input" type="number" step="0.01" value={formData.min_selling_price}
                    onChange={(e) => setFormData({ ...formData, min_selling_price: e.target.value })} /></div>
                <div className="form-group"><label className="form-label">Max Price</label>
                  <input className="form-input" type="number" step="0.01" value={formData.max_selling_price}
                    onChange={(e) => setFormData({ ...formData, max_selling_price: e.target.value })} /></div>
              </div>
              <div className="form-group"><label className="form-label">Description</label>
                <textarea className="form-input" rows={3} value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })} /></div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{editingId ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : filteredProducts.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            {t('products.no_products')}
          </p>
        </div>
      ) : viewMode === 'grid' ? (
        /* ===== GRID / CARD VIEW ===== */
        <div className="product-grid">
          {filteredProducts.map((p) => (
            <div key={p.id} className="product-card card" onClick={() => navigate(`/products/${p.id}`)}>
              {/* Product Image */}
              <div className="product-card__image">
                {p.primary_image_url ? (
                  <ClickableImage src={p.primary_image_url} alt={p.model_name} title={`${p.brand} ${p.model_name}`} />
                ) : (
                  <div className="product-card__no-image">📷</div>
                )}
              </div>

              <div className="product-card__body">
                <div className="product-card__header">
                  <span className="product-card__code">{p.product_code}</span>
                  <span className={`badge ${p.is_active ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: '0.7rem' }}>
                    {p.is_active ? t('common.active') : t('common.inactive')}
                  </span>
                </div>

                <h3 className="product-card__name">{p.model_name}</h3>
                {p.brand && <span className="product-card__brand">{p.brand}</span>}

                {/* Color Swatches */}
                {p.colors && p.colors.length > 0 && (
                  <div className="product-card__colors">
                    {p.colors.map((c) => (
                      <span key={c.id} className="product-card__swatch"
                        style={{ backgroundColor: c.hex_code || '#888' }}
                        title={c.color_name} />
                    ))}
                    <span className="product-card__color-count">{p.color_count} {t('products.colors')}</span>
                  </div>
                )}

                {/* Stats */}
                <div className="product-card__stats">
                  <span title={t('products.variants')}>📏 {p.variant_count} {t('products.variants')}</span>
                  <span title={t('products.total_stock')} style={{ color: p.in_stock_count > 0 ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                    📦 {p.in_stock_count} {t('products.total_stock')}
                  </span>
                </div>

                {/* Prices */}
                <div className="product-card__prices">
                  {p.default_selling_price != null && (
                    <span className="product-card__price">{fmt(p.default_selling_price)} {t('common.currency')}</span>
                  )}
                  {p.net_price != null && (
                    <span className="product-card__cost">{t('products.cost_price')}: {fmt(p.net_price)}</span>
                  )}
                </div>

                {p.net_price != null && p.default_selling_price != null && parseFloat(p.default_selling_price) > 0 && (
                  <div className="product-card__margin">
                    {t('products.margin')}: <strong style={{ color: 'var(--color-success)' }}>
                      {((parseFloat(p.default_selling_price) - parseFloat(p.net_price)) / parseFloat(p.default_selling_price) * 100).toFixed(0)}%
                    </strong>
                  </div>
                )}
              </div>

              {hasPermission('products', 'write') && (
                <button className="btn btn-sm btn-secondary product-card__edit"
                  onClick={(e) => { e.stopPropagation(); startEdit(p); }}>{t('common.edit')}</button>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* ===== TABLE VIEW ===== */
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => setFilters({ ...filters, sortBy: 'product_code', sortDir: filters.sortBy === 'product_code' && filters.sortDir === 'asc' ? 'desc' : 'asc' })}>
                  {t('products.product_code')} {filters.sortBy === 'product_code' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th className="sortable" onClick={() => setFilters({ ...filters, sortBy: 'brand', sortDir: filters.sortBy === 'brand' && filters.sortDir === 'asc' ? 'desc' : 'asc' })}>
                  {t('products.brand')} {filters.sortBy === 'brand' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th className="sortable" onClick={() => setFilters({ ...filters, sortBy: 'model_name', sortDir: filters.sortBy === 'model_name' && filters.sortDir === 'asc' ? 'desc' : 'asc' })}>
                  {t('products.model_name')} {filters.sortBy === 'model_name' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th className="sortable" onClick={() => setFilters({ ...filters, sortBy: 'net_price', sortDir: filters.sortBy === 'net_price' && filters.sortDir === 'asc' ? 'desc' : 'asc' })}>
                  {t('products.cost_price')} {filters.sortBy === 'net_price' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th className="sortable" onClick={() => setFilters({ ...filters, sortBy: 'default_selling_price', sortDir: filters.sortBy === 'default_selling_price' && filters.sortDir === 'asc' ? 'desc' : 'asc' })}>
                  {t('products.selling_price')} {filters.sortBy === 'default_selling_price' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th>Min / Max</th>
                <th>{t('common.status')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((p) => (
                <tr key={p.id} className="product-row" onClick={() => navigate(`/products/${p.id}`)}>
                  <td><strong>{p.product_code}</strong></td>
                  <td>{p.brand || '—'}</td>
                  <td>{p.model_name}</td>
                  <td>{p.net_price != null ? `${fmt(p.net_price)} ${t('common.currency')}` : '—'}</td>
                  <td>{p.default_selling_price != null ? `${fmt(p.default_selling_price)} ${t('common.currency')}` : '—'}</td>
                  <td>{p.min_selling_price != null ? fmt(p.min_selling_price) : '—'} / {p.max_selling_price != null ? fmt(p.max_selling_price) : '—'}</td>
                  <td><span className={`badge ${p.is_active ? 'badge-success' : 'badge-danger'}`}>{p.is_active ? t('common.active') : t('common.inactive')}</span></td>
                  <td>{hasPermission('products', 'write') && (
                    <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); startEdit(p); }}>{t('common.edit')}</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
