import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { reportsAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import {
  HiOutlineShoppingCart, HiOutlineTruck, HiOutlineArrowsRightLeft,
  HiOutlineBanknotes, HiOutlineChartBar, HiOutlineClock,
  HiOutlineExclamationTriangle, HiOutlineDocumentText, HiOutlineCube
} from 'react-icons/hi2';
import './Dashboard.css';

export default function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAdminSection = hasPermission('dashboard_admin', 'read');
  const canViewReports = hasPermission('reports', 'read');

  const [snapshot, setSnapshot] = useState(null);
  const [adminData, setAdminData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const promises = [];
    if (canViewReports) promises.push(reportsAPI.dashboardHome());
    if (isAdminSection) promises.push(reportsAPI.dashboardAdmin());

    if (promises.length === 0) {
      setLoading(false);
      return;
    }

    Promise.all(promises)
      .then((results) => {
        if (!active) return;
        let idx = 0;
        if (canViewReports) setSnapshot(results[idx++]?.data?.data);
        if (isAdminSection) setAdminData(results[idx++]?.data?.data);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [isAdminSection]);

  const fmt = (v) => v != null ? parseFloat(v).toLocaleString() : '—';
  const fmtTime = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const fmtDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString();
  };

  const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const quickActions = [
    { label: t('dashboard.new_sale'), icon: HiOutlineShoppingCart, to: '/pos', color: 'var(--color-primary)' },
    { label: t('dashboard.new_purchase'), icon: HiOutlineTruck, to: '/purchases', color: 'var(--color-success)' },
    { label: t('dashboard.new_transfer'), icon: HiOutlineArrowsRightLeft, to: '/transfers', color: '#6366f1' },
    { label: t('dashboard.add_expense'), icon: HiOutlineBanknotes, to: '/expenses', color: '#f59e0b' },
    { label: t('dashboard.view_reports'), icon: HiOutlineChartBar, to: '/reports', color: '#8b5cf6' },
  ];

  const s = snapshot?.today || {};

  const snapshotCards = [
    { label: t('dashboard.sales_today'), value: s.sales_count, sub: t('dashboard.orders'), color: 'var(--color-primary)', icon: HiOutlineShoppingCart },
    { label: t('dashboard.revenue_today'), value: `${fmt(s.revenue)} ${t('common.currency')}`, color: 'var(--color-success)', icon: HiOutlineBanknotes },
    { label: t('dashboard.items_sold'), value: s.items_sold, color: '#6366f1', icon: HiOutlineCube },
    { label: t('dashboard.returns_today'), value: s.returns, color: 'var(--color-danger)', icon: HiOutlineArrowsRightLeft },
  ];

  return (
    <div className="dashboard-page">
      {/* Welcome Banner */}
      <div className="welcome-banner card">
        <div className="welcome-text">
          <h1>{t('dashboard.welcome_back')}, {user?.full_name || user?.username}!</h1>
          <p>{todayStr}</p>
        </div>
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : (
        <div className="dashboard-content">
          {/* Today's Snapshot */}
          <section>
            <h2 className="section-title">{t('dashboard.todays_snapshot')}</h2>
            <div className="snapshot-grid">
              {snapshotCards.map((c, i) => {
                const Icon = c.icon;
                return (
                  <div key={i} className="snapshot-card card">
                    <div className="snapshot-icon" style={{ backgroundColor: c.color + '18', color: c.color }}>
                      <Icon size={24} />
                    </div>
                    <div className="snapshot-info">
                      <span className="snapshot-label">{c.label}</span>
                      <span className="snapshot-value" style={{ color: c.color }}>
                        {c.value ?? 0}{c.sub ? <small> {c.sub}</small> : null}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Quick Actions */}
          <section>
            <h2 className="section-title">{t('dashboard.quick_actions')}</h2>
            <div className="quick-actions-grid">
              {quickActions.map((a, i) => {
                const Icon = a.icon;
                return (
                  <button key={i} className="quick-action-btn card" onClick={() => navigate(a.to)}>
                    <div className="qa-icon" style={{ backgroundColor: a.color + '18', color: a.color }}>
                      <Icon size={28} />
                    </div>
                    <span>{a.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Admin-only sections */}
          {isAdminSection && adminData && (
            <>
              {/* Pending Tasks */}
              <section>
                <h2 className="section-title">{t('dashboard.pending_tasks')}</h2>
                <div className="pending-grid">
                  <div className="pending-card card">
                    <div className="pending-icon" style={{ color: '#f59e0b' }}>
                      <HiOutlineArrowsRightLeft size={22} />
                    </div>
                    <div className="pending-info">
                      <span className="pending-count">{adminData.pending_transfers.length}</span>
                      <span className="pending-label">{t('dashboard.pending_transfers')}</span>
                    </div>
                  </div>
                  <div className="pending-card card">
                    <div className="pending-icon" style={{ color: 'var(--color-danger)' }}>
                      <HiOutlineDocumentText size={22} />
                    </div>
                    <div className="pending-info">
                      <span className="pending-count">{adminData.unpaid_invoices.length}</span>
                      <span className="pending-label">{t('dashboard.unpaid_invoices')}</span>
                    </div>
                  </div>
                  <div className="pending-card card">
                    <div className="pending-icon" style={{ color: '#ef4444' }}>
                      <HiOutlineExclamationTriangle size={22} />
                    </div>
                    <div className="pending-info">
                      <span className="pending-count">{adminData.low_stock_count}</span>
                      <span className="pending-label">{t('dashboard.low_stock_alerts')}</span>
                    </div>
                  </div>
                </div>

                {/* Pending details tables */}
                <div className="pending-details-grid">
                  {adminData.pending_transfers.length > 0 && (
                    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div className="card-header">
                        <h3>{t('dashboard.pending_transfers')}</h3>
                      </div>
                      <div className="table-container">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>{t('dashboard.transfer')}</th>
                              <th>{t('dashboard.from_to')}</th>
                              <th>{t('common.status')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminData.pending_transfers.map(tr => (
                              <tr key={tr.id}>
                                <td><strong>{tr.transfer_number}</strong></td>
                                <td>{tr.from_store} → {tr.to_store}</td>
                                <td><span className={`badge badge-${tr.status === 'pending' ? 'warning' : 'info'}`}>{tr.status}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {adminData.unpaid_invoices.length > 0 && (
                    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div className="card-header">
                        <h3>{t('dashboard.unpaid_invoices')}</h3>
                      </div>
                      <div className="table-container">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>{t('dashboard.invoice')}</th>
                              <th>{t('dashboard.supplier')}</th>
                              <th style={{ textAlign: 'right' }}>{t('dashboard.balance')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminData.unpaid_invoices.map(inv => (
                              <tr key={inv.id}>
                                <td><strong>{inv.invoice_number}</strong></td>
                                <td>{inv.supplier_name}</td>
                                <td style={{ textAlign: 'right', color: 'var(--color-danger)', fontWeight: 600 }}>
                                  {fmt(inv.balance)} {t('common.currency')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Recent Sales + Recent Activity side by side */}
              <div className="recent-grid">
                <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div className="card-header">
                    <h3><HiOutlineClock size={18} /> {t('dashboard.recent_sales')}</h3>
                  </div>
                  <div className="table-container">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('dashboard.sale_number')}</th>
                          <th>{t('dashboard.customer')}</th>
                          <th style={{ textAlign: 'right' }}>{t('dashboard.amount')}</th>
                          <th>{t('dashboard.time')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(adminData.recent_sales || []).length === 0 ? (
                          <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('common.no_data')}</td></tr>
                        ) : (adminData.recent_sales || []).map(s => (
                          <tr key={s.id}>
                            <td><strong>{s.sale_number}</strong></td>
                            <td>{s.customer_name || t('dashboard.walk_in')}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(s.final_amount)} {t('common.currency')}</td>
                            <td style={{ color: 'var(--color-text-muted)' }}>{fmtTime(s.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div className="card-header">
                    <h3><HiOutlineClock size={18} /> {t('dashboard.recent_activity')}</h3>
                  </div>
                  <div className="table-container">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('dashboard.user')}</th>
                          <th>{t('dashboard.action')}</th>
                          <th>{t('dashboard.module')}</th>
                          <th>{t('dashboard.time')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(adminData.recent_activity || []).length === 0 ? (
                          <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>{t('common.no_data')}</td></tr>
                        ) : (adminData.recent_activity || []).map(a => (
                          <tr key={a.id}>
                            <td><strong>{a.user_name}</strong></td>
                            <td><span className="badge badge-accent">{a.action}</span></td>
                            <td>{a.module}</td>
                            <td style={{ color: 'var(--color-text-muted)' }}>{fmtTime(a.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
