import { useState, useEffect } from 'react';
import { transfersAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import '../products/Products.css';

export default function TransfersPage() {
  const [transfers, setTransfers] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('transfers', 'write');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [t, s] = await Promise.all([transfersAPI.list(), storesAPI.list()]);
      setTransfers(t.data.data);
      setStores(s.data.data);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

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

  const statusColors = { pending: 'badge-warning', shipped: 'badge-info', received: 'badge-success', cancelled: 'badge-danger' };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Stock Transfers</h1>
      </div>

      {/* Detail Modal */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-content card" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <h2 style={{ margin: 0 }}>{detail.transfer_number}</h2>
              <span className={`badge ${statusColors[detail.status]}`}>{detail.status}</span>
            </div>
            <div style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
              <p>From: <strong>{detail.from_store_name}</strong> → To: <strong>{detail.to_store_name}</strong></p>
              <p>Items: <strong>{detail.items.length}</strong> &nbsp;•&nbsp; Created by: {detail.created_by_name}</p>
              {detail.shipped_at && <p>Shipped: {new Date(detail.shipped_at).toLocaleString()}</p>}
              {detail.received_at && <p>Received: {new Date(detail.received_at).toLocaleString()}</p>}
            </div>

            <div className="table-container" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="table">
                <thead><tr><th>SKU</th><th>Product</th><th>Color</th><th>Size</th></tr></thead>
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
                    <button className="btn btn-primary" onClick={() => handleAction(detail.id, 'ship')}>📦 Ship</button>
                    <button className="btn btn-danger" onClick={() => handleAction(detail.id, 'cancel')}>Cancel</button>
                  </>
                )}
                {detail.status === 'shipped' && (
                  <button className="btn btn-primary" onClick={() => handleAction(detail.id, 'receive')}>✓ Receive</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Transfer #</th><th>From</th><th>To</th><th>Items</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {transfers.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>No transfers yet.</td></tr>
              ) : transfers.map((t) => (
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
