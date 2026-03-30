import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { reportsAPI, storesAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import SearchableSelect from '../../components/common/SearchableSelect';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend
} from 'recharts';
import '../dashboard/Dashboard.css';

const COLORS = ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#ec4899', '#22d3ee', '#fb923c'];
const TABS = ['overview', 'sales_analytics', 'products_analytics', 'inventory_analytics', 'financial', 'customers_analytics', 'employees_analytics'];

export default function ReportsPage() {
  const { user, filterStores } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role_name === 'admin' || user?.role_name === 'System Administrator';

  const [activeTab, setActiveTab] = useState('overview');
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  const [dateOption, setDateOption] = useState('This Month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [limitOption, setLimitOption] = useState(10);
  const [filters, setFilters] = useState({
    store_id: !isAdmin ? (user?.store_id || '') : '',
    startDate: '', endDate: '', limit: 10,
  });

  useEffect(() => {
    if (isAdmin) storesAPI.list().then(r => setStores(filterStores(r.data.data))).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    if (dateOption === 'Custom') return;
    let s = '', e = '';
    const now = new Date();
    if (dateOption === 'Today') { s = e = now.toISOString().split('T')[0]; }
    else if (dateOption === 'This Week') { const d = new Date(); d.setDate(d.getDate() - d.getDay()); s = d.toISOString().split('T')[0]; e = now.toISOString().split('T')[0]; }
    else if (dateOption === 'This Month') { s = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]; e = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]; }
    else if (dateOption === 'This Year') { s = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0]; e = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0]; }
    setFilters(p => ({ ...p, startDate: s, endDate: e, limit: limitOption }));
  }, [dateOption, limitOption]);

  useEffect(() => {
    if (dateOption === 'Custom' && customStart && customEnd) setFilters(p => ({ ...p, startDate: customStart, endDate: customEnd, limit: limitOption }));
  }, [dateOption, customStart, customEnd, limitOption]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const api = {
        overview: () => reportsAPI.dashboard(filters),
        sales_analytics: () => reportsAPI.salesAnalytics(filters),
        products_analytics: () => reportsAPI.productAnalytics(filters),
        inventory_analytics: () => reportsAPI.inventoryAnalytics(filters),
        financial: () => reportsAPI.financial(filters),
        customers_analytics: () => reportsAPI.customerAnalytics(filters),
        employees_analytics: () => reportsAPI.employeeAnalytics(filters),
      };
      const res = await api[activeTab]();
      setData(res.data.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [activeTab, filters]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fmt = (v) => v != null ? parseFloat(v).toLocaleString() : '—';
  const tooltipStyle = { backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 8 };
  const itemStyle = { color: 'var(--color-text-primary)' };
  const DOW_LABELS = [t('reports.sun'), t('reports.mon'), t('reports.tue'), t('reports.wed'), t('reports.thu'), t('reports.fri'), t('reports.sat')];

  // ─── RENDER TAB CONTENT ───
  const renderOverview = () => {
    const m = data?.metrics || {};
    const ch = data?.charts || {};
    const lb = data?.leaderboards || {};
    const cards = [
      { label: t('reports.net_sales'), value: `${fmt(m.net_sales)} ${t('common.currency')}`, sub: `${fmt(m.total_sales)} ${t('reports.orders')}`, color: 'var(--color-primary)' },
      { label: t('reports.clear_profit'), value: `${fmt(m.clear_profit)} ${t('common.currency')}`, sub: `${m.net_margin_pct}% ${t('reports.net_margin')}`, color: 'var(--color-success)' },
      { label: t('reports.avg_order_value'), value: `${fmt(m.aov)} ${t('common.currency')}`, sub: t('reports.per_sale'), color: '#6366f1' },
      { label: t('reports.items_moved'), value: `${fmt(m.items_sold)} ${t('reports.sold')}`, sub: `${fmt(m.items_returned)} ${t('reports.returned_items')}`, color: '#f59e0b' },
      { label: t('reports.total_expenses'), value: `${fmt(m.total_expenses)} ${t('common.currency')}`, sub: t('reports.in_period'), color: 'var(--color-danger)' },
      { label: t('reports.profit_minus_expenses'), value: `${fmt((m.clear_profit || 0) - (m.total_expenses || 0))} ${t('common.currency')}`, sub: t('reports.clear_profit_minus_expenses'), color: ((m.clear_profit || 0) - (m.total_expenses || 0)) >= 0 ? '#059669' : 'var(--color-danger)' },
      { label: t('reports.total_money'), value: `${fmt((m.net_sales || 0) - (m.total_expenses || 0))} ${t('common.currency')}`, sub: t('reports.net_sales_minus_expenses'), color: ((m.net_sales || 0) - (m.total_expenses || 0)) >= 0 ? '#10b981' : 'var(--color-danger)' },
      { label: t('reports.net_after_loans'), value: `${fmt((m.net_sales || 0) - (m.total_expenses || 0) - (m.total_loans_outstanding || 0))} ${t('common.currency')}`, sub: `${t('reports.loans_outstanding')}: ${fmt(m.total_loans_outstanding)} ${t('common.currency')}`, color: ((m.net_sales || 0) - (m.total_expenses || 0) - (m.total_loans_outstanding || 0)) >= 0 ? '#0ea5e9' : 'var(--color-danger)' },
      { label: t('reports.inventory_value'), value: `${fmt(m.inventory_valuation)} ${t('common.currency')}`, sub: `${fmt(m.inventory_in_stock)} ${t('reports.units')}`, color: '#8b5cf6' },
    ];
    return (
      <>
        <div className="metrics-grid">
          {cards.map((c, i) => (
            <div key={i} className="metric-card card">
              <h4>{c.label}</h4>
              <div className="metric-val" style={{ color: c.color }}>{c.value}</div>
              <div className="metric-sub">{c.sub}</div>
            </div>
          ))}
        </div>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.revenue_vs_profit')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <AreaChart data={ch.trend || []}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.3} /><stop offset="95%" stopColor="#818cf8" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gProf" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34d399" stopOpacity={0.3} /><stop offset="95%" stopColor="#34d399" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} tickFormatter={v => `${v / 1000}k`} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Area type="monotone" name={t('reports.revenue')} dataKey="revenue" stroke="#818cf8" strokeWidth={3} fill="url(#gRev)" />
                <Area type="monotone" name={t('reports.profit')} dataKey="profit" stroke="#34d399" strokeWidth={3} fill="url(#gProf)" />
              </AreaChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.payment_methods')}</h3>
            <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart><Pie data={ch.payment_methods || []} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={r => r.name}>
                  {(ch.payment_methods || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip formatter={v => `${fmt(v)} ${t('common.currency')}`} contentStyle={tooltipStyle} /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.top_products')}</h3><span className="badge badge-accent">{t('reports.by_revenue')}</span></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th style={{ textAlign: 'right' }}>{t('reports.qty')}</th><th style={{ textAlign: 'right' }}>{t('reports.revenue')}</th></tr></thead>
              <tbody>{(lb.top_products || []).length === 0 ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (lb.top_products || []).map((p, i) => <tr key={i}><td><strong>{p.product}</strong></td><td>{p.name}</td><td style={{ textAlign: 'right' }}>{p.qty}</td><td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmt(p.revenue)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.low_stock')}</h3><span className="badge badge-danger">{t('reports.immediate_action')}</span></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th style={{ textAlign: 'right' }}>{t('reports.in_stock')}</th></tr></thead>
              <tbody>{(lb.low_stock || []).length === 0 ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (lb.low_stock || []).map((p, i) => <tr key={i}><td><strong>{p.product}</strong></td><td>{p.name}</td><td style={{ textAlign: 'right', color: 'var(--color-danger)', fontWeight: 700 }}>{p.stock}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderSalesAnalytics = () => {
    if (!data) return null;
    const ds = data.discount_stats || {};
    return (
      <>
        {/* Discount Summary Cards */}
        <div className="metrics-grid">
          <div className="metric-card card"><h4>{t('reports.total_discounted')}</h4><div className="metric-val" style={{ color: '#f59e0b' }}>{ds.discounted_sales} / {ds.total_sales}</div></div>
          <div className="metric-card card"><h4>{t('reports.total_discount_amount')}</h4><div className="metric-val" style={{ color: 'var(--color-danger)' }}>{fmt(ds.total_discount)} {t('common.currency')}</div></div>
          <div className="metric-card card"><h4>{t('reports.avg_discount_amount')}</h4><div className="metric-val" style={{ color: '#8b5cf6' }}>{fmt(ds.avg_discount)} {t('common.currency')}</div></div>
        </div>
        <div className="charts-grid">
          {/* Daily Sales */}
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.daily_sales')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.daily_sales || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.revenue')} dataKey="revenue" fill="#818cf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          {/* Hourly Distribution */}
          <div className="chart-card card">
            <h3>{t('reports.hourly_distribution')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.hourly_distribution || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="hour" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Bar name={t('reports.count')} dataKey="count" fill="#34d399" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
        </div>
        <div className="charts-grid">
          {/* Day of Week */}
          <div className="chart-card card">
            <h3>{t('reports.day_of_week_distribution')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={(data.day_of_week || []).map(r => ({ ...r, label: DOW_LABELS[r.dow] || r.dow }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Bar name={t('reports.revenue')} dataKey="revenue" fill="#fbbf24" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          {/* AOV Trend */}
          <div className="chart-card card">
            <h3>{t('reports.aov_trend')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.aov_trend || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Line type="monotone" name={t('reports.avg_order_value')} dataKey="aov" stroke="#a78bfa" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer></div>
          </div>
          {/* Payment Methods */}
          <div className="chart-card card">
            <h3>{t('reports.payment_methods')}</h3>
            <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart><Pie data={data.payment_methods || []} dataKey="total" nameKey="method" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={3}>
                  {(data.payment_methods || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip formatter={v => `${fmt(v)} ${t('common.currency')}`} contentStyle={tooltipStyle} /><Legend /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </>
    );
  };

  const renderProductAnalytics = () => {
    if (!data) return null;
    return (
      <>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.brand_performance')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.brand_performance || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="brand" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.revenue')} dataKey="revenue" fill="#818cf8" radius={[4, 4, 0, 0]} />
                <Bar name={t('reports.qty')} dataKey="qty" fill="#34d399" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.size_distribution')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.size_distribution || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="size" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Bar name={t('reports.count')} dataKey="count" fill="#fbbf24" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
        </div>
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.top_by_quantity')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th>{t('reports.brand')}</th><th style={{ textAlign: 'right' }}>{t('reports.qty')}</th><th style={{ textAlign: 'right' }}>{t('reports.revenue')}</th><th style={{ textAlign: 'right' }}>{t('reports.profit')}</th></tr></thead>
              <tbody>{(data.top_by_qty || []).length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.top_by_qty || []).map((p, i) => <tr key={i}><td><strong>{p.code}</strong></td><td>{p.name}</td><td>{p.brand}</td><td style={{ textAlign: 'right' }}>{p.qty}</td><td style={{ textAlign: 'right' }}>{fmt(p.revenue)}</td><td style={{ textAlign: 'right', color: 'var(--color-success)' }}>{fmt(p.profit)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.top_by_revenue')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th>{t('reports.brand')}</th><th style={{ textAlign: 'right' }}>{t('reports.qty')}</th><th style={{ textAlign: 'right' }}>{t('reports.revenue')}</th><th style={{ textAlign: 'right' }}>{t('reports.profit')}</th></tr></thead>
              <tbody>{(data.top_by_revenue || []).length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.top_by_revenue || []).map((p, i) => <tr key={i}><td><strong>{p.code}</strong></td><td>{p.name}</td><td>{p.brand}</td><td style={{ textAlign: 'right' }}>{p.qty}</td><td style={{ textAlign: 'right' }}>{fmt(p.revenue)}</td><td style={{ textAlign: 'right', color: 'var(--color-success)' }}>{fmt(p.profit)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderInventoryAnalytics = () => {
    if (!data) return null;
    const ag = data.aging || {};
    return (
      <>
        <div className="metrics-grid">
          <div className="metric-card card"><h4>{t('reports.within_30_days')}</h4><div className="metric-val" style={{ color: 'var(--color-success)' }}>{ag.within_30}</div></div>
          <div className="metric-card card"><h4>{t('reports.d30_60')}</h4><div className="metric-val" style={{ color: '#fbbf24' }}>{ag.d30_60}</div></div>
          <div className="metric-card card"><h4>{t('reports.d60_90')}</h4><div className="metric-val" style={{ color: '#f59e0b' }}>{ag.d60_90}</div></div>
          <div className="metric-card card"><h4>{t('reports.over_90_days')}</h4><div className="metric-val" style={{ color: 'var(--color-danger)' }}>{ag.over_90}</div></div>
        </div>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.stock_by_store')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.stock_by_store || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.count')} dataKey="count" fill="#818cf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.status_distribution')}</h3>
            <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart><Pie data={data.status_distribution || []} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={100} label={r => r.status}>
                  {(data.status_distribution || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip contentStyle={tooltipStyle} /><Legend /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="charts-grid">
          <div className="chart-card card">
            <h3>{t('reports.brand_performance')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.stock_by_brand || []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis dataKey="brand" type="category" stroke="var(--color-text-muted)" fontSize={11} width={100} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Bar name={t('reports.count')} dataKey="count" fill="#a78bfa" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.size_distribution')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.stock_by_size || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="size" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Bar name={t('reports.count')} dataKey="count" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
        </div>
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.low_stock')}</h3><span className="badge badge-danger">{t('reports.immediate_action')}</span></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.code')}</th><th>{t('reports.name')}</th><th style={{ textAlign: 'right' }}>{t('reports.in_stock')}</th></tr></thead>
              <tbody>{(data.low_stock || []).length === 0 ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.low_stock || []).map((p, i) => <tr key={i}><td><strong>{p.code}</strong></td><td>{p.name}</td><td style={{ textAlign: 'right', color: 'var(--color-danger)', fontWeight: 700 }}>{p.stock}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderFinancial = () => {
    if (!data) return null;
    const s = data.summary || {};
    const cards = [
      { label: t('reports.total_revenue'), value: fmt(s.total_revenue), color: 'var(--color-primary)' },
      { label: t('reports.total_refunded'), value: fmt(s.total_refunded), color: 'var(--color-danger)' },
      { label: t('reports.net_revenue'), value: fmt(s.net_revenue), color: '#818cf8' },
      { label: t('reports.cogs'), value: fmt(s.cogs), color: '#f59e0b' },
      { label: t('reports.gross_profit'), value: fmt(s.gross_profit), color: 'var(--color-success)' },
      { label: t('reports.total_expenses'), value: fmt(s.total_expenses), color: '#ec4899' },
      { label: t('reports.net_profit'), value: fmt(s.net_profit), color: s.net_profit >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
    ];
    return (
      <>
        <div className="metrics-grid">
          {cards.map((c, i) => (
            <div key={i} className="metric-card card">
              <h4>{c.label}</h4>
              <div className="metric-val" style={{ color: c.color }}>{c.value} {t('common.currency')}</div>
            </div>
          ))}
        </div>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.pl_trend')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.pl_trend || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="month" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} tickFormatter={v => `${v / 1000}k`} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.revenue')} dataKey="revenue" fill="#818cf8" radius={[4, 4, 0, 0]} />
                <Bar name={t('reports.refunds')} dataKey="refunds" fill="#f87171" radius={[4, 4, 0, 0]} />
                <Bar name={t('reports.expenses')} dataKey="expenses" fill="#fbbf24" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.expenses_by_category')}</h3>
            <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart><Pie data={data.expenses_by_category || []} dataKey="total" nameKey="category" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={3}>
                  {(data.expenses_by_category || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip formatter={v => `${fmt(v)} ${t('common.currency')}`} contentStyle={tooltipStyle} /><Legend /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.supplier_balances')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.name')}</th><th style={{ textAlign: 'right' }}>{t('reports.invoiced')}</th><th style={{ textAlign: 'right' }}>{t('reports.paid')}</th><th style={{ textAlign: 'right' }}>{t('reports.balance')}</th></tr></thead>
              <tbody>{(data.supplier_balances || []).length === 0 ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.supplier_balances || []).map((r, i) => <tr key={i}><td>{r.name}</td><td style={{ textAlign: 'right' }}>{fmt(r.invoiced)}</td><td style={{ textAlign: 'right' }}>{fmt(r.paid)}</td><td style={{ textAlign: 'right', color: 'var(--color-danger)', fontWeight: 600 }}>{fmt(r.balance)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderCustomerAnalytics = () => {
    if (!data) return null;
    const w = data.walk_in_stats || {};
    return (
      <>
        <div className="metrics-grid">
          <div className="metric-card card"><h4>{t('reports.customer_count')}</h4><div className="metric-val" style={{ color: 'var(--color-primary)' }}>{w.total}</div></div>
          <div className="metric-card card"><h4>{t('reports.walk_in_customers')}</h4><div className="metric-val" style={{ color: '#fbbf24' }}>{w.walk_in}</div></div>
          <div className="metric-card card"><h4>{t('reports.registered_customers')}</h4><div className="metric-val" style={{ color: 'var(--color-success)' }}>{w.registered}</div></div>
        </div>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.customer_trend')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.customer_trend || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="month" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.orders')} dataKey="total_orders" fill="#818cf8" radius={[4, 4, 0, 0]} />
                <Bar name={t('reports.unique_customers')} dataKey="unique_customers" fill="#34d399" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
        </div>
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.top_customers')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.name')}</th><th>{t('reports.phone')}</th><th style={{ textAlign: 'right' }}>{t('reports.visits')}</th><th style={{ textAlign: 'right' }}>{t('reports.total_spent')}</th></tr></thead>
              <tbody>{(data.top_customers || []).length === 0 ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.top_customers || []).map((c, i) => <tr key={i}><td>{c.name || '—'}</td><td>{c.phone}</td><td style={{ textAlign: 'right' }}>{c.visits}</td><td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmt(c.total_spent)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.top_returners')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.name')}</th><th>{t('reports.phone')}</th><th style={{ textAlign: 'right' }}>{t('reports.returns_count')}</th></tr></thead>
              <tbody>{(data.top_returners || []).length === 0 ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.top_returners || []).map((c, i) => <tr key={i}><td>{c.name || '—'}</td><td>{c.phone}</td><td style={{ textAlign: 'right', color: 'var(--color-danger)', fontWeight: 600 }}>{c.returns}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderEmployeeAnalytics = () => {
    if (!data) return null;
    const names = data.employee_names || [];
    return (
      <>
        <div className="charts-grid">
          <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
            <h3>{t('reports.employee_performance')}</h3>
            <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.sales_by_employee || []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" stroke="var(--color-text-muted)" fontSize={12} />
                <YAxis dataKey="name" type="category" stroke="var(--color-text-muted)" fontSize={11} width={120} />
                <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                <Legend />
                <Bar name={t('reports.revenue')} dataKey="revenue" fill="#818cf8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer></div>
          </div>
          <div className="chart-card card">
            <h3>{t('reports.sales_count')}</h3>
            <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart><Pie data={data.sales_by_employee || []} dataKey="sales_count" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={3}>
                  {(data.sales_by_employee || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip contentStyle={tooltipStyle} /><Legend /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        {(data.employee_trend || []).length > 0 && (
          <div className="charts-grid">
            <div className="chart-card card" style={{ gridColumn: 'span 3' }}>
              <h3>{t('reports.employee_trend')}</h3>
              <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.employee_trend || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
                  <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                  <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle} />
                  <Legend />
                  {names.map((n, i) => <Line key={n} type="monotone" name={n} dataKey={n} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />)}
                </LineChart>
              </ResponsiveContainer></div>
            </div>
          </div>
        )}
        <div className="leaderboards-grid">
          <div className="leaderboard-card card">
            <div className="card-header"><h3>{t('reports.sales_per_employee')}</h3></div>
            <div className="table-container"><table className="table" style={{ fontSize: '0.9em' }}>
              <thead><tr><th>{t('reports.name')}</th><th style={{ textAlign: 'right' }}>{t('reports.sales_count')}</th><th style={{ textAlign: 'right' }}>{t('reports.revenue')}</th></tr></thead>
              <tbody>{(data.sales_by_employee || []).length === 0 ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('reports.no_data')}</td></tr> :
                (data.sales_by_employee || []).map((e, i) => <tr key={i}><td>{e.name}</td><td style={{ textAlign: 'right' }}>{e.sales_count}</td><td style={{ textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{fmt(e.revenue)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </div>
      </>
    );
  };

  const renderContent = {
    overview: renderOverview,
    sales_analytics: renderSalesAnalytics,
    products_analytics: renderProductAnalytics,
    inventory_analytics: renderInventoryAnalytics,
    financial: renderFinancial,
    customers_analytics: renderCustomerAnalytics,
    employees_analytics: renderEmployeeAnalytics,
  };

  return (
    <div className="dashboard-page">
      <div className="page-header" style={{ flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 className="page-title">{t('reports.title')}</h1>
          <p className="page-subtitle">{t('reports.welcome_back')}, {user?.full_name || user?.username}.</p>
        </div>
        <div className="dashboard-ribbon card">
          {isAdmin && (
            <div className="ribbon-group">
              <label>{t('sales.store')}</label>
              <SearchableSelect
                options={[{ value: '', label: t('stores.all_stores') }, ...stores.map(s => ({ value: s.id, label: s.name }))]}
                value={filters.store_id}
                onChange={e => setFilters(p => ({ ...p, store_id: e.target.value }))}
              />
            </div>
          )}
          <div className="ribbon-group">
            <label>{t('reports.time_horizon')}</label>
            <select className="form-input" value={dateOption} onChange={e => setDateOption(e.target.value)}>
              <option value="Today">{t('reports.today')}</option>
              <option value="This Week">{t('reports.this_week')}</option>
              <option value="This Month">{t('reports.this_month')}</option>
              <option value="This Year">{t('reports.this_year')}</option>
              <option value="All Time">{t('reports.all_time')}</option>
              <option value="Custom">{t('reports.custom')}</option>
            </select>
          </div>
          {dateOption === 'Custom' && (
            <>
              <div className="ribbon-group"><label>{t('common.from')}</label><input type="date" className="form-input" value={customStart} onChange={e => setCustomStart(e.target.value)} /></div>
              <div className="ribbon-group"><label>{t('common.to')}</label><input type="date" className="form-input" value={customEnd} onChange={e => setCustomEnd(e.target.value)} /></div>
            </>
          )}
          <div className="ribbon-group">
            <label>{t('reports.top_x')}</label>
            <select className="form-input" value={limitOption} onChange={e => setLimitOption(Number(e.target.value))}>
              <option value={5}>Top 5</option>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
            </select>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(tab => (
          <button key={tab} className={`tab ${activeTab === tab ? 'tab--active' : ''}`} onClick={() => setActiveTab(tab)}>
            {t(`reports.${tab}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : (
        <div className="dashboard-content">
          {renderContent[activeTab]?.()}
        </div>
      )}
    </div>
  );
}
