import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { storesAPI, usersAPI, inventoryAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import toast from 'react-hot-toast';
import { money, today, monthRange } from '../../utils/dates';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import '../products/Products.css';
import '../dashboard/Dashboard.css';
import './Stores.css';

const COLORS = ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#ec4899'];

/**
 * One branch: its report, its stock, its people, its prices.
 *
 * The tabs are deliberately different *powers*, not just different views:
 *   Overview  reports:read   — the money
 *   Stock     inventory:read — what is on the shelves
 *   Staff     users:write    — who may see the money (see stores.routes.js)
 *   Pricing   stores:write   — what it charges
 *
 * Anything the user cannot do is not shown, and the server enforces the same split, so
 * hiding a tab is a courtesy rather than the control.
 */
export default function StoreDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { t, locale } = useTranslation();
  const currency = t('common.currency');

  const canWrite = hasPermission('stores', 'write');
  const canSeeMoney = hasPermission('reports', 'read');
  const canSeeStock = hasPermission('inventory', 'read');
  const canAssign = hasPermission('users', 'write');
  const canSeeStaff = hasPermission('users', 'read');
  // Branch pricing answers to `product_prices`, not `stores:write`. Renaming a branch
  // and setting what it charges are different powers, and the server now agrees.
  const canSeePrices = hasPermission('product_prices', 'read');
  const canSetPrices = hasPermission('product_prices', 'write');

  const tabs = [
    canSeeMoney && 'overview',
    canSeeStock && 'stock',
    canSeeStaff && 'staff',
    canSeePrices && 'pricing',
  ].filter(Boolean);

  const [store, setStore] = useState(null);
  const [tab, setTab] = useState(tabs[0] || 'staff');
  const [loading, setLoading] = useState(true);

  // ---- overview
  const [overview, setOverview] = useState(null);
  const [period, setPeriod] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // ---- stock
  const [stock, setStock] = useState([]);
  const [stockSearch, setStockSearch] = useState('');

  // ---- staff
  const [staff, setStaff] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [assigned, setAssigned] = useState(new Set());
  const [savingStaff, setSavingStaff] = useState(false);

  // ---- pricing
  const [prices, setPrices] = useState([]);
  const [priceSearch, setPriceSearch] = useState('');
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const [priceDraft, setPriceDraft] = useState({});
  const [savingPrice, setSavingPrice] = useState(null);

  useEffect(() => {
    storesAPI.getById(id)
      .then((r) => setStore(r.data.data))
      .catch(() => { toast.error(t('stores.no_stores')); navigate('/stores'); })
      .finally(() => setLoading(false));
  }, [id]);

  const range = useCallback(() => {
    const now = new Date();
    if (period === 'today') return { startDate: today(), endDate: today() };
    if (period === 'month') { const r = monthRange(now); return { startDate: r.start, endDate: r.end }; }
    if (period === 'all') return { all_time: '1' };
    if (period === 'custom' && customFrom && customTo) return { startDate: customFrom, endDate: customTo };
    return {};
  }, [period, customFrom, customTo]);

  useEffect(() => {
    if (tab !== 'overview' || !canSeeMoney) return;
    storesAPI.overview(id, range())
      .then((r) => setOverview(r.data.data))
      .catch((e) => toast.error(e.response?.data?.message || t('common.error')));
  }, [tab, id, range, canSeeMoney]);

  useEffect(() => {
    if (tab !== 'stock' || !canSeeStock) return;
    const timer = setTimeout(() => {
      inventoryAPI.summary({ store_id: id, search: stockSearch, limit: 400 })
        .then((r) => setStock(r.data.data || []))
        .catch(() => setStock([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [tab, id, stockSearch, canSeeStock]);

  useEffect(() => {
    if (tab !== 'staff' || !canSeeStaff) return;
    Promise.all([storesAPI.listStaff(id), canAssign ? usersAPI.list() : Promise.resolve({ data: { data: [] } })])
      .then(([s, u]) => {
        setStaff(s.data.data || []);
        setAllUsers(u.data.data || []);
        setAssigned(new Set((s.data.data || []).filter((x) => x.assigned).map((x) => x.id)));
      })
      .catch((e) => toast.error(e.response?.data?.message || t('common.error')));
  }, [tab, id, canAssign]);

  const fetchPrices = useCallback(() => {
    if (tab !== 'pricing' || !canSeePrices) return;
    storesAPI.listPrices(id, { search: priceSearch, only_overridden: onlyOverridden, limit: 100 })
      .then((r) => { setPrices(r.data.data || []); setPriceDraft({}); })
      .catch((e) => toast.error(e.response?.data?.message || t('common.error')));
  }, [tab, id, priceSearch, onlyOverridden, canSeePrices]);

  useEffect(() => {
    const timer = setTimeout(fetchPrices, 300);
    return () => clearTimeout(timer);
  }, [fetchPrices]);

  const saveStaff = async () => {
    try {
      setSavingStaff(true);
      const { data } = await storesAPI.setStaff(id, [...assigned]);
      setStaff(data.data || []);
      toast.success(t('common.success'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSavingStaff(false); }
  };

  const savePrice = async (row, clear = false) => {
    const draft = priceDraft[row.product_id] || {};
    try {
      setSavingPrice(row.product_id);
      await storesAPI.setPrice(id, row.product_id, clear ? { selling_price: null } : {
        selling_price: draft.selling_price ?? row.store_selling_price ?? row.default_selling_price,
        min_selling_price: draft.min_selling_price ?? row.store_min_selling_price ?? null,
        max_selling_price: draft.max_selling_price ?? row.store_max_selling_price ?? null,
      });
      toast.success(t('common.success'));
      fetchPrices();
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.error'));
    } finally { setSavingPrice(null); }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!store) return null;

  const m = overview?.metrics || {};
  const tooltipStyle = { backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 8 };

  return (
    <div className="dashboard-page">
      <div className="store-detail__head">
        <div>
          <Link to="/stores" className="btn btn-sm btn-ghost" style={{ marginBottom: 8 }}>← {t('stores.title')}</Link>
          <h1 className="page-title" data-testid="store-detail-name">{store.name}</h1>
          <p className="page-subtitle">
            {[store.address, store.phone].filter(Boolean).join(' · ') || t('stores.no_address')}
            {store.is_warehouse && <span className="badge badge-neutral" style={{ marginInlineStart: 8 }}>{t('stores.warehouse')}</span>}
            <span className={`badge ${store.is_active ? 'badge-success' : 'badge-danger'}`} style={{ marginInlineStart: 8 }}>
              {store.is_active ? t('stores.open') : t('stores.closed')}
            </span>
          </p>
        </div>
        {tab === 'overview' && canSeeMoney && (
          <div className="dashboard-ribbon card">
            <div className="ribbon-group">
              <label>{t('reports.time_horizon')}</label>
              <select className="form-input" value={period} data-testid="store-period"
                onChange={(e) => setPeriod(e.target.value)}>
                <option value="today">{t('reports.today')}</option>
                <option value="month">{t('reports.this_month')}</option>
                <option value="all">{t('reports.all_time')}</option>
                <option value="custom">{t('reports.custom')}</option>
              </select>
            </div>
            {period === 'custom' && (
              <>
                <div className="ribbon-group"><label>{t('common.from')}</label>
                  <input type="date" className="form-input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></div>
                <div className="ribbon-group"><label>{t('common.to')}</label>
                  <input type="date" className="form-input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        {tabs.map((key) => (
          <button key={key} className={`tab ${tab === key ? 'tab--active' : ''}`}
            data-testid={`store-tab-${key}`} onClick={() => setTab(key)}>
            {t(`stores.tab_${key}`)}
          </button>
        ))}
      </div>

      {/* ───────────────────────────────── overview */}
      {tab === 'overview' && canSeeMoney && (
        !overview ? <div className="loading-screen"><div className="spinner" /></div> : (
          <div className="dashboard-content">
            <p className="section-hint">{t('stores.overview_hint')}</p>
            <div className="metrics-grid">
              <div className="metric-card card"><h4>{t('reports.net_sales')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-primary)' }} data-testid="store-revenue">{money(m.revenue, currency)}</div>
                {/* Gross beside it, so a branch with heavy returns sees both halves
                    rather than one number that hides them. */}
                <div className="metric-sub">
                  {m.sales_count} {t('reports.orders')}
                  {m.refunded > 0 && ` · ${t('reports.total_refunded')} ${money(m.refunded, currency)}`}
                </div></div>
              <div className="metric-card card"><h4>{t('reports.clear_profit')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-success)' }}>{money(m.gross_profit, currency)}</div>
                <div className="metric-sub">{m.margin_pct}% {t('reports.net_margin')}</div></div>
              <div className="metric-card card"><h4>{t('reports.total_expenses')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-danger)' }}>{money(m.expenses, currency)}</div>
                <div className="metric-sub">{t('reports.in_period')}</div></div>
              <div className="metric-card card"><h4>{t('stores.net')}</h4>
                <div className="metric-val" style={{ color: m.net >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>{money(m.net, currency)}</div>
                <div className="metric-sub">{t('stores.net_hint')}</div></div>
              <div className="metric-card card"><h4>{t('reports.avg_order_value')}</h4>
                <div className="metric-val">{money(m.aov, currency)}</div>
                <div className="metric-sub">{t('stores.customers_served', { n: m.customers })}</div></div>
              <div className="metric-card card"><h4>{t('reports.items_moved')}</h4>
                <div className="metric-val">{m.items_sold}</div>
                <div className="metric-sub">{m.items_returned} {t('reports.returned_items')}</div></div>
              <div className="metric-card card"><h4>{t('stores.stock_value')}</h4>
                <div className="metric-val" style={{ color: '#8b5cf6' }}>{money(m.stock_value, currency)}</div>
                <div className="metric-sub">{m.stock_units} {t('reports.units')}</div></div>
              <div className="metric-card card"><h4>{t('stores.owed')}</h4>
                <div className="metric-val" style={{ color: m.customer_credit > 0 ? '#f59e0b' : undefined }}>{money(m.customer_credit, currency)}</div>
                <div className="metric-sub">{t('stores.owed_hint')}</div></div>
            </div>

            <div className="charts-grid">
              <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
                <h3>{t('stores.daily_revenue')}</h3>
                <div className="chart-wrapper"><ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={overview.trend}>
                    <defs><linearGradient id="sRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#818cf8" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#818cf8" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
                    <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                    <RechartsTooltip contentStyle={tooltipStyle} />
                    <Area type="monotone" name={t('reports.revenue')} dataKey="revenue" stroke="#818cf8" strokeWidth={3} fill="url(#sRev)" />
                  </AreaChart>
                </ResponsiveContainer></div>
              </div>
              <div className="chart-card card">
                <h3>{t('reports.payment_methods')}</h3>
                <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart><Pie data={overview.payment_methods} dataKey="total" nameKey="method" cx="50%" cy="50%" outerRadius={95} label={(r) => r.method}>
                      {overview.payment_methods.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie><RechartsTooltip formatter={(v) => money(v, currency)} contentStyle={tooltipStyle} /></PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="charts-grid">
              <div className="chart-card card">
                <h3>{t('stores.stock_by_category')}</h3>
                <div className="chart-wrapper"><ResponsiveContainer width="100%" height={260}>
                  <BarChart data={overview.stock_by_category.map((r) => ({
                    ...r, label: locale === 'ar' && r.category_ar ? r.category_ar : r.category,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={11} />
                    <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                    <RechartsTooltip contentStyle={tooltipStyle} />
                    <Legend />
                    <Bar name={t('reports.units')} dataKey="units" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer></div>
              </div>
              <div className="chart-card card">
                <h3>{t('stores.staff_performance')}</h3>
                <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
                  <thead><tr><th>{t('reports.name')}</th><th style={{ textAlign: 'end' }}>{t('reports.sales_count')}</th><th style={{ textAlign: 'end' }}>{t('reports.revenue')}</th></tr></thead>
                  <tbody>{overview.staff.length === 0
                    ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                    : overview.staff.map((s, i) => (
                      <tr key={i}><td>{s.name}</td><td style={{ textAlign: 'end' }}>{s.sales_count}</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-success)', fontWeight: 600 }}>{money(s.revenue, currency)}</td></tr>
                    ))}</tbody>
                </table></div>
              </div>
            </div>

            <div className="leaderboards-grid">
              <div className="leaderboard-card card">
                <div className="card-header"><h3>{t('reports.top_products')}</h3></div>
                <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
                  <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th style={{ textAlign: 'end' }}>{t('reports.qty')}</th><th style={{ textAlign: 'end' }}>{t('reports.profit')}</th></tr></thead>
                  <tbody>{overview.top_products.length === 0
                    ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                    : overview.top_products.map((p, i) => (
                      <tr key={i}><td><strong>{p.code}</strong></td><td>{p.name}</td>
                        <td style={{ textAlign: 'end' }}>{p.qty}</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-success)' }}>{money(p.profit, currency)}</td></tr>
                    ))}</tbody>
                </table></div>
              </div>
              <div className="leaderboard-card card">
                <div className="card-header"><h3>{t('reports.low_stock')}</h3><span className="badge badge-danger">{t('reports.immediate_action')}</span></div>
                <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
                  <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th style={{ textAlign: 'end' }}>{t('reports.in_stock')}</th></tr></thead>
                  <tbody>{overview.low_stock.length === 0
                    ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                    : overview.low_stock.map((p, i) => (
                      <tr key={i}><td><strong>{p.code}</strong></td><td>{p.name}</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-danger)', fontWeight: 700 }}>{p.stock}</td></tr>
                    ))}</tbody>
                </table></div>
              </div>
            </div>
          </div>
        )
      )}

      {/* ───────────────────────────────── stock */}
      {tab === 'stock' && canSeeStock && (
        <>
          <p className="section-hint">{t('stores.stock_hint')}</p>
          <div className="card" style={{ marginBottom: 'var(--spacing-md)' }}>
            <input className="form-input" data-testid="store-stock-search"
              placeholder={t('common.search')} value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)} />
          </div>
          <div className="table-container">
            <table className="table" data-testid="store-stock-table">
              <thead><tr>
                <th>{t('reports.code')}</th><th>{t('reports.name')}</th>
                <th>{t('pos.color')}</th><th>{t('products.size_generic')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.in_stock')}</th>
              </tr></thead>
              <tbody>
                {stock.length === 0
                  ? <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                  : stock.map((r) => (
                    <tr key={r.variant_id}>
                      <td><strong>{r.product_code}</strong></td>
                      <td>{r.product_name}</td>
                      <td>{r.color_is_placeholder ? '—' : r.color_name}</td>
                      <td>{r.size_eu}</td>
                      <td style={{ textAlign: 'end' }}>{r.quantity}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ───────────────────────────────── staff */}
      {tab === 'staff' && (
        <>
          <p className="section-hint">{t('stores.staff_hint')}</p>
          <div className="table-container">
            <table className="table" data-testid="store-staff-table">
              <thead><tr>
                {canAssign && <th style={{ width: 40 }}></th>}
                <th>{t('common.name')}</th><th>{t('users.username')}</th><th>{t('users.role')}</th><th>{t('common.status')}</th>
              </tr></thead>
              <tbody>
                {(canAssign ? allUsers : staff).length === 0
                  ? <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                  : (canAssign ? allUsers : staff).map((u) => {
                    const row = staff.find((s) => s.id === u.id);
                    return (
                      <tr key={u.id}>
                        {canAssign && (
                          <td>
                            <input type="checkbox" data-testid={`assign-user-${u.id}`}
                              checked={assigned.has(u.id)}
                              onChange={(e) => {
                                const next = new Set(assigned);
                                if (e.target.checked) next.add(u.id); else next.delete(u.id);
                                setAssigned(next);
                              }} />
                          </td>
                        )}
                        <td>{u.full_name || u.username}</td>
                        <td>{u.username}</td>
                        <td>{u.role_name || row?.role_name || '—'}</td>
                        <td>
                          {row?.is_home_store && <span className="badge badge-neutral">{t('stores.home_store')}</span>}
                          {' '}
                          <span className={`badge ${u.is_active ? 'badge-success' : 'badge-danger'}`}>
                            {u.is_active ? t('common.active') : t('common.inactive')}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {canAssign && (
            <div style={{ marginTop: 'var(--spacing-md)', display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className="btn btn-primary" disabled={savingStaff} onClick={saveStaff} data-testid="save-staff">
                {savingStaff ? '…' : t('common.save')}
              </button>
              <small style={{ color: 'var(--color-text-muted)' }}>{t('stores.home_store_note')}</small>
            </div>
          )}
        </>
      )}

      {/* ───────────────────────────────── pricing */}
      {tab === 'pricing' && canSeePrices && (
        <>
          <p className="section-hint">{t('stores.pricing_hint')}</p>
          <div className="card" style={{ marginBottom: 'var(--spacing-md)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="form-input" style={{ flex: 1, minWidth: 200 }} data-testid="store-price-search"
              placeholder={t('common.search')} value={priceSearch} onChange={(e) => setPriceSearch(e.target.value)} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" data-testid="only-overridden"
                checked={onlyOverridden} onChange={(e) => setOnlyOverridden(e.target.checked)} />
              {t('stores.only_overridden')}
            </label>
          </div>
          <div className="table-container">
            <table className="table" data-testid="store-prices-table">
              <thead><tr>
                <th>{t('reports.code')}</th><th>{t('reports.name')}</th>
                <th style={{ textAlign: 'end' }}>{t('stores.catalogue_price')}</th>
                <th style={{ textAlign: 'end' }}>{t('stores.store_price')}</th>
                <th style={{ textAlign: 'end' }}>{t('products.min_price')}</th>
                <th style={{ textAlign: 'end' }}>{t('products.max_price')}</th>
                <th></th>
              </tr></thead>
              <tbody>
                {prices.length === 0
                  ? <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr>
                  : prices.map((p) => {
                    const draft = priceDraft[p.product_id] || {};
                    const overridden = p.store_selling_price !== null && p.store_selling_price !== undefined;
                    return (
                      <tr key={p.product_id} className="store-price-row" data-testid={`price-row-${p.product_id}`}>
                        <td><strong>{p.product_code}</strong></td>
                        <td>{p.product_name}{p.brand ? ` · ${p.brand}` : ''}</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-text-muted)' }}>{money(p.default_selling_price, currency)}</td>
                        <td style={{ textAlign: 'end' }}>
                          <input className="form-input" type="number" step="0.01" style={{ textAlign: 'end' }}
                            data-testid={`price-input-${p.product_id}`}
                            placeholder={p.default_selling_price}
                            value={draft.selling_price ?? (overridden ? p.store_selling_price : '')}
                            onChange={(e) => setPriceDraft({ ...priceDraft, [p.product_id]: { ...draft, selling_price: e.target.value } })} />
                        </td>
                        <td style={{ textAlign: 'end' }}>
                          <input className="form-input" type="number" step="0.01" style={{ textAlign: 'end' }}
                            placeholder={p.min_selling_price ?? '—'}
                            value={draft.min_selling_price ?? (p.store_min_selling_price ?? '')}
                            onChange={(e) => setPriceDraft({ ...priceDraft, [p.product_id]: { ...draft, min_selling_price: e.target.value } })} />
                        </td>
                        <td style={{ textAlign: 'end' }}>
                          <input className="form-input" type="number" step="0.01" style={{ textAlign: 'end' }}
                            placeholder={p.max_selling_price ?? '—'}
                            value={draft.max_selling_price ?? (p.store_max_selling_price ?? '')}
                            onChange={(e) => setPriceDraft({ ...priceDraft, [p.product_id]: { ...draft, max_selling_price: e.target.value } })} />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm btn-primary"
                            disabled={savingPrice === p.product_id || !canSetPrices}
                            data-testid={`save-price-${p.product_id}`} onClick={() => savePrice(p)}>
                            {t('common.save')}
                          </button>
                          {overridden && (
                            <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: 6 }}
                              disabled={!canSetPrices}
                              data-testid={`clear-price-${p.product_id}`} onClick={() => savePrice(p, true)}>
                              {t('stores.use_catalogue')}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
