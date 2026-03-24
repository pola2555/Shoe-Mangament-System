import { useState, useEffect, useMemo } from 'react';
import { transfersAPI, storesAPI, inventoryAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/common/SearchableSelect';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

export default function TransfersPage() {
  const [transfers, setTransfers] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const { hasPermission, filterStores } = useAuth();
  const canWrite = hasPermission('transfers', 'write');
  const { t } = useTranslation();

  // List filters
  const [filters, setFilters] = useState({ status: '', from_store: '', to_store: '' });

  // Create Transfer states
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({ from_store_id: '', to_store_id: '', notes: '' });
  const [availableItems, setAvailableItems] = useState([]);
  const [selectedItemIds, setSelectedItemIds] = useState(new Set());
  const [itemSearch, setItemSearch] = useState('');
  const [loadingItems, setLoadingItems] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [t, s] = await Promise.all([transfersAPI.list(), storesAPI.list()]);
      setTransfers(t.data.data);
      setStores(filterStores(s.data.data));
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  // Filtered transfers list
  const filteredTransfers = useMemo(() => {
    let result = [...transfers];
    if (filters.status) result = result.filter(t => t.status === filters.status);
    if (filters.from_store) result = result.filter(t => t.from_store_id === filters.from_store);
    if (filters.to_store) result = result.filter(t => t.to_store_id === filters.to_store);
    return result;
  }, [transfers, filters]);

  const openDetail = async (id) => {
    try {
      const { data } = await transfersAPI.getById(id);
      setDetail(data.data);
    } catch { toast.error('Failed to load transfer'); }
  };

  const handleAction = async (id, action) => {
    const confirmMsg = {
      ship: 'Mark as shipped?', receive: 'Confirm items received?', cancel: 'Cancel this transfer? Items will revert to in-stock.',
    };
    if (!confirm(confirmMsg[action])) return;
    try {
      if (action === 'ship') await transfersAPI.ship(id);
      else if (action === 'receive') await transfersAPI.receive(id);
      else if (action === 'cancel') await transfersAPI.cancel(id);
      toast.success(`Transfer ${action}${action === 'receive' ? 'd' : action === 'cancel' ? 'led' : 'ped'}`);
      fetchData();
      openDetail(id);
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  // --- Create Transfer Logic ---
  const fetchStoreItems = async (storeId) => {
    if (!storeId) { setAvailableItems([]); return; }
    try {
      setLoadingItems(true);
      const { data } = await inventoryAPI.list({ store_id: storeId, status: 'in_stock' });
      setAvailableItems(data.data || []);
    } catch { toast.error('Failed to load inventory'); }
    finally { setLoadingItems(false); }
  };

  const handleFromStoreChange = (storeId) => {
    setCreateForm(f => ({ ...f, from_store_id: storeId }));
    setSelectedItemIds(new Set());
    setItemSearch('');
    fetchStoreItems(storeId);
  };

  const filteredItems = useMemo(() => {
    if (!itemSearch) return availableItems;
    const q = itemSearch.toLowerCase();
    return availableItems.filter(i =>
      (i.sku && i.sku.toLowerCase().includes(q)) ||
      (i.product_code && i.product_code.toLowerCase().includes(q)) ||
      (i.brand && i.brand.toLowerCase().includes(q)) ||
      (i.model_name && i.model_name.toLowerCase().includes(q)) ||
      (i.color_name && i.color_name.toLowerCase().includes(q))
    );
  }, [availableItems, itemSearch]);

  const toggleItem = (itemId) => {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedItemIds(new Set(filteredItems.map(i => i.id)));
  };

  const deselectAll = () => {
    setSelectedItemIds(new Set());
  };

  const handleCreateTransfer = async () => {
    if (!createForm.from_store_id || !createForm.to_store_id) return toast.error('Select both stores');
    if (createForm.from_store_id === createForm.to_store_id) return toast.error('Source and destination must be different');
    if (selectedItemIds.size === 0) return toast.error('Select at least one item');
    try {
      await transfersAPI.create({
        from_store_id: createForm.from_store_id,
        to_store_id: createForm.to_store_id,
        notes: createForm.notes || null,
        item_ids: [...selectedItemIds],
      });
      toast.success('Transfer created');
      setShowCreateForm(false);
      setCreateForm({ from_store_id: '', to_store_id: '', notes: '' });
      setAvailableItems([]);
      setSelectedItemIds(new Set());
      setItemSearch('');
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to create transfer');
    }
  };

  const resetCreateForm = () => {
    setShowCreateForm(false);
    setCreateForm({ from_store_id: '', to_store_id: '', notes: '' });
    setAvailableItems([]);
    setSelectedItemIds(new Set());
    setItemSearch('');
  };

  const statusColors = { pending: 'badge-warning', shipped: 'badge-info', received: 'badge-success', cancelled: 'badge-danger' };
  const activeFilterCount = [filters.status, filters.from_store, filters.to_store].filter(Boolean).length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('transfers.title')}</h1>
        {canWrite && !showCreateForm && (
          <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>+ {t('transfers.create_transfer')}</button>
        )}
      </div>

      {/* Create Transfer Modal */}
      {showCreateForm && (
        <div className="modal-overlay" onClick={resetCreateForm}>
          <div className="modal-content card" style={{ maxWidth: 900, maxHeight: '90vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <h2 style={{ margin: 0 }}>{t('transfers.create_transfer')}</h2>
              <button className="btn btn-sm btn-secondary" onClick={resetCreateForm}>✕</button>
            </div>

            {/* Store Selection */}
            <div className="form-row" style={{ marginBottom: 'var(--spacing-lg)' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t('transfers.from_store')} *</label>
                <SearchableSelect
                  options={[
                    { value: '', label: t('common.select') },
                    ...stores.map(s => ({ value: s.id, label: s.name }))
                  ]}
                  value={createForm.from_store_id}
                  onChange={(e) => handleFromStoreChange(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">{t('transfers.to_store')} *</label>
                <SearchableSelect
                  options={[
                    { value: '', label: t('common.select') },
                    ...stores.filter(s => s.id !== createForm.from_store_id).map(s => ({ value: s.id, label: s.name }))
                  ]}
                  value={createForm.to_store_id}
                  onChange={(e) => setCreateForm(f => ({ ...f, to_store_id: e.target.value }))}
                />
              </div>
            </div>

            {/* Item Selection */}
            {createForm.from_store_id && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
                  <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
                    <input
                      className="form-input"
                      placeholder={t('transfers.search_items')}
                      value={itemSearch}
                      onChange={(e) => setItemSearch(e.target.value)}
                      style={{ width: 280, flex: '1 1 200px', minWidth: 0 }}
                    />
                    <button className="btn btn-sm btn-secondary" onClick={selectAll}>{t('common.all')}</button>
                    <button className="btn btn-sm btn-secondary" onClick={deselectAll}>{t('common.clear')}</button>
                  </div>
                  <span style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                    {selectedItemIds.size} {t('common.items')}
                  </span>
                </div>

                {loadingItems ? (
                  <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>{t('common.loading')}</div>
                ) : filteredItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>
                    {availableItems.length === 0 ? t('inventory.no_inventory') : t('common.no_results')}
                  </div>
                ) : (
                  <div className="table-container" style={{ maxHeight: 380, overflow: 'auto', marginBottom: 'var(--spacing-lg)' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 40 }}>
                            <input type="checkbox"
                              checked={filteredItems.length > 0 && filteredItems.every(i => selectedItemIds.has(i.id))}
                              onChange={(e) => e.target.checked ? selectAll() : deselectAll()}
                            />
                          </th>
                          <th>{t('inventory.sku')}</th>
                          <th>{t('sidebar.products')}</th>
                          <th>{t('products.color_name')}</th>
                          <th>{t('products.size')}</th>
                          <th>{t('sales.cost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredItems.map(item => (
                          <tr key={item.id}
                            className="product-row"
                            onClick={() => toggleItem(item.id)}
                            style={selectedItemIds.has(item.id) ? { background: 'rgba(99, 102, 241, 0.1)' } : undefined}
                          >
                            <td>
                              <input type="checkbox" checked={selectedItemIds.has(item.id)} onChange={() => toggleItem(item.id)} />
                            </td>
                            <td><strong>{item.sku}</strong></td>
                            <td>{item.product_code} — {item.model_name}</td>
                            <td>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                                {item.color_name}
                              </span>
                            </td>
                            <td>EU {item.size_eu}</td>
                            <td>{item.cost} {t('common.currency')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {/* Notes & Submit */}
            <div className="form-group" style={{ marginBottom: 'var(--spacing-md)' }}>
              <label className="form-label">{t('common.notes')} ({t('common.optional')})</label>
              <textarea className="form-input" rows={2} value={createForm.notes}
                onChange={(e) => setCreateForm(f => ({ ...f, notes: e.target.value }))} placeholder={t('common.optional')} />
            </div>

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={resetCreateForm}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleCreateTransfer}
                disabled={!createForm.from_store_id || !createForm.to_store_id || selectedItemIds.size === 0}>
                {t('transfers.create_transfer')} ({selectedItemIds.size} {t('common.items')})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <h2 style={{ margin: 0 }}>{detail.transfer_number}</h2>
              <span className={`badge ${statusColors[detail.status]}`}>{detail.status}</span>
            </div>
            <div style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
              <p>{t('transfers.from_store')}: <strong>{detail.from_store_name}</strong> → {t('transfers.to_store')}: <strong>{detail.to_store_name}</strong></p>
              <p>{t('transfers.items')}: <strong>{detail.items.length}</strong> &nbsp;•&nbsp; Created by: {detail.created_by_name}</p>
              {detail.shipped_at && <p>{t('transfers.shipped')}: {new Date(detail.shipped_at).toLocaleString()}</p>}
              {detail.received_at && <p>{t('transfers.received')}: {new Date(detail.received_at).toLocaleString()}</p>}
              {detail.notes && <p>{t('common.notes')}: {detail.notes}</p>}
            </div>

            <div className="table-container" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="table">
                <thead><tr><th>{t('inventory.sku')}</th><th>{t('sidebar.products')}</th><th>{t('products.color_name')}</th><th>{t('products.size')}</th></tr></thead>
                <tbody>
                  {detail.items.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.sku}</strong></td>
                      <td>{item.product_code} — {item.product_name}</td>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {item.hex_code && <span className="color-swatch-sm" style={{ backgroundColor: item.hex_code }} />}
                          {item.color_name}
                        </span>
                      </td>
                      <td>EU {item.size_eu}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canWrite && (
              <div style={{ marginTop: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'flex-end' }}>
                {detail.status === 'pending' && (
                  <>
                    <button className="btn btn-primary" onClick={() => handleAction(detail.id, 'ship')}>📦 {t('transfers.ship')}</button>
                    <button className="btn btn-danger" onClick={() => handleAction(detail.id, 'cancel')}>{t('transfers.cancel_transfer')}</button>
                  </>
                )}
                {detail.status === 'shipped' && (
                  <button className="btn btn-primary" onClick={() => handleAction(detail.id, 'receive')}>✓ {t('transfers.receive')}</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* List Filters */}
      <div className="filters-panel" style={{ display: 'flex', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)', flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-input" style={{ width: 160, flex: '1 1 140px', maxWidth: 200 }} value={filters.status}
          onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}>
          <option value="">{t('common.all')}</option>
          <option value="pending">{t('transfers.pending')}</option>
          <option value="shipped">{t('transfers.shipped')}</option>
          <option value="received">{t('transfers.received')}</option>
          <option value="cancelled">{t('transfers.cancelled')}</option>
        </select>
        <select className="form-input" style={{ width: 180, flex: '1 1 140px', maxWidth: 220 }} value={filters.from_store}
          onChange={(e) => setFilters(f => ({ ...f, from_store: e.target.value }))}>
          <option value="">{t('stores.all_stores')}</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="form-input" style={{ width: 180, flex: '1 1 140px', maxWidth: 220 }} value={filters.to_store}
          onChange={(e) => setFilters(f => ({ ...f, to_store: e.target.value }))}>
          <option value="">{t('stores.all_stores')}</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {activeFilterCount > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={() => setFilters({ status: '', from_store: '', to_store: '' })}>
            {t('common.clear')} ({activeFilterCount})
          </button>
        )}
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginLeft: 'auto' }}>
          {filteredTransfers.length} of {transfers.length} {t('transfers.title').toLowerCase()}
        </span>
      </div>

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>{t('transfers.transfer_code')}</th><th>{t('transfers.from_store')}</th><th>{t('transfers.to_store')}</th><th>{t('transfers.items')}</th><th>{t('common.status')}</th><th>{t('common.date')}</th></tr>
            </thead>
            <tbody>
              {filteredTransfers.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('transfers.no_transfers')}</td></tr>
              ) : filteredTransfers.map((t) => (
                <tr key={t.id} className="product-row" onClick={() => openDetail(t.id)}>
                  <td><strong>{t.transfer_number}</strong></td>
                  <td>{t.from_store_name}</td>
                  <td>{t.to_store_name}</td>
                  <td>{t.item_count}</td>
                  <td><span className={`badge ${statusColors[t.status]}`}>{t.status}</span></td>
                  <td>{new Date(t.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
