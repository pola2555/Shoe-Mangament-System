import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { storesAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from '../../i18n/i18nContext';
import { money } from '../../utils/dates';
import '../products/Products.css';
import './Stores.css';

/**
 * Stores.
 *
 * This was a four-column table: name, phone, address, status. A store is the unit the
 * entire system is scoped by — every sale, every pair of shoes and every expense
 * belongs to one — and yet nothing could be said *about* one. It could not even be
 * marked as a warehouse or closed from the form that claimed to edit it.
 *
 * Each card now answers "how is this branch doing" without a click, and clicking opens
 * the branch itself: its report, its stock, its staff and its prices.
 */
export default function StoresPage() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', phone: '', is_warehouse: false, is_active: true });
  const [editingId, setEditingId] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('stores', 'write');
  const canSeeMoney = hasPermission('reports', 'read');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currency = t('common.currency');

  const fetchStores = useCallback(async () => {
    try {
      setLoading(true);
      // Figures are opt-in on the API. This is the one screen that wants them.
      const { data } = canSeeMoney ? await storesAPI.withStats() : await storesAPI.list();
      setStores(data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t('stores.no_stores'));
    } finally { setLoading(false); }
  }, [canSeeMoney]);

  useEffect(() => { fetchStores(); }, [fetchStores]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ name: '', address: '', phone: '', is_warehouse: false, is_active: true });
    setShowForm(true);
  };

  const openEdit = (s) => {
    setForm({
      name: s.name, address: s.address || '', phone: s.phone || '',
      is_warehouse: !!s.is_warehouse, is_active: !!s.is_active,
    });
    setEditingId(s.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      if (editingId) await storesAPI.update(editingId, form);
      else await storesAPI.create({ name: form.name, address: form.address, phone: form.phone, is_warehouse: form.is_warehouse });
      toast.success(t('common.success'));
      setShowForm(false);
      setEditingId(null);
      fetchStores();
    } catch (err) {
      // The server refuses to close a store that still holds stock, and says how much.
      // That message is the whole point, so it is shown rather than a generic failure.
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSaving(false); }
  };

  const visible = stores.filter((s) => showClosed || s.is_active);
  const closedCount = stores.length - stores.filter((s) => s.is_active).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('stores.title')}</h1>
          <p className="page-subtitle">{t('stores.page_hint')}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          {closedCount > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9em' }}>
              <input type="checkbox" data-testid="show-closed-stores"
                checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              {t('stores.show_closed', { count: closedCount })}
            </label>
          )}
          {canWrite && (
            <button className="btn btn-primary" data-testid="add-store" onClick={openCreate}>
              + {t('stores.add_store')}
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content card" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--spacing-lg)' }}>
              {editingId ? t('stores.edit_store') : t('stores.add_store')}
            </h2>
            <form onSubmit={handleSubmit} className="product-form">
              <div className="form-group">
                <label className="form-label">{t('stores.store_name')} *</label>
                <input className="form-input" required data-testid="store-name"
                  value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('common.phone')}</label>
                  <input className="form-input" value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.address')}</label>
                  <input className="form-input" value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" data-testid="store-is-warehouse"
                    checked={form.is_warehouse}
                    onChange={(e) => setForm({ ...form, is_warehouse: e.target.checked })} />
                  {t('stores.is_warehouse')}
                </label>
                <small style={{ color: 'var(--color-text-muted)' }}>{t('stores.is_warehouse_hint')}</small>
              </div>
              {editingId && (
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" data-testid="store-is-active"
                      checked={form.is_active}
                      onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                    {t('stores.is_open')}
                  </label>
                  <small style={{ color: 'var(--color-text-muted)' }}>{t('stores.is_open_hint')}</small>
                </div>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving} data-testid="save-store">
                  {saving ? '…' : editingId ? t('common.update') : t('common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? <div className="loading-screen"><div className="spinner" /></div> : (
        <div className="store-grid" data-testid="store-grid">
          {visible.length === 0 && <div className="card">{t('stores.no_stores')}</div>}
          {visible.map((s) => {
            const st = s.stats;
            return (
              <div key={s.id} className={`card store-card ${s.is_active ? '' : 'store-card--closed'}`}
                data-testid={`store-card-${s.id}`}
                role="button" tabIndex={0}
                onClick={() => navigate(`/stores/${s.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/stores/${s.id}`); }}>
                <div className="store-card__head">
                  <div>
                    <h3 className="store-card__name">{s.name}</h3>
                    <p className="store-card__where">{s.address || s.phone || '—'}</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                    {s.is_warehouse && <span className="badge badge-neutral">{t('stores.warehouse')}</span>}
                    <span className={`badge ${s.is_active ? 'badge-success' : 'badge-danger'}`}>
                      {s.is_active ? t('stores.open') : t('stores.closed')}
                    </span>
                  </div>
                </div>

                {st ? (
                  <>
                    <div className="store-card__stats">
                      <div>
                        <span className="store-stat__label">{t('stores.stock')}</span>
                        <span className="store-stat__value">{st.stock_units}</span>
                      </div>
                      <div>
                        <span className="store-stat__label">{t('stores.today')}</span>
                        <span className="store-stat__value">{money(st.revenue_today, currency)}</span>
                      </div>
                      <div>
                        <span className="store-stat__label">{t('stores.this_month')}</span>
                        <span className="store-stat__value">{money(st.revenue_month, currency)}</span>
                      </div>
                    </div>
                    <div className="store-card__foot">
                      <span>{t('stores.stock_value')}: <strong>{money(st.stock_value, currency)}</strong></span>
                      <span>·</span>
                      <span>
                        {t('stores.net_month')}:{' '}
                        <strong className={st.net_month >= 0 ? 'store-num--good' : 'store-num--bad'}>
                          {money(st.net_month, currency)}
                        </strong>
                      </span>
                      <span>·</span>
                      <span>{t('stores.staff')}: <strong>{st.staff_count}</strong></span>
                      {st.transfers_in + st.transfers_out > 0 && (
                        <>
                          <span>·</span>
                          <span className="badge badge-warning">
                            {t('stores.transfers_pending', { n: st.transfers_in + st.transfers_out })}
                          </span>
                        </>
                      )}
                      {st.customer_credit > 0 && (
                        <>
                          <span>·</span>
                          <span className="badge badge-warning">
                            {t('stores.owed')}: {money(st.customer_credit, currency)}
                          </span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="store-card__foot">{t('stores.no_figures')}</div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 'var(--spacing-sm)' }}
                  onClick={(e) => e.stopPropagation()}>
                  <Link className="btn btn-sm btn-secondary" to={`/stores/${s.id}`}
                    data-testid={`open-store-${s.id}`}>
                    {t('stores.manage')}
                  </Link>
                  {canWrite && (
                    <button className="btn btn-sm btn-ghost" onClick={() => openEdit(s)}
                      data-testid={`edit-store-${s.id}`}>
                      {t('common.edit')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
