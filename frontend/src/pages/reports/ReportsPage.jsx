import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { reportsAPI, storesAPI, productCategoriesAPI } from '../../api';
import { money } from '../../utils/dates';
import { useTranslation } from '../../i18n/i18nContext';
import SearchableSelect from '../../components/common/SearchableSelect';
import { today, weekStart, monthRange, yearRange } from '../../utils/dates';
import { formatSize, localizedName } from '../../utils/variantFormat';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend
} from 'recharts';
import '../dashboard/Dashboard.css';

const COLORS = ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#ec4899', '#22d3ee', '#fb923c'];
const TABS = ['overview', 'stores', 'reorder', 'sales_analytics', 'products_analytics', 'inventory_analytics', 'financial', 'customers_analytics', 'employees_analytics'];

/**
 * How urgent a reorder row is, and what colour says so.
 *
 * Deliberately NOT sorted by stock level. Three pairs of a shoe that sells eight a week
 * is an emergency; three of one that sells one a month is fine. The ranking is days of
 * cover, and the badge names the state rather than showing a number that means nothing
 * on its own.
 */
const REORDER_BADGE = {
  out: 'badge-danger',
  critical: 'badge-danger',
  low: 'badge-warning',
  ok: 'badge-success',
  overstocked: 'badge-info',
  dead: 'badge-warning',
};

/**
 * A movement against the previous period.
 *
 * `invert` is for the figures where down is the good direction — expenses being the
 * obvious one. Without it a month where spending fell would be painted red, which is
 * exactly backwards and is the kind of thing a reader believes because it is coloured.
 *
 * A null change means the previous period was zero. That has no honest percentage:
 * "up 100%" from nothing is not a fact about the business, so nothing is drawn.
 */
function Delta({ value, invert = false }) {
  if (value === null || value === undefined) return null;
  const cls = value === 0 ? 'flat' : (invert ? value < 0 : value > 0) ? 'up' : 'down';
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '=';
  return <span className={`metric-delta metric-delta--${cls}`}>{arrow} {Math.abs(value)}%</span>;
}

// Only these two tabs count things that belong to a product, so only these two can be
// filtered by category. The financial tab deliberately cannot: a discount is recorded
// against the sale, not its lines, so "revenue for Socks" would be a number with no
// honest definition — better to withhold the filter than to answer wrongly.
const CATEGORY_TABS = ['products_analytics', 'inventory_analytics'];

