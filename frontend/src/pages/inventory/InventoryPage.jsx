import { useState, useEffect, Fragment, useMemo } from 'react';
import { inventoryAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

// --- Tree View Components ---

const InventoryTreeSizeRow = ({ sizeRow }) => {
  const { t } = useTranslation();
  return (
  <tr className="tree-row size-row" style={{ backgroundColor: 'transparent' }}>
    <td style={{ paddingLeft: '5.5rem', color: 'var(--color-text-secondary)' }}>EU {sizeRow.size_eu}</td>
    <td style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{sizeRow.sku}</td>
    <td>{sizeRow.store_name}</td>
    <td>{parseFloat(sizeRow.avg_cost).toFixed(2)} {t('common.currency')}</td>
    <td><strong>{sizeRow.quantity}</strong></td>
    <td></td>
  </tr>
  );
};

const InventoryTreeColorRow = ({ color, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  
  return (
    <Fragment>
      <tr className="tree-row color-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'var(--color-row-alt)' }}>
        <td style={{ paddingLeft: '3rem' }}>
          <button className="btn-icon" style={{ padding: '0 8px', marginRight: 12, background: 'none', border:'none', color: 'inherit', cursor: 'pointer' }}>
            {expanded ? '▼' : '▶'}
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {color.hex && <span className="color-swatch-sm" style={{ backgroundColor: color.hex, width: 14, height: 14, borderRadius: '50%', display: 'inline-block', border: '1px solid var(--color-subtle-border)' }} />}
            <strong>{color.name}</strong>
          </span>
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td style={{ color: 'var(--color-primary-light)' }}><strong>{color.total_quantity}</strong></td>
        <td></td>
      </tr>
      {expanded && color.sizes.map((sizeRow, idx) => (
        <InventoryTreeSizeRow key={idx} sizeRow={sizeRow} />
      ))}
    </Fragment>
  );
};

const InventoryTreeProductRow = ({ product, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  
  return (
    <Fragment>
      <tr className="tree-row product-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'var(--color-row-alt-strong)' }}>
        <td style={{ fontSize: '1.05em' }}>
          <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', marginRight: 12, background: 'var(--color-row-alt-strong)', border: 'none' }}>
            {expanded ? '▼' : '▶'}
          </button>
          <strong>{product.code}</strong> — {product.name}
          {product.brand && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>{product.brand}</span>}
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td style={{ fontSize: '1.1em', color: 'var(--color-success)' }}><strong>{product.total_quantity}</strong></td>
        <td>
          {product.image ? (
            <img src={product.image} alt="product" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }} />
          ) : (
            <div style={{ width: 44, height: 44, background: 'var(--color-surface-hover)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>—</div>
          )}
        </td>
      </tr>
      {expanded && Array.from(product.colors.values()).map(color => (
        <InventoryTreeColorRow key={color.name} color={color} />
      ))}
    </Fragment>
  );
};

// --- Main Page Component ---

export default function InventoryPage() {
  const [items, setItems] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ store_id: '', status: 'in_stock', search: '', size_min: '', size_max: '' });
  const [viewMode, setViewMode] = useState('summary'); // 'summary' or 'items'
  const { hasPermission, filterStores } = useAuth();
  const { t } = useTranslation();
  const [treeData, setTreeData] = useState([]);

  useEffect(() => { fetchStores(); }, []);
  useEffect(() => { fetchData(); }, [viewMode, filters.store_id, filters.status]);

  const fetchStores = async () => {
    try {
      const { data } = await storesAPI.list();
      setStores(filterStores(data.data));
    } catch { /* ignore */ }
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filters.store_id) params.store_id = filters.store_id;
      if (filters.status) params.status = filters.status;
      if (filters.search) params.search = filters.search;
      if (filters.size_min) params.size_min = filters.size_min;
      if (filters.size_max) params.size_max = filters.size_max;

      if (viewMode === 'summary') {
        const { data } = await inventoryAPI.summary(params);
        setItems(data.data);
        buildTree(data.data);
      } else {
        const { data } = await inventoryAPI.list(params);
        setItems(data.data);
        setTreeData([]);
      }
    } catch { toast.error(t('inventory.no_inventory')); }
    finally { setLoading(false); }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    fetchData();
  };

  const buildTree = (rawData) => {
    const tree = [];
    const prodMap = new Map();

    for (const row of rawData) {
      if (!prodMap.has(row.product_id)) {
        prodMap.set(row.product_id, {
          id: row.product_id,
          code: row.product_code,
          name: row.product_name,
          brand: row.brand,
          image: row.product_image,
          total_quantity: 0,
          colors: new Map()
        });
        tree.push(prodMap.get(row.product_id));
      }
      const prodNode = prodMap.get(row.product_id);
      prodNode.total_quantity += Number(row.quantity);

      const colorKey = `${row.color_name}-${row.hex_code}`;
      if (!prodNode.colors.has(colorKey)) {
        prodNode.colors.set(colorKey, {
          name: row.color_name,
          hex: row.hex_code,
          total_quantity: 0,
          sizes: []
        });
      }
      const colorNode = prodNode.colors.get(colorKey);
      colorNode.total_quantity += Number(row.quantity);
      colorNode.sizes.push(row);
    }
    setTreeData(tree);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('inventory.title')}</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
          <button className={`btn ${viewMode === 'summary' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('summary')}>{t('inventory.summary')}</button>
          <button className={`btn ${viewMode === 'items' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('items')}>{t('inventory.total_items')}</button>
        </div>
      </div>

      {/* Advanced Filters */}
      <div className="card filters-panel">
        <form onSubmit={handleSearch} className="filters-grid" style={{ alignItems: 'flex-end' }}>
          
          <div className="form-group">
            <label className="form-label">{t('common.search')}</label>
            <input className="form-input" placeholder={t('inventory.search_placeholder')} value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.store')}</label>
            <SearchableSelect
              options={[
                { value: '', label: t('stores.all_stores') },
                ...stores.map((s) => ({ value: s.id, label: s.name }))
              ]}
              value={filters.store_id}
              onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('products.size')} Min</label>
              <input type="number" step="0.5" className="form-input" placeholder="38" value={filters.size_min}
                onChange={(e) => setFilters({ ...filters, size_min: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t('products.size')} Max</label>
              <input type="number" step="0.5" className="form-input" placeholder="46" value={filters.size_max}
                onChange={(e) => setFilters({ ...filters, size_max: e.target.value })} />
            </div>
          </div>

          {viewMode === 'items' && (
            <div className="form-group">
              <label className="form-label">{t('inventory.status')}</label>
              <SearchableSelect
                options={[
                  { value: '', label: t('common.all') },
                  { value: 'in_stock', label: t('inventory.in_stock') },
                  { value: 'sold', label: t('inventory.sold') },
                  { value: 'damaged', label: t('inventory.damaged') },
                  { value: 'in_transfer', label: t('inventory.in_transfer') }
                ]}
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              />
            </div>
          )}
          
          <div className="form-group">
            <button type="submit" className="btn btn-primary" style={{ paddingLeft: 'var(--spacing-xl)', paddingRight: 'var(--spacing-xl)' }}>{t('common.search')}</button>
          </div>
        </form>
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {viewMode === 'summary' ? (
                  <>
                    <th style={{ width: '35%' }}>{t('inventory.product')} ➔ {t('inventory.color')} ➔ {t('inventory.size')}</th>
                    <th>{t('inventory.sku')}</th>
                    <th>{t('inventory.store')}</th>
                    <th>{t('inventory.avg_cost')}</th>
                    <th>{t('inventory.quantity')}</th>
                    <th></th>
                  </>
                ) : (
                  <>
                    <th>{t('inventory.sku')}</th><th>{t('inventory.product')}</th><th>{t('inventory.color')}</th><th>{t('inventory.size')}</th><th>{t('inventory.store')}</th><th>{t('inventory.avg_cost')}</th><th>{t('common.type')}</th><th>{t('inventory.status')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={viewMode === 'summary' ? 6 : 8} style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-sm)' }}>📦</div>
                  {t('inventory.no_inventory')}
                </td></tr>
              ) : viewMode === 'summary' ? (
                treeData.map((product) => (
                  <InventoryTreeProductRow key={product.id} product={product} />
                ))
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="product-row">
                    <td><strong>{item.sku}</strong></td>
                    <td>{item.product_code} — {item.product_name}</td>
                    <td>{item.color_name}</td>
                    <td>EU {item.size_eu}</td>
                    <td>{item.store_name}</td>
                    <td>{parseFloat(item.cost).toFixed(2)} {t('common.currency')}</td>
                    <td><span className={`badge ${item.source === 'purchase' ? 'badge-info' : 'badge-neutral'}`}>{item.source}</span></td>
                    <td><span className={`badge ${item.status === 'in_stock' ? 'badge-success' : item.status === 'sold' ? 'badge-neutral' : 'badge-danger'}`}>{item.status}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
