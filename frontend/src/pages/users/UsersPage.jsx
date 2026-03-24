import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { usersAPI, storesAPI } from '../../api';
import SearchableSelect from '../../components/common/SearchableSelect';
import { HiOutlinePencil, HiOutlineShieldCheck, HiOutlineKey, HiOutlineNoSymbol, HiOutlineCheckCircle, HiOutlineBuildingStorefront } from 'react-icons/hi2';
import { useTranslation } from '../../i18n/i18nContext';
import '../products/Products.css';

const ALL_PERMISSION_CODES = [
  { code: 'users', category: 'administration' },
  { code: 'user_permissions', category: 'administration' },
  { code: 'stores', category: 'administration' },
  { code: 'all_stores', category: 'administration' },
  { code: 'audit_log', category: 'administration' },
  { code: 'products', category: 'catalog' },
  { code: 'product_variants', category: 'catalog' },
  { code: 'product_images', category: 'catalog' },
  { code: 'product_prices', category: 'catalog' },
  { code: 'box_templates', category: 'catalog' },
  { code: 'inventory', category: 'operations' },
  { code: 'transfers', category: 'operations' },
  { code: 'transfer_actions', category: 'operations' },
  { code: 'purchases', category: 'procurement' },
  { code: 'purchase_boxes', category: 'procurement' },
  { code: 'purchase_images', category: 'procurement' },
  { code: 'suppliers', category: 'procurement' },
  { code: 'supplier_payments', category: 'procurement' },
  { code: 'pos', category: 'sales' },
  { code: 'sales', category: 'sales' },
  { code: 'sale_payments', category: 'sales' },
  { code: 'customers', category: 'sales' },
  { code: 'customer_returns', category: 'returns' },
  { code: 'supplier_returns', category: 'returns' },
  { code: 'dealers', category: 'wholesale' },
  { code: 'dealer_invoices', category: 'wholesale' },
  { code: 'dealer_payments', category: 'wholesale' },
  { code: 'expenses', category: 'finance' },
  { code: 'reports', category: 'finance' },
  { code: 'notifications', category: 'notifications' },
];