export default function ReportsPage() {
  const { user, filterStores } = useAuth();
  const { t, locale } = useTranslation();
  const isAdmin = user?.role_name === 'admin' || user?.role_name === 'System Administrator';

  const [activeTab, setActiveTab] = useState('overview');
  const [stores, setStores] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  // The same headline figures for the period before this one. Fetched separately and
  // only for the overview, because it is the only tab that shows a direction — and a
  // tab that does not use it should not pay for it.
  const [comparison, setComparison] = useState(null);

  const [dateOption, setDateOption] = useState('This Month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [limitOption, setLimitOption] = useState(10);
  const [costBasis, setCostBasis] = useState(null);
  const [insights, setInsights] = useState(null);
  const [filters, setFilters] = useState({
    store_id: !isAdmin ? (user?.store_id || '') : '',
    startDate: '', endDate: '', limit: 10,
  });

  useEffect(() => {
    if (isAdmin) storesAPI.list().then(r => setStores(filterStores(r.data.data))).catch(() => {});
    productCategoriesAPI.list({ is_active: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
  }, [isAdmin]);

  // Leaving a category-aware tab drops the filter rather than carrying an invisible
  // one into a tab that cannot honour it.
  useEffect(() => {
    if (!CATEGORY_TABS.includes(activeTab)) setFilters(p => (p.category_id ? { ...p, category_id: '' } : p));
  }, [activeTab]);

  useEffect(() => {
    if (dateOption === 'Custom') return;
    let s = '', e = '';
    const now = new Date();
    // Built from local calendar fields. Going through toISOString() moved the 1st of
    // the month back to the previous month's last day in any timezone east of
    // Greenwich, so every "This Month" report began a day early.
    if (dateOption === 'Today') { s = e = today(); }
    else if (dateOption === 'This Week') { s = weekStart(now); e = today(); }
    else if (dateOption === 'This Month') { const r = monthRange(now); s = r.start; e = r.end; }
    else if (dateOption === 'This Year') { const r = yearRange(now); s = r.start; e = r.end; }
    // "All Time" leaves the dates empty, which the backend cannot tell apart from a
    // caller that simply omitted them (and would then default to a 90-day window).
    // The explicit flag says the omission is deliberate.
    const allTime = dateOption === 'All Time' ? '1' : undefined;
    setFilters(p => ({ ...p, startDate: s, endDate: e, all_time: allTime, limit: limitOption }));
  }, [dateOption, limitOption]);

  useEffect(() => {
    if (dateOption === 'Custom' && customStart && customEnd) setFilters(p => ({ ...p, startDate: customStart, endDate: customEnd, all_time: undefined, limit: limitOption }));
  }, [dateOption, customStart, customEnd, limitOption]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const api = {
        overview: () => reportsAPI.dashboard(filters),
        reorder: () => reportsAPI.reorder(filters),
        // Branch against branch. Served by the stores module, which owns the same
        // expressions the company reports use, so a store's revenue here and its
        // revenue on its own page are one number.
        //
        // store_id is stripped rather than passed: this tab's whole job is comparing
        // stores, and a comparison narrowed to one store is a single row. The picker
        // is hidden here too, so leaving it in would be an invisible filter — the
        // thing this page already avoids for the category filter.
        stores: () => storesAPI.comparison({ ...filters, store_id: undefined }),
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

  useEffect(() => {
    if (activeTab !== 'overview') { setComparison(null); return; }
    reportsAPI.comparison(filters)
      .then(r => setComparison(r.data.data))
      .catch(() => setComparison(null));
  }, [activeTab, filters]);

  // How much of this period's profit still rests on a guessed cost, and whether the
  // period has been restated since. One small call, shown on both screens that
  // headline a profit figure — a field threaded through nine report payloads is how
  // one of them ends up missing it.
  // The plain-language findings, on the overview only. They are composed from every
  // other report, so fetching them on each tab would run the whole set nine times.
  useEffect(() => {
    if (activeTab !== 'overview') { setInsights(null); return; }
    reportsAPI.insights(filters)
      .then(r => setInsights(r.data.data?.insights || []))
      .catch(() => setInsights(null));
  }, [activeTab, filters]);

  useEffect(() => {
    if (!['overview', 'financial'].includes(activeTab)) { setCostBasis(null); return; }
    reportsAPI.costBasis(filters)
      .then(r => setCostBasis(r.data.data))
      .catch(() => setCostBasis(null));
  }, [activeTab, filters]);

  /**
   * The note under a profit figure.
   *
   * Stock entered without an invoice carries a GUESSED cost until that product is
   * bought again for real. Until then any profit computed from it is provisional, and
   * saying so is what stops the owner being misled by their own system when the number
   * later moves. `restated_at` is the other half: a figure already read may have
   * changed because a real invoice arrived and corrected the guess behind it.
   */
  /**
   * What the numbers MEAN, in sentences, worst first.
   *
   * A dashboard shows figures; this says which of them should change what the owner
   * does today. Ranked by severity and then by the money attached, because "you are out
   * of the shoe that sells nine a week" matters more than a 6% dip in takings.
   */
  const renderInsights = () => {
    if (!insights || insights.length === 0) return null;
    return (
      <div className="insights" data-testid="insights">
        <h3>{t('reports.insights')}</h3>
        <div className="insight-list">
          {insights.map((i, n) => (
            <div key={n} className={`insight insight--${i.severity}`} data-testid={`insight-${i.key}`}>
              <div className="insight-title">{i.title}</div>
              {i.detail && <div className="insight-detail">{i.detail}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCostBasis = () => {
    if (!costBasis) return null;
    const { estimated_items: est, total_items: total, estimated_share_pct: pct,
            restated_items: restated, restated_at: at } = costBasis;
    if (!est && !restated) return null;
    return (
      <div className="cost-basis-note" data-testid="cost-basis-note">
        {est > 0 && (
          <div>{t('reports.cost_basis_estimated', { items: est, total, pct: pct ?? 0 })}</div>
        )}
        {restated > 0 && at && (
          <div data-testid="restated-note">
            {t('reports.cost_basis_restated', { date: String(at).slice(0, 10), items: restated })}
          </div>
        )}
      </div>
    );
  };

  const fmt = (v) => v != null ? parseFloat(v).toLocaleString() : '—';

  /**
   * Size buckets, written the way the rest of the app writes a size.
   *
   * The rows carry their size list's prefix and suffix, so this is the same
   * formatSize every label, receipt and inventory row goes through — not a second
   * copy of the rule. A one-size product has no size worth showing, so it gets the
   * category's own wording instead of an empty axis label.
   */
  const sizeChartData = (rows) => (rows || []).map(r => ({
    ...r,
    label: formatSize(r, locale) || t('categories.one_size_short'),
  }));
  const tooltipStyle = { backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 8 };
  const itemStyle = { color: 'var(--color-text-primary)' };
  const DOW_LABELS = [t('reports.sun'), t('reports.mon'), t('reports.tue'), t('reports.wed'), t('reports.thu'), t('reports.fri'), t('reports.sat')];

  /**
   * The overview in words, before it is in charts.
   *
   * Somebody opening this page wants to know whether the month is going well. That is
   * a sentence, not nine cards — so the cards stay, and these say what they add up to.
   * Every line is derived from figures already on screen; nothing here is a separate
   * query, and nothing here is shown unless the data behind it exists.
   */
  const renderHighlights = (m, ch, lb) => {
    const lines = [];
    const cur = t('common.currency');

    if (comparison?.comparable && comparison.change?.revenue !== null && comparison.change?.revenue !== undefined) {
      const d = comparison.change.revenue;
      lines.push({
        tone: d >= 0 ? 'good' : 'bad',
        icon: d >= 0 ? '📈' : '📉',
        text: t(d >= 0 ? 'reports.hl_revenue_up' : 'reports.hl_revenue_down', {
          pct: Math.abs(d),
          prev: money(comparison.previous.revenue, cur),
        }),
      });
    }

    const trend = ch?.trend || [];
    if (trend.length > 1) {
      const best = trend.reduce((a, b) => (Number(b.revenue) > Number(a.revenue) ? b : a));
      if (Number(best.revenue) > 0) {
        lines.push({ tone: 'good', icon: '🗓️', text: t('reports.hl_best_day', { date: best.date, amount: money(best.revenue, cur) }) });
      }
    }

    const top = (lb?.top_products || [])[0];
    if (top) {
      lines.push({ tone: 'neutral', icon: '🏆', text: t('reports.hl_top_product', { name: top.name || top.product, qty: top.qty, amount: money(top.revenue, cur) }) });
    }

    // Expenses as a share of what came in. A ratio is the one expense figure that
    // means the same thing in a good month and a bad one.
    if (m.net_sales > 0) {
      const ratio = Math.round(((m.total_expenses || 0) / m.net_sales) * 1000) / 10;
      lines.push({
        tone: ratio > 40 ? 'warn' : 'neutral',
        icon: '🧾',
        text: t('reports.hl_expense_ratio', { pct: ratio, amount: money(m.total_expenses, cur) }),
      });
    }

    const low = (lb?.low_stock || []).length;
    if (low > 0) lines.push({ tone: 'warn', icon: '📦', text: t('reports.hl_low_stock', { n: low }) });

    if ((m.total_loans_outstanding || 0) > 0) {
      lines.push({ tone: 'warn', icon: '💳', text: t('reports.hl_loans', { amount: money(m.total_loans_outstanding, cur) }) });
    }

    if (!lines.length) return null;
    return (
      <div className="highlights" data-testid="report-highlights">
        {lines.map((l, i) => (
          <div key={i} className={`highlight highlight--${l.tone}`}>
            <span className="highlight__icon" aria-hidden="true">{l.icon}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    );
  };

  // ─── RENDER TAB CONTENT ───
  const renderOverview = () => {
    const m = data?.metrics || {};
    const ch = data?.charts || {};
    const lb = data?.leaderboards || {};
    const cards = [
      { label: t('reports.net_sales'), value: `${fmt(m.net_sales)} ${t('common.currency')}`, sub: `${fmt(m.total_sales)} ${t('reports.orders')}`, color: 'var(--color-primary)', delta: 'revenue' },
      { label: t('reports.clear_profit'), value: `${fmt(m.clear_profit)} ${t('common.currency')}`, sub: `${m.net_margin_pct}% ${t('reports.net_margin')}`, color: 'var(--color-success)', delta: 'gross_profit' },
      { label: t('reports.avg_order_value'), value: `${fmt(m.aov)} ${t('common.currency')}`, sub: t('reports.per_sale'), color: '#6366f1', delta: 'aov' },
      { label: t('reports.items_moved'), value: `${fmt(m.items_sold)} ${t('reports.sold')}`, sub: `${fmt(m.items_returned)} ${t('reports.returned_items')}`, color: '#f59e0b', delta: 'items_sold' },
      // Spending less is the good direction, so this one's arrow is inverted.
      { label: t('reports.total_expenses'), value: `${fmt(m.total_expenses)} ${t('common.currency')}`, sub: t('reports.in_period'), color: 'var(--color-danger)', delta: 'expenses', invert: true },
      { label: t('reports.profit_minus_expenses'), value: `${fmt((m.clear_profit || 0) - (m.total_expenses || 0))} ${t('common.currency')}`, sub: t('reports.clear_profit_minus_expenses'), color: ((m.clear_profit || 0) - (m.total_expenses || 0)) >= 0 ? '#059669' : 'var(--color-danger)', delta: 'net' },
      { label: t('reports.total_money'), value: `${fmt((m.net_sales || 0) - (m.total_expenses || 0))} ${t('common.currency')}`, sub: t('reports.net_sales_minus_expenses'), color: ((m.net_sales || 0) - (m.total_expenses || 0)) >= 0 ? '#10b981' : 'var(--color-danger)' },
      { label: t('reports.net_after_loans'), value: `${fmt((m.net_sales || 0) - (m.total_expenses || 0) - (m.total_loans_outstanding || 0))} ${t('common.currency')}`, sub: `${t('reports.loans_outstanding')}: ${fmt(m.total_loans_outstanding)} ${t('common.currency')}`, color: ((m.net_sales || 0) - (m.total_expenses || 0) - (m.total_loans_outstanding || 0)) >= 0 ? '#0ea5e9' : 'var(--color-danger)' },
      { label: t('reports.inventory_value'), value: `${fmt(m.inventory_valuation)} ${t('common.currency')}`, sub: `${fmt(m.inventory_in_stock)} ${t('reports.units')}`, color: '#8b5cf6' },
    ];
    return (
      <>
        <p className="section-hint">{t('reports.overview_hint')}</p>
        {renderInsights()}
        {renderCostBasis()}
        {renderHighlights(m, ch, lb)}
        {comparison?.comparable && (
          <p className="section-hint" data-testid="compare-caption">
            {t('reports.compared_with', { from: comparison.previous.range.startDate, to: comparison.previous.range.endDate })}
          </p>
        )}
        <div className="metrics-grid">
          {cards.map((c, i) => (
            <div key={i} className="metric-card card">
              <h4>{c.label}</h4>
              <div className="metric-val" style={{ color: c.color }}>
                {c.value}
                {c.delta && comparison?.comparable && <Delta value={comparison.change?.[c.delta]} invert={c.invert} />}
              </div>
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

  /**
   * Branch against branch.
   *
   * The store filter at the top of this page answers "how is this branch doing". It
   * cannot answer "which branch is doing it", because to compare you have to pick one
   * at a time and remember the last number. This tab is that comparison, and it is the
   * one place on the page where the store filter is deliberately ignored — filtering a
   * comparison to a single store leaves one row and nothing to compare it with.
   */
  const renderStores = () => {
    if (!data) return null;
    const rows = data.stores || [];
    const totals = data.totals || {};
    const cur = t('common.currency');
    const best = rows.reduce((a, b) => (b.revenue > (a?.revenue ?? -Infinity) ? b : a), null);

    return (
      <>
        <p className="section-hint">{t('reports.stores_hint')}</p>
        {rows.length === 0 ? <div className="card">{t('reports.no_data')}</div> : (
          <>
            <div className="metrics-grid">
              <div className="metric-card card"><h4>{t('reports.net_sales')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-primary)' }}>{money(totals.revenue, cur)}</div>
                <div className="metric-sub">{totals.orders} {t('reports.orders')}</div></div>
              <div className="metric-card card"><h4>{t('reports.gross_profit')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-success)' }}>{money(totals.gross_profit, cur)}</div></div>
              <div className="metric-card card"><h4>{t('reports.total_expenses')}</h4>
                <div className="metric-val" style={{ color: 'var(--color-danger)' }}>{money(totals.expenses, cur)}</div></div>
              <div className="metric-card card"><h4>{t('stores.net')}</h4>
                <div className="metric-val" style={{ color: totals.net >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>{money(totals.net, cur)}</div>
                <div className="metric-sub">{t('stores.net_hint')}</div></div>
              <div className="metric-card card"><h4>{t('stores.stock_value')}</h4>
                <div className="metric-val" style={{ color: '#8b5cf6' }}>{money(totals.stock_value, cur)}</div>
                <div className="metric-sub">{totals.stock_units} {t('reports.units')}</div></div>
            </div>

            <div className="charts-grid">
              <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
                <h3>{t('reports.revenue_vs_profit')}</h3>
                <p className="section-hint">{t('reports.stores_chart_hint')}</p>
                <div className="chart-wrapper"><ResponsiveContainer width="100%" height={300}>
                  <BarChart data={rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="name" stroke="var(--color-text-muted)" fontSize={12} />
                    <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                    <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle}
                      formatter={v => `${fmt(v)} ${cur}`} />
                    <Legend />
                    <Bar name={t('reports.net_sales')} dataKey="revenue" fill="#818cf8" radius={[4, 4, 0, 0]} />
                    <Bar name={t('reports.profit')} dataKey="gross_profit" fill="#34d399" radius={[4, 4, 0, 0]} />
                    <Bar name={t('reports.expenses')} dataKey="expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer></div>
              </div>
              <div className="chart-card card">
                <h3>{t('reports.stock_by_store')}</h3>
                <p className="section-hint">{t('reports.stores_stock_hint')}</p>
                <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart><Pie data={rows} dataKey="stock_value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={3}>
                      {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie><RechartsTooltip formatter={v => `${fmt(v)} ${cur}`} contentStyle={tooltipStyle} /><Legend /></PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="leaderboard-card card">
              <div className="card-header">
                <h3>{t('reports.store_table')}</h3>
                {best && best.revenue > 0 && <span className="badge badge-success">{t('reports.best_store', { name: best.name })}</span>}
              </div>
              <div className="table-container">
                <table className="table" data-testid="store-comparison-table">
                  <thead><tr>
                    <th>{t('common.store')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.orders')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.net_sales')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.avg_order_value')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.items_net')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.gross_profit')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.net_margin')}</th>
                    <th style={{ textAlign: 'end' }}>{t('reports.expenses')}</th>
                    <th style={{ textAlign: 'end' }}>{t('stores.net')}</th>
                    <th style={{ textAlign: 'end' }}>{t('stores.stock_value')}</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.store_id} data-testid={`store-compare-${r.store_id}`}>
                        <td>
                          <Link to={`/stores/${r.store_id}`}><strong>{r.name}</strong></Link>
                          {r.is_warehouse && <span className="badge badge-neutral" style={{ marginInlineStart: 6 }}>{t('stores.warehouse')}</span>}
                          {!r.is_active && <span className="badge badge-danger" style={{ marginInlineStart: 6 }}>{t('stores.closed')}</span>}
                        </td>
                        <td style={{ textAlign: 'end' }}>{r.orders}</td>
                        <td style={{ textAlign: 'end', fontWeight: 600 }}>{money(r.revenue, cur)}</td>
                        <td style={{ textAlign: 'end' }}>{money(r.aov, cur)}</td>
                        <td style={{ textAlign: 'end' }}>{r.items_net}</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-success)' }}>{money(r.gross_profit, cur)}</td>
                        <td style={{ textAlign: 'end' }}>{r.margin_pct}%</td>
                        <td style={{ textAlign: 'end', color: 'var(--color-danger)' }}>{money(r.expenses, cur)}</td>
                        <td style={{ textAlign: 'end', fontWeight: 700, color: r.net >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>{money(r.net, cur)}</td>
                        <td style={{ textAlign: 'end' }}>{money(r.stock_value, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </>
    );
  };

  const renderSalesAnalytics = () => {
    if (!data) return null;
    const ds = data.discount_stats || {};
    return (
      <>
        <p className="section-hint">{t('reports.sales_hint')}</p>
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
        <p className="section-hint">{t('reports.products_hint')}</p>
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
              <BarChart data={sizeChartData(data.size_distribution)}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={12} />
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
        <p className="section-hint">{t('reports.inventory_hint')}</p>
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
              <BarChart data={sizeChartData(data.stock_by_size)}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={12} />
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
    // Shown without a currency: it is a ratio, and printing "EGP" after it would be
    // wrong. Hidden entirely when there was no revenue to be a share of.
    const expenseRatio = s.expense_ratio_pct;
    // Category names live in the database, not the translation files, so t() cannot
    // reach them — pick the language here.
    const expenseSlices = (data.expenses_by_category || []).map((r) => ({
      ...r,
      category: (locale === 'ar' && r.category_ar) ? r.category_ar : r.category,
    }));
    return (
      <>
        <p className="section-hint">{t('reports.financial_hint')}</p>
        {renderCostBasis()}
        <div className="metrics-grid">
          {cards.map((c, i) => (
            <div key={i} className="metric-card card">
              <h4>{c.label}</h4>
              <div className="metric-val" style={{ color: c.color }}>{c.value} {t('common.currency')}</div>
            </div>
          ))}
          {expenseRatio !== null && expenseRatio !== undefined && (
            <div className="metric-card card" data-testid="expense-ratio">
              <h4>{t('reports.expense_ratio')}</h4>
              <div className="metric-val" style={{ color: expenseRatio > 40 ? 'var(--color-danger)' : '#ec4899' }}>
                {expenseRatio}%
              </div>
            </div>
          )}
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
                <PieChart><Pie data={expenseSlices} dataKey="total" nameKey="category" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={3}>
                  {expenseSlices.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie><RechartsTooltip formatter={v => `${fmt(v)} ${t('common.currency')}`} contentStyle={tooltipStyle} /><Legend /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        {(data.expense_trend || []).length > 0 && (
          <div className="charts-grid">
            <div className="chart-card card" style={{ gridColumn: 'span 2' }}>
              <h3>{t('reports.expense_trend')}</h3>
              <div className="chart-wrapper"><ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.expense_trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="month" stroke="var(--color-text-muted)" fontSize={12} />
                  <YAxis stroke="var(--color-text-muted)" fontSize={12} />
                  <RechartsTooltip contentStyle={tooltipStyle} itemStyle={itemStyle}
                    formatter={v => `${fmt(v)} ${t('common.currency')}`} />
                  <Bar name={t('reports.expenses')} dataKey="total" fill="#ec4899" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer></div>
            </div>
          </div>
        )}
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
        <p className="section-hint">{t('reports.customers_hint')}</p>
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
        <p className="section-hint">{t('reports.employees_hint')}</p>
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

  /**
   * What to buy, what is dying on the shelf, and what there is too much of.
   *
   * Ranked by DAYS OF COVER, not by how many are left — the number that turns "three
   * pairs" into either an emergency or a non-event. A product with no sales at all has
   * no cover figure, so it appears under Not selling rather than at the top of the
   * shopping list, which is where a bare low-stock sort would put a shop's worst stock.
   */
  const renderReorder = () => {
    const d = data || {};
    const s = d.summary || {};
    const table = (rows, cols) => (
      <div className="table-container">
        <table className="table">
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols.length} className="section-hint">{t('reorder.nothing_here')}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.product_id} data-testid={`reorder-row-${r.product_id}`}>
                <td>
                  <strong>{r.product_code}</strong>
                  <div className="count-sub">{[r.brand, r.product_name].filter(Boolean).join(' ')}</div>
                </td>
                <td>{r.on_hand}</td>
                <td>{r.weekly_rate}</td>
                <td>{r.days_cover === null ? '—' : `${r.days_cover} ${t('reorder.days')}`}</td>
                <td><strong>{r.suggested_qty > 0 ? r.suggested_qty : '—'}</strong></td>
                <td>{fmt(r.stock_value)} {t('common.currency')}</td>
                <td>
                  <span className={`badge ${REORDER_BADGE[r.status] || ''}`}>{t(`reorder.status_${r.status}`)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    const cols = [t('common.product'), t('reorder.on_hand'), t('reorder.per_week'),
      t('reorder.cover'), t('reorder.buy'), t('common.value'), t('common.status')];

    return (
      <>
        <p className="section-hint">{t('reorder.hint', { window: d.window_days, target: d.target_days })}</p>
        <div className="metrics-grid">
          {[
            { label: t('reorder.out'), value: s.out, color: '#ef4444' },
            { label: t('reorder.critical'), value: s.critical, color: '#f97316' },
            { label: t('reorder.low'), value: s.low, color: '#eab308' },
            { label: t('reorder.to_buy'), value: s.suggested_units, sub: `${fmt(s.suggested_cost)} ${t('common.currency')}`, color: '#3b82f6' },
            { label: t('reorder.not_selling'), value: s.dead, sub: `${fmt(s.dead_value)} ${t('common.currency')}`, color: '#8b5cf6' },
          ].map((c, i) => (
            <div key={i} className="metric-card card">
              <h4>{c.label}</h4>
              <div className="metric-val" style={{ color: c.color }}>{c.value ?? 0}</div>
              {c.sub && <div className="metric-sub">{c.sub}</div>}
            </div>
          ))}
        </div>

        <div className="chart-card card">
          <h3>{t('reorder.buy_these')}</h3>
          <p className="section-hint">{t('reorder.buy_hint')}</p>
          {table(d.buy || [], cols)}
        </div>

        <div className="chart-card card">
          <h3>{t('reorder.not_selling')}</h3>
          <p className="section-hint">{t('reorder.dead_hint', { days: d.dead_after_days })}</p>
          {table(d.dead || [], cols)}
        </div>

        {(d.overstocked || []).length > 0 && (
          <div className="chart-card card">
            <h3>{t('reorder.too_much')}</h3>
            <p className="section-hint">{t('reorder.overstock_hint')}</p>
            {table(d.overstocked, cols)}
          </div>
        )}
      </>
    );
  };

  const renderContent = {
    overview: renderOverview,
    stores: renderStores,
    reorder: renderReorder,
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
          {isAdmin && activeTab !== 'stores' && (
            <div className="ribbon-group">
              <label>{t('sales.store')}</label>
              <SearchableSelect
                options={[{ value: '', label: t('stores.all_stores') }, ...stores.map(s => ({ value: s.id, label: s.name }))]}
                value={filters.store_id}
                onChange={e => setFilters(p => ({ ...p, store_id: e.target.value }))}
              />
            </div>
          )}
          {CATEGORY_TABS.includes(activeTab) && categories.length > 0 && (
            <div className="ribbon-group">
              <label>{t('products.category')}</label>
              <SearchableSelect
                options={[{ value: '', label: t('common.all') },
                  ...categories.map(c => ({ value: c.id, label: localizedName(c, locale) }))]}
                value={filters.category_id || ''}
                onChange={e => setFilters(p => ({ ...p, category_id: e.target.value }))}
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
          <button key={tab} data-testid={`reports-tab-${tab}`}
            className={`tab ${activeTab === tab ? 'tab--active' : ''}`} onClick={() => setActiveTab(tab)}>
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
