import { useState, useEffect, Fragment, useMemo } from 'react';
import { inventoryAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import '../products/Products.css';

// --- Tree View Components ---

const InventoryTreeSizeRow = ({ sizeRow }) => (
  <tr className="tree-row size-row" style={{ backgroundColor: 'transparent' }}>
    <td style={{ paddingLeft: '5.5rem', color: 'var(--color-text-secondary)' }}>EU {sizeRow.size_eu}</td>
    <td style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{sizeRow.sku}</td>
    <td>{sizeRow.store_name}</td>
    <td>{parseFloat(sizeRow.avg_cost).toFixed(2)} EGP</td>
    <td><strong>{sizeRow.quantity}</strong></td>
    <td></td>
  </tr>
);

const InventoryTreeColorRow = ({ color, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  
  return (
    <Fragment>
      <tr className="tree-row color-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'rgba(255,255,255,0.015)' }}>
        <td style={{ paddingLeft: '3rem' }}>
          <button className="btn-icon" style={{ padding: '0 8px', marginRight: 12, background: 'none', border:'none', color: 'inherit', cursor: 'pointer' }}>
            {expanded ? '▼' : '▶'}
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {color.hex && <span className="color-swatch-sm" style={{ backgroundColor: color.hex, width: 14, height: 14, borderRadius: '50%', display: 'inline-block', border: '1px solid rgba(255,255,255,0.2)' }} />}
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
      <tr className="tree-row product-row" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', backgroundColor: 'rgba(255,255,255,0.03)' }}>
        <td style={{ fontSize: '1.05em' }}>
          <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', marginRight: 12, background: 'rgba(255,255,255,0.1)', border: 'none' }}>
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
  const { hasPermission } = useAuth();
  const [treeData, setTreeData] = useState([]);

  useEffect(() => { fetchStores(); }, []);
  useEffect(() => { fetchData(); }, [viewMode, filters.store_id, filters.status]);

  const fetchStores = async () => {
    try {
      const { data } = await storesAPI.list();
      setStores(data.data);
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
    } catch { toast.error('Failed to load inventory'); }
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
        <h1 className="page-title">Inventory</h1>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
          <button className={`btn ${viewMode === 'summary' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('summary')}>Smart Tree View</button>
          <button className={`btn ${viewMode === 'items' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('items')}>Raw Items</button>
        </div>
      </div>

      {/* Advanced Filters */}
      <div className="card" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          
          <div className="form-group" style={{ flex: '1 1 200px' }}>
            <label className="form-label">Advanced Search</label>
            <input className="form-input" placeholder="Search product, SKU, matching brand, size..." value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>

          <div className="form-group" style={{ minWidth: 160 }}>
            <label className="form-label">Store Mapping</label>
            <SearchableSelect
              options={[
                { value: '', label: 'All Stores' },
                ...stores.map((s) => ({ value: s.id, label: s.name }))
              ]}
              value={filters.store_id}
              onChange={(e) => setFilters({ ...filters, store_id: e.target.value })}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', minWidth: 160 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Size Min</label>
              <input type="number" step="0.5" className="form-input" placeholder="e.eu 38" value={filters.size_min}
                onChange={(e) => setFilters({ ...filters, size_min: e.target.value })} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Size Max</label>
              <input type="number" step="0.5" className="form-input" placeholder="e.g 46" value={filters.size_max}
                onChange={(e) => setFilters({ ...filters, size_max: e.target.value })} />
            </div>
          </div>

          {viewMode === 'items' && (
            <div className="form-group" style={{ minWidth: 140 }}>
              <label className="form-label">Status</label>
              <SearchableSelect
                options={[
                  { value: '', label: 'All' },
                  { value: 'in_stock', label: 'In Stock' },
                  { value: 'sold', label: 'Sold' },
                  { value: 'damaged', label: 'Damaged' },
                  { value: 'in_transfer', label: 'In Transfer' }
                ]}
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              />
            </div>
          )}
          
          <div className="form-group">
            <button type="submit" className="btn btn-primary" style={{ paddingLeft: 'var(--spacing-xl)', paddingRight: 'var(--spacing-xl)' }}>Search</button>
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
                    <th style={{ width: '35%' }}>Hierarchy (Product ➔ Color ➔ Size)</th>
                    <th>SKU</th>
                    <th>Store</th>
                    <th>Avg Cost</th>
                    <th>Qty</th>
                    <th>Image</th>
                  </>
                ) : (
                  <>
                    <th>SKU</th><th>Product</th><th>Color</th><th>Size</th><th>Store</th><th>Cost</th><th>Source</th><th>Status</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={viewMode === 'summary' ? 6 : 8} style={{ textAlign: 'center', padding: 'var(--spacing-2xl)', color: 'var(--color-text-muted)' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-sm)' }}>📦</div>
                  No inventory matches your search criteria.
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
                    <td>{parseFloat(item.cost).toFixed(2)} EGP</td>
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