const ROLE_OPTIONS = [
  { value: 1, labelKey: 'users.admin' },
  { value: 2, labelKey: 'users.store_manager' },
  { value: 3, labelKey: 'users.employee' },
];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user: currentUser, hasPermission } = useAuth();
  const { t } = useTranslation();
  const canWrite = hasPermission('users', 'write');

  // Create/Edit user modal
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ username: '', email: '', password: '', full_name: '', role_id: '', store_id: '' });

  // Permissions modal
  const [showPermissions, setShowPermissions] = useState(false);
  const [permUserId, setPermUserId] = useState(null);
  const [permUserName, setPermUserName] = useState('');
  const [permMap, setPermMap] = useState({}); // { code: 'read'|'write'|null }
  const [loadingPerms, setLoadingPerms] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStore, setFilterStore] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [u, s] = await Promise.all([
        usersAPI.list(),
        storesAPI.list(),
      ]);
      setUsers(u.data.data);
      setStores(s.data.data);
    } catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  };

  // Filtered users
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (search) {
        const q = search.toLowerCase();
        if (!u.username.toLowerCase().includes(q) && !(u.full_name || '').toLowerCase().includes(q) && !(u.email || '').toLowerCase().includes(q)) return false;
      }
      if (filterRole && u.role_id !== parseInt(filterRole)) return false;
      if (filterStore) {
        if (filterStore === 'hq') { if (u.store_id) return false; }
        else if (u.store_id !== filterStore) return false;
      }
      if (filterStatus === 'active' && !u.is_active) return false;
      if (filterStatus === 'inactive' && u.is_active) return false;
      return true;
    });
  }, [users, search, filterRole, filterStore, filterStatus]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        role_id: form.role_id ? parseInt(form.role_id) : undefined,
        store_id: form.store_id || null,
      };
      if (editingId) {
        if (!payload.password) delete payload.password;
        delete payload.username;
        await usersAPI.update(editingId, payload);
        toast.success(t('users.user_updated'));
      } else {
        await usersAPI.create(payload);
        toast.success(t('users.user_created'));
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ username: '', email: '', password: '', full_name: '', role_id: '', store_id: '' });
      fetchAll();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleToggleActive = async (u) => {
    const action = u.is_active ? t('users.deactivate').toLowerCase() : t('users.activate').toLowerCase();
    if (!window.confirm(u.is_active ? t('users.confirm_deactivate', { name: u.username }) : t('users.confirm_reactivate', { name: u.username }))) return;
    try {
      if (u.is_active) {
        await usersAPI.deactivate(u.id);
      } else {
        await usersAPI.update(u.id, { is_active: true });
      }
      toast.success(`${t('common.success')}`);
      fetchAll();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  // --- Permissions modal ---
  const openPermissions = async (u) => {
    setPermUserId(u.id);
    setPermUserName(u.full_name || u.username);
    setLoadingPerms(true);
    setShowPermissions(true);
    try {
      const res = await usersAPI.getById(u.id);
      const perms = res.data.data.permissions || [];
      const map = {};
      ALL_PERMISSION_CODES.forEach((p) => { map[p.code] = null; });
      perms.forEach((p) => { map[p.permission_code] = p.access_level; });
      setPermMap(map);
    } catch { toast.error(t('common.error')); setShowPermissions(false); }
    finally { setLoadingPerms(false); }
  };

  const cyclePermission = (code) => {
    setPermMap((prev) => {
      const current = prev[code];
      // null → read → write → null
      let next;
      if (!current) next = 'read';
      else if (current === 'read') next = 'write';
      else next = null;
      return { ...prev, [code]: next };
    });
  };

  const handleSavePermissions = async () => {
    const permissions = Object.entries(permMap)
      .filter(([, level]) => level)
      .map(([permission_code, access_level]) => ({ permission_code, access_level }));
    try {
      await usersAPI.setPermissions(permUserId, permissions);
      toast.success(t('users.permissions_updated'));
      setShowPermissions(false);
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const setAllPermissions = (level) => {
    const map = {};
    ALL_PERMISSION_CODES.forEach((p) => { map[p.code] = level; });
    setPermMap(map);
  };

  // --- Change password modal ---
  const [showResetPw, setShowResetPw] = useState(false);
  const [resetPwUserId, setResetPwUserId] = useState(null);
  const [resetPwUserName, setResetPwUserName] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Store assignment modal
  const [showStoreAssign, setShowStoreAssign] = useState(false);
  const [storeAssignUserId, setStoreAssignUserId] = useState(null);
  const [storeAssignUserName, setStoreAssignUserName] = useState('');
  const [assignedStoreIds, setAssignedStoreIds] = useState([]);
  const [loadingStores, setLoadingStores] = useState(false);

  const openStoreAssign = async (u) => {
    setStoreAssignUserId(u.id);
    setStoreAssignUserName(u.full_name || u.username);
    setLoadingStores(true);
    setShowStoreAssign(true);
    try {
      const res = await usersAPI.getStores(u.id);
      setAssignedStoreIds(res.data.data.map((s) => s.id));
    } catch { toast.error(t('common.error')); setShowStoreAssign(false); }
    finally { setLoadingStores(false); }
  };

  const toggleStoreAssignment = (storeId) => {
    setAssignedStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  };

  const handleSaveStoreAssign = async () => {
    try {
      await usersAPI.setStores(storeAssignUserId, assignedStoreIds);
      toast.success(t('users.store_assignments_updated'));
      setShowStoreAssign(false);
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    try {
      // Admin resetting another user's password — update user with password field
      await usersAPI.update(resetPwUserId, { password: newPassword });
      toast.success(t('users.password_reset_success'));
      setShowResetPw(false);
      setNewPassword('');
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
  };

  const activeFilters = [filterRole, filterStore, filterStatus].filter(Boolean).length + (search ? 1 : 0);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('users.title')}</h1>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => {
            setEditingId(null);
            setForm({ username: '', email: '', password: '', full_name: '', role_id: '', store_id: '' });
            setShowForm(true);
          }}>+ {t('users.add_user')}</button>
        )}
      </div>

      {/* Filters */}
      <div className="card filters-panel">
        <div className="filters-grid" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.search')}</label>
            <input className="form-input" placeholder={t('users.search_placeholder')} value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('users.role')}</label>
            <select className="form-input" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
              <option value="">{t('users.all_roles')}</option>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{t(r.labelKey)}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('users.store')}</label>
            <select className="form-input" value={filterStore} onChange={(e) => setFilterStore(e.target.value)}>
              <option value="">{t('stores.all_stores')}</option>
              <option value="hq">{t('users.hq_no_store')}</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.status')}</label>
            <select className="form-input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              <option value="active">{t('common.active')}</option>
              <option value="inactive">{t('common.inactive')}</option>
            </select>
          </div>
          {activeFilters > 0 && (
            <button className="btn btn-sm btn-secondary"
              onClick={() => { setSearch(''); setFilterRole(''); setFilterStore(''); setFilterStatus(''); }}>
              {t('common.clear')} ({activeFilters})
            </button>
          )}
        </div>
      </div>

      {/* Users table */}
      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <>
          <div style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            {filteredUsers.length} {t('users.title').toLowerCase()}
            {activeFilters > 0 ? ` (${t('common.filter').toLowerCase()} ${t('common.from').toLowerCase()} ${users.length})` : ''}
          </div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('users.username')}</th>
                  <th>{t('users.full_name')}</th>
                  <th>{t('common.email')}</th>
                  <th>{t('users.role')}</th>
                  <th>{t('users.store')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('users.last_login')}</th>
                  {canWrite && <th style={{ textAlign: 'right' }}>{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                    <td><strong>{u.username}</strong></td>
                    <td>{u.full_name || '—'}</td>
                    <td style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{u.email || '—'}</td>
                    <td>
                      <span className={`badge ${u.role_name === 'admin' ? 'badge-warning' : u.role_name === 'store_manager' ? 'badge-info' : 'badge-secondary'}`}>
                        {u.role_name}
                      </span>
                    </td>
                    <td>{u.store_name || t('users.hq')}</td>
                    <td>
                      <span className={`badge ${u.is_active ? 'badge-success' : 'badge-danger'}`}>
                        {u.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : t('common.never')}
                    </td>
                    {canWrite && (
                      <td>
                        <div style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button className="btn btn-sm btn-secondary" title={t('users.edit_user')}
                            onClick={() => {
                              setForm({ username: u.username, email: u.email || '', password: '', full_name: u.full_name || '', role_id: u.role_id || '', store_id: u.store_id || '' });
                              setEditingId(u.id);
                              setShowForm(true);
                            }}>
                            <HiOutlinePencil />
                          </button>
                          <button className="btn btn-sm btn-secondary" title={t('users.permissions')}
                            onClick={() => openPermissions(u)}>
                            <HiOutlineShieldCheck />
                          </button>
                          <button className="btn btn-sm btn-secondary" title={t('users.store_assignments')}
                            onClick={() => openStoreAssign(u)}>
                            <HiOutlineBuildingStorefront />
                          </button>
                          <button className="btn btn-sm btn-secondary" title={t('users.reset_password')}
                            onClick={() => {
                              setResetPwUserId(u.id);
                              setResetPwUserName(u.full_name || u.username);
                              setNewPassword('');
                              setShowResetPw(true);
                            }}>
                            <HiOutlineKey />
                          </button>
                          {u.id !== currentUser?.id && (
                            <button
                              className={`btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-success'}`}
                              title={u.is_active ? t('users.deactivate') : t('users.activate')}
                              onClick={() => handleToggleActive(u)}>
                              {u.is_active ? <HiOutlineNoSymbol /> : <HiOutlineCheckCircle />}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {filteredUsers.length === 0 && (
                  <tr><td colSpan={canWrite ? 8 : 7} style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)' }}>{t('users.no_users')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Create / Edit User Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{editingId ? t('users.edit_user') : t('users.new_user')}</h2>
            <form onSubmit={handleSubmit} className="product-form">
              {!editingId && (
                <div className="form-group">
                  <label className="form-label">{t('users.username')} *</label>
                  <input className="form-input" required value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })} />
                </div>
              )}
              {editingId && (
                <div className="form-group">
                  <label className="form-label">{t('users.username')}</label>
                  <input className="form-input" disabled value={form.username} style={{ opacity: 0.5 }} />
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('users.full_name')} *</label>
                  <input className="form-input" required value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.email')} *</label>
                  <input className="form-input" type="email" required value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{editingId ? t('users.password_leave_empty') : t('common.password') + ' *'}</label>
                <input className="form-input" type="password" required={!editingId} minLength={6}
                  value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('users.role')} *</label>
                  <SearchableSelect
                    options={[
                      { value: '', label: t('users.select_role') },
                      ...ROLE_OPTIONS.map((r) => ({ value: r.value, label: t(r.labelKey) }))
                    ]}
                    value={form.role_id}
                    onChange={(e) => setForm({ ...form, role_id: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('users.store')}</label>
                  <SearchableSelect
                    options={[
                      { value: '', label: t('users.hq_all_stores') },
                      ...stores.map((s) => ({ value: s.id, label: s.name }))
                    ]}
                    value={form.store_id}
                    onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{editingId ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Permissions Modal */}
      {showPermissions && (
        <div className="modal-overlay" onClick={() => setShowPermissions(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
            <h2 style={{ marginBottom: 'var(--spacing-xs)' }}>{t('users.permissions')}</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)', fontSize: 'var(--font-size-sm)' }}>
              {permUserName} — {t('users.cycle_help')} <span className="badge badge-secondary" style={{ fontSize: 'var(--font-size-xs)' }}>{t('common.none')}</span>
              {' → '}<span className="badge badge-info" style={{ fontSize: 'var(--font-size-xs)' }}>{t('users.read')}</span>
              {' → '}<span className="badge badge-success" style={{ fontSize: 'var(--font-size-xs)' }}>{t('users.write')}</span>
              {' → '}{t('common.none')}
            </p>
            {loadingPerms ? <div className="loading-screen" style={{ minHeight: '100px' }}><div className="spinner" /></div> : (
              <>
                <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAllPermissions(null)}>{t('users.clear_all')}</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAllPermissions('read')}>{t('users.all_read')}</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAllPermissions('write')}>{t('users.all_write')}</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                  {(() => {
                    const byCategory = {};
                    ALL_PERMISSION_CODES.forEach((p) => {
                      if (!byCategory[p.category]) byCategory[p.category] = [];
                      byCategory[p.category].push(p);
                    });
                    return Object.entries(byCategory).map(([cat, perms]) => (
                      <div key={cat}>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' }}>
                          {t(`users.permission_categories.${cat}`)}
                        </div>
                        {perms.map((p) => {
                          const level = permMap[p.code];
                          return (
                            <div key={p.code}
                              onClick={() => cyclePermission(p.code)}
                              style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: 'var(--spacing-sm) var(--spacing-md)',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer',
                                background: level ? 'var(--color-bg-hover)' : 'transparent',
                                transition: 'background 0.15s',
                              }}>
                              <span style={{ fontSize: 'var(--font-size-sm)' }}>{t(`users.permission_labels.${p.code}`)}</span>
                              <span className={`badge ${!level ? 'badge-secondary' : level === 'read' ? 'badge-info' : 'badge-success'}`}
                                style={{ minWidth: '50px', textAlign: 'center', fontSize: 'var(--font-size-xs)' }}>
                                {!level ? t('common.none') : level === 'read' ? t('users.read') : t('users.write')}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
                <div className="form-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowPermissions(false)}>{t('common.cancel')}</button>
                  <button type="button" className="btn btn-primary" onClick={handleSavePermissions}>{t('users.save_permissions')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetPw && (
        <div className="modal-overlay" onClick={() => setShowResetPw(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>{t('users.reset_password')}</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)', fontSize: 'var(--font-size-sm)' }}>
              {t('users.set_new_password_for')} <strong>{resetPwUserName}</strong>
            </p>
            <form onSubmit={handleResetPassword}>
              <div className="form-group">
                <label className="form-label">{t('users.new_password')} *</label>
                <input className="form-input" type="password" required minLength={6} value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowResetPw(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary">{t('users.reset_password')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Store Assignment Modal */}
      {showStoreAssign && (
        <div className="modal-overlay" onClick={() => setShowStoreAssign(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <h2 style={{ marginBottom: 'var(--spacing-xs)' }}>{t('users.store_assignments')}</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)', fontSize: 'var(--font-size-sm)' }}>
              {t('users.store_access_help', { name: storeAssignUserName })}
            </p>
            {loadingStores ? <div className="loading-screen" style={{ minHeight: '100px' }}><div className="spinner" /></div> : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                  {stores.map((s) => (
                    <div key={s.id}
                      onClick={() => toggleStoreAssignment(s.id)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: 'var(--spacing-sm) var(--spacing-md)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        background: assignedStoreIds.includes(s.id) ? 'var(--color-bg-hover)' : 'transparent',
                        transition: 'background 0.15s',
                      }}>
                      <span style={{ fontSize: 'var(--font-size-sm)' }}>{s.name}</span>
                      <span className={`badge ${assignedStoreIds.includes(s.id) ? 'badge-success' : 'badge-secondary'}`}
                        style={{ minWidth: '70px', textAlign: 'center', fontSize: 'var(--font-size-xs)' }}>
                        {assignedStoreIds.includes(s.id) ? t('users.assigned') : t('common.none')}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAssignedStoreIds([])}>{t('users.clear_all')}</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAssignedStoreIds(stores.map((s) => s.id))}>{t('users.select_all')}</button>
                </div>
                <div className="form-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowStoreAssign(false)}>{t('common.cancel')}</button>
                  <button type="button" className="btn btn-primary" onClick={handleSaveStoreAssign}>{t('users.save_assignments')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
