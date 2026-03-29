import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { auditLogAPI, usersAPI, storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

const ACTION_OPTIONS = [
  'create', 'update', 'delete', 'login', 'logout',
  'ship', 'receive', 'cancel', 'complete',
  'set_permissions', 'set_stores', 'change_password',
  'deactivate', 'toggle_active', 'manual_entry', 'mark_damaged',
  'bulk_create', 'set_items', 'upload',
];

const MODULE_OPTIONS = [
  'auth', 'users', 'stores', 'products', 'purchases',
  'inventory', 'transfers', 'customers', 'sales',
  'dealers', 'expenses', 'returns', 'notifications',
];

const FIELD_LABELS = {
  full_name: 'Full Name', username: 'Username', phone: 'Phone', email: 'Email',
  store_id: 'Store', store_name: 'Store', role: 'Role', status: 'Status',
  total_amount: 'Total Amount', final_amount: 'Final Amount', discount_amount: 'Discount',
  tax_amount: 'Tax', paid_amount: 'Paid Amount', payment_method: 'Payment Method',
  customer_name: 'Customer', customer_id: 'Customer', supplier_id: 'Supplier',
  supplier_name: 'Supplier', dealer_id: 'Dealer', dealer_name: 'Dealer',
  invoice_number: 'Invoice #', invoice_date: 'Invoice Date',
  product_name: 'Product', product_id: 'Product', color_name: 'Color',
  size: 'Size', quantity: 'Quantity', unit_price: 'Unit Price', cost_price: 'Cost Price',
  selling_price: 'Selling Price', price: 'Price',
  from_store: 'From Store', to_store: 'To Store', from_store_id: 'From Store',
  to_store_id: 'To Store', transfer_code: 'Transfer Code',
  category: 'Category', description: 'Description', amount: 'Amount',
  expense_date: 'Date', name: 'Name', address: 'Address', city: 'City',
  refund_amount: 'Refund Amount', return_reason: 'Return Reason', reason: 'Reason',
  notes: 'Notes', is_active: 'Active', box_label: 'Box Label',
  sku: 'SKU', barcode: 'Barcode', brand: 'Brand', model: 'Model',
  sale_code: 'Sale Code', purchase_code: 'Purchase Code',
  items_count: 'Items Count', total_items: 'Total Items',
  path: 'Page Path', page: 'Page',
};

function formatFieldValue(key, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'is_active') return value ? 'Active' : 'Inactive';
  if ((key.includes('amount') || key.includes('price') || key === 'amount') && typeof value === 'number')
    return `$${value.toFixed(2)}`;
  if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? 's' : ''}`;
  if (typeof value === 'object') return null; // skip nested objects in summary
  return String(value);
}

function formatLabel(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDetailsSummary(details) {
  if (!details || typeof details !== 'object') return '—';
  const entries = Object.entries(details)
    .filter(([k]) => !['items', 'payments', 'fields', 'password', 'password_hash'].includes(k))
    .map(([k, v]) => {
      const formatted = formatFieldValue(k, v);
      if (formatted === null) return null;
      return `${formatLabel(k)}: ${formatted}`;
    })
    .filter(Boolean);
  if (entries.length === 0) return '—';
  return entries.slice(0, 3).join(' · ') + (entries.length > 3 ? ' …' : '');
}

function DetailsTooltip({ details, action, module: mod, entityType }) {
  const [open, setOpen] = useState(false);
  if (!details || typeof details !== 'object') return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;

  const mainEntries = Object.entries(details)
    .filter(([k]) => !['items', 'payments', 'fields', 'password', 'password_hash'].includes(k));
  const itemsArr = details.items || details.payments;
  const fieldsArr = details.fields;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <span
        style={{ cursor: 'pointer', borderBottom: '1px dashed var(--color-text-muted)' }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {formatDetailsSummary(details)}
      </span>

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, zIndex: 100,
          background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)',
          padding: 'var(--spacing-md)', minWidth: 280, maxWidth: 400,
          marginBottom: 8
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)',
            marginBottom: 'var(--spacing-sm)', paddingBottom: 'var(--spacing-sm)',
            borderBottom: '1px solid var(--color-border)'
          }}>
            <span style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.5px', color: 'var(--color-text-secondary)'
            }}>
              {mod} — {action}{entityType ? ` (${entityType})` : ''}
            </span>
          </div>

          {/* Main fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mainEntries.map(([k, v]) => {
              const formatted = formatFieldValue(k, v);
              if (formatted === null) return null;
              return (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-sm)' }}>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                    {formatLabel(k)}
                  </span>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-primary)', fontWeight: 500, textAlign: 'right' }}>
                    {formatted}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Items sub-list */}
          {Array.isArray(itemsArr) && itemsArr.length > 0 && (
            <div style={{ marginTop: 'var(--spacing-sm)', paddingTop: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                {details.payments ? 'Payments' : 'Items'} ({itemsArr.length})
              </div>
              {itemsArr.slice(0, 5).map((item, i) => (
                <div key={i} style={{
                  fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
                  padding: '2px 0', display: 'flex', gap: 'var(--spacing-xs)', flexWrap: 'wrap'
                }}>
                  {Object.entries(item)
                    .filter(([ik]) => !['id', 'variant_id', 'product_id', 'sale_id', 'purchase_id'].includes(ik))
                    .slice(0, 4)
                    .map(([ik, iv]) => (
                      <span key={ik}>
                        <span style={{ color: 'var(--color-text-muted)' }}>{formatLabel(ik)}: </span>
                        {formatFieldValue(ik, iv) || String(iv)}
                      </span>
                    ))}
                </div>
              ))}
              {itemsArr.length > 5 && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                  +{itemsArr.length - 5} more…
                </div>
              )}
            </div>
          )}

          {/* Updated fields */}
          {Array.isArray(fieldsArr) && fieldsArr.length > 0 && (
            <div style={{ marginTop: 'var(--spacing-sm)', paddingTop: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                Changed Fields
              </div>
              {fieldsArr.map((f, i) => (
                <div key={i} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', padding: '1px 0' }}>
                  {formatLabel(typeof f === 'string' ? f : f.field || f)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ActivityLogPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const { filterStores, hasPermission } = useAuth();
  const { t } = useTranslation();

  // Filters
  const [filterUser, setFilterUser] = useState('');
  const [filterModule, setFilterModule] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterStore, setFilterStore] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  useEffect(() => {
    Promise.all([usersAPI.list(), storesAPI.list()])
      .then(([u, s]) => {
        setUsers(u.data.data);
        setStores(filterStores(s.data.data));
      })
      .catch(() => {});
  }, []);

  const fetchLogs = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const params = { page, limit: 50 };
      if (filterUser) params.user_id = filterUser;
      if (filterModule) params.module = filterModule;
      if (filterAction) params.action = filterAction;
      if (filterStore) params.store_id = filterStore;
      if (filterDateFrom) params.date_from = filterDateFrom;
      if (filterDateTo) params.date_to = filterDateTo;
      if (filterSearch) params.search = filterSearch;

      const res = await auditLogAPI.list(params);
      setLogs(res.data.data);
      setPagination(res.data.pagination || { page: 1, totalPages: 1, total: 0 });
    } catch { toast.error('Failed to load activity log'); }
    finally { setLoading(false); }
  }, [filterUser, filterModule, filterAction, filterStore, filterDateFrom, filterDateTo, filterSearch]);

  useEffect(() => { fetchLogs(1); }, [fetchLogs]);

  const clearFilters = () => {
    setFilterUser('');
    setFilterModule('');
    setFilterAction('');
    setFilterStore('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setFilterSearch('');
  };

  const activeFilters = [filterUser, filterModule, filterAction, filterStore, filterDateFrom, filterDateTo, filterSearch].filter(Boolean).length;

  const handleClearHistory = async () => {
    if (!window.confirm(t('activity_log.clear_confirm'))) return;
    try {
      const res = await auditLogAPI.clear();
      toast.success(res.data.message || 'History cleared');
      fetchLogs(1);
    } catch {
      toast.error('Failed to clear history');
    }
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getActionBadge = (action) => {
    if (action === 'create' || action === 'bulk_create') return 'badge-success';
    if (action === 'delete' || action === 'deactivate' || action === 'cancel') return 'badge-danger';
    if (action === 'login' || action === 'logout') return 'badge-info';
    return 'badge-warning';
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('activity_log.title')}</h1>
        {hasPermission('audit_log', 'write') && (
          <button className="btn btn-danger" onClick={handleClearHistory}>
            {t('activity_log.clear_history')}
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="card filters-panel">
        <div className="filters-grid" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.search')}</label>
            <input className="form-input" placeholder={t('activity_log.search_placeholder')}
              value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('activity_log.user')}</label>
            <select className="form-input" value={filterUser} onChange={(e) => setFilterUser(e.target.value)}>
              <option value="">{t('activity_log.all_users')}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('activity_log.module')}</label>
            <select className="form-input" value={filterModule} onChange={(e) => setFilterModule(e.target.value)}>
              <option value="">{t('activity_log.all_modules')}</option>
              {MODULE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('activity_log.action')}</label>
            <select className="form-input" value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
              <option value="">{t('activity_log.all_actions')}</option>
              {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('activity_log.store')}</label>
            <select className="form-input" value={filterStore} onChange={(e) => setFilterStore(e.target.value)}>
              <option value="">{t('activity_log.all_stores')}</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.from')}</label>
            <input className="form-input" type="date" value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.to')}</label>
            <input className="form-input" type="date" value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)} />
          </div>
          {activeFilters > 0 && (
            <button className="btn btn-sm btn-secondary"
              onClick={clearFilters}>
              {t('common.clear')} ({activeFilters})
            </button>
          )}
        </div>
      </div>

      {/* Results count */}
      <div style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
        {pagination.total} {pagination.total !== 1 ? t('activity_log.activities') : t('activity_log.activity')}
        {activeFilters > 0 ? ` (${t('activity_log.filtered')})` : ''}
      </div>

      {/* Table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('activity_log.time')}</th>
                  <th>{t('activity_log.user')}</th>
                  <th>{t('activity_log.action')}</th>
                  <th>{t('activity_log.module')}</th>
                  <th>{t('activity_log.entity')}</th>
                  <th>{t('activity_log.details')}</th>
                  <th>{t('activity_log.store')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      {formatDate(log.created_at)}
                    </td>
                    <td>
                      <strong>{log.user_name || '—'}</strong>
                    </td>
                    <td>
                      <span className={`badge ${getActionBadge(log.action)}`}>
                        {log.action}
                      </span>
                    </td>
                    <td style={{ fontSize: 'var(--font-size-sm)' }}>{log.module}</td>
                    <td style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      {log.entity_type && (
                        <span>{log.entity_type}{log.entity_id ? ` #${String(log.entity_id).slice(0, 8)}` : ''}</span>
                      )}
                    </td>
                    <td style={{ maxWidth: '280px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      <DetailsTooltip details={log.details} action={log.action} module={log.module} entityType={log.entity_type} />
                    </td>
                    <td style={{ fontSize: 'var(--font-size-sm)' }}>{log.store_name || '—'}</td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>
                    {t('activity_log.no_activity')}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-lg)' }}>
              <button className="btn btn-sm btn-secondary" disabled={pagination.page <= 1}
                onClick={() => fetchLogs(pagination.page - 1)}>
                {t('common.previous')}
              </button>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {t('common.page')} {pagination.page} {t('common.of')} {pagination.totalPages}
              </span>
              <button className="btn btn-sm btn-secondary" disabled={pagination.page >= pagination.totalPages}
                onClick={() => fetchLogs(pagination.page + 1)}>
                {t('common.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
