import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { reportsAPI, storesAPI } from '../../api';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';
import SearchableSelect from '../../components/common/SearchableSelect';
import './Dashboard.css';

export default function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role_name === 'System Administrator';
  const [data, setData] = useState(null);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);

  const [dateOption, setDateOption] = useState('This Month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [limitOption, setLimitOption] = useState(5);
  
  const [filters, setFilters] = useState({
    store_id: !isAdmin ? (user?.store_id || '') : '',
    startDate: '',
    endDate: '',
    limit: 5
  });

  useEffect(() => {
    if (isAdmin) {
      storesAPI.list().then(res => setStores(res.data.data)).catch(() => {});
    }
  }, [isAdmin]);

  // Handle Date presets
  useEffect(() => {
    if (dateOption === 'Custom') return; // Handled separately
    let sDate = '', eDate = '';
    const now = new Date();
    
    if (dateOption === 'Today') {
      sDate = now.toISOString().split('T')[0];
      eDate = sDate;
    } else if (dateOption === 'This Week') {
      const current = new Date();
      const first = current.getDate() - current.getDay();
      sDate = new Date(current.setDate(first)).toISOString().split('T')[0];
      eDate = new Date().toISOString().split('T')[0];
    } else if (dateOption === 'This Month') {
      sDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      // End date could be end of month, or today. Let's do end of month.
      eDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (dateOption === 'This Year') {
      sDate = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
      eDate = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0];
    }
    
    setFilters(prev => ({ ...prev, startDate: sDate, endDate: eDate, limit: limitOption }));
  }, [dateOption, limitOption]);

  // Handle Custom Dates
  useEffect(() => {
    if (dateOption === 'Custom' && customStart && customEnd) {
      setFilters(prev => ({ ...prev, startDate: customStart, endDate: customEnd, limit: limitOption }));
    }
  }, [dateOption, customStart, customEnd, limitOption]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    reportsAPI.dashboard(filters).then(res => {
      if (active) setData(res.data.data);
    }).catch(console.error).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [filters]);

  const fmt = (v) => v != null ? parseFloat(v).toLocaleString() : '—';
  
  const m = data?.metrics || {};
  const ch = data?.charts || {};
  const lb = data?.leaderboards || {};

  const topMetricCards = [
    { label: 'Net Sales', value: `${fmt(m.net_sales)} EGP`, subtitle: `${fmt(m.total_sales)} orders`, color: 'var(--color-primary)' },
    { label: 'Clear Profit', value: `${fmt(m.clear_profit)} EGP`, subtitle: `${m.net_margin_pct}% net margin`, color: 'var(--color-success)' },
    { label: 'Avg Order Value', value: `${fmt(m.aov)} EGP`, subtitle: `Per sale`, color: '#6366f1' },
    { label: 'Items Moved', value: `${fmt(m.items_sold)} sold`, subtitle: `${fmt(m.items_returned)} returned`, color: '#f59e0b' },
    { label: 'Expenses', value: `${fmt(m.total_expenses)} EGP`, subtitle: `In period`, color: 'var(--color-danger)' },
    { label: 'Inventory Value', value: `${fmt(m.inventory_valuation)} EGP`, subtitle: `${fmt(m.inventory_in_stock)} units`, color: '#8b5cf6' }
  ];

  const COLORS = ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#ec4899'];

  return (
    <div className="dashboard-page">
      <div className="page-header" style={{ flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 className="page-title">Analytics Dashboard</h1>
          <p className="page-subtitle">Welcome back, {user?.full_name || user?.username}.</p>
        </div>
        
        <div className="dashboard-ribbon card">
          {isAdmin && (
            <div className="ribbon-group">
              <label>Store</label>
              <SearchableSelect
                options={[ {value: '', label: 'All Stores'}, ...stores.map(s => ({ value: s.id, label: s.name })) ]}
                value={filters.store_id}
                onChange={(e) => setFilters(p => ({ ...p, store_id: e.target.value }))}
              />
            </div>
          )}
          <div className="ribbon-group">
            <label>Time Horizon</label>
            <select className="form-input" value={dateOption} onChange={(e) => setDateOption(e.target.value)}>
              <option>Today</option>
              <option>This Week</option>
              <option>This Month</option>
              <option>This Year</option>
              <option>All Time</option>
              <option>Custom</option>
            </select>
          </div>
          {dateOption === 'Custom' && (
            <>
              <div className="ribbon-group">
                <label>From</label>
                <input type="date" className="form-input" value={customStart} onChange={e => setCustomStart(e.target.value)} />
              </div>
              <div className="ribbon-group">
                <label>To</label>
                <input type="date" className="form-input" value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
              </div>
            </>
          )}
          <div className="ribbon-group">
            <label>Top X</label>
            <select className="form-input" value={limitOption} onChange={(e) => setLimitOption(Number(e.target.value))}>
              <option value={5}>Top 5</option>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : (
        <div className="dashboard-content">
          {/* Top Metrics Row */}
          <div className="metrics-grid">
            {topMetricCards.map((c, i) => (
              <div key={i} className="metric-card card">
                <h4>{c.label}</h4>
                <div className="metric-val" style={{ color: c.color }}>{c.value}</div>
                <div className="metric-sub">{c.subtitle}</div>
              </div>
            ))}
          </div>

          {/* Charts Row */}
          <div className="charts-grid">
            <div className="chart-card card" style={{ gridColumn: isAdmin ? 'span 2' : 'span 3' }}>
              <h3>Revenue vs Profit Trend</h3>
              <div className="chart-wrapper">
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={ch.trend || []} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#34d399" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#34d399" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={12} tickMargin={10} />
                    <YAxis stroke="var(--color-text-muted)" fontSize={12} tickFormatter={(val) => `${val / 1000}k`} />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 8 }}
                      itemStyle={{ color: 'var(--color-text-primary)' }}
                    />
                    <Legend />
                    <Area type="monotone" name="Revenue (EGP)" dataKey="revenue" stroke="#818cf8" strokeWidth={3} fillOpacity={1} fill="url(#colorRev)" />
                    <Area type="monotone" name="Profit (EGP)" dataKey="profit" stroke="#34d399" strokeWidth={3} fillOpacity={1} fill="url(#colorProfit)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {isAdmin && (!filters.store_id) && (
              <div className="chart-card card">
                <h3>Store Performance</h3>
                <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={ch.store_performance || []} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={5}>
                        {(ch.store_performance || []).map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(val) => `${fmt(val)} EGP`} contentStyle={{ backgroundColor: 'var(--color-surface)', borderRadius: 8 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="chart-card card">
              <h3>Payment Methods</h3>
              <div className="chart-wrapper" style={{ display: 'flex', justifyContent: 'center' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={ch.payment_methods || []} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={(renderProps) => renderProps.name}>
                      {(ch.payment_methods || []).map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[Math.abs(COLORS.length - 1 - index)]} />
                      ))}
                    </Pie>
                    <RechartsTooltip formatter={(val) => `${fmt(val)} EGP`} contentStyle={{ backgroundColor: 'var(--color-surface)', borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Leaderboards Row */}
          <div className="leaderboards-grid">
            <div className="leaderboard-card card">
              <div className="card-header">
                <h3>Top {limitOption} Products</h3>
                <span className="badge badge-accent">By Revenue</span>
              </div>
              <div className="table-container" style={{ overflow: 'hidden' }}>
                <table className="table" style={{ fontSize: '0.9em' }}>
                  <thead><tr><th>Code</th><th>Product</th><th style={{textAlign:'right'}}>Qty</th><th style={{textAlign:'right'}}>Revenue</th></tr></thead>
                  <tbody>
                    {(lb.top_products || []).length === 0 ? <tr><td colSpan={4} style={{textAlign:'center', color:'var(--color-text-muted)'}}>No sales in this period</td></tr> : null}
                    {(lb.top_products || []).map((p, i) => (
                      <tr key={i}>
                        <td><strong>{p.product}</strong></td>
                        <td>{p.name}</td>
                        <td style={{textAlign:'right'}}>{p.qty}</td>
                        <td style={{textAlign:'right', color:'var(--color-success)', fontWeight:600}}>{fmt(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="leaderboard-card card">
              <div className="card-header">
                <h3>Low Stock Alerts</h3>
                <span className="badge badge-danger">Immediate Action</span>
              </div>
              <div className="table-container" style={{ overflow: 'hidden' }}>
                <table className="table" style={{ fontSize: '0.9em' }}>
                  <thead><tr><th>Code</th><th>Product</th><th style={{textAlign:'right'}}>In Stock</th></tr></thead>
                  <tbody>
                    {(lb.low_stock || []).length === 0 ? <tr><td colSpan={3} style={{textAlign:'center', color:'var(--color-text-muted)'}}>No low stock alerts</td></tr> : null}
                    {(lb.low_stock || []).map((p, i) => (
                      <tr key={i}>
                        <td><strong>{p.product}</strong></td>
                        <td>{p.name}</td>
                        <td style={{textAlign:'right', color:'var(--color-danger)', fontWeight:700}}>{p.stock}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
