import { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import {
  HiOutlineHome,
  HiOutlineShoppingBag,
  HiOutlineCube,
  HiOutlineClipboardDocumentList,
  HiOutlineTruck,
  HiOutlineDocumentText,
  HiOutlineArrowsRightLeft,
  HiOutlineUsers,
  HiOutlineUserGroup,
  HiOutlineBanknotes,
  HiOutlineChartBarSquare,
  HiOutlineBuildingStorefront,
  HiOutlineArrowRightOnRectangle,
  HiOutlineBars3,
  HiOutlineUserCircle,
  HiOutlineCog6Tooth,
  HiOutlineChevronDown,
} from 'react-icons/hi2';
import NotificationsPanel from './NotificationsPanel';
import './Sidebar.css';

const navGroups = [
  {
    titleKey: 'sidebar.overview',
    items: [
      { path: '/', icon: HiOutlineHome, labelKey: 'sidebar.dashboard' },
    ]
  },
  {
    titleKey: 'sidebar.sales_returns',
    items: [
      // Ordered the way a day runs, not alphabetically: open the till, sell, deal with
      // what comes back, then the people. Discount requests sit last because they are
      // answered between other things rather than worked through.
      { path: '/pos', icon: HiOutlineShoppingBag, labelKey: 'sidebar.pos', perm: 'pos' },
      { path: '/shifts', icon: HiOutlineBanknotes, labelKey: 'sidebar.shifts', perm: 'shifts' },
      { path: '/sales', icon: HiOutlineDocumentText, labelKey: 'sidebar.sales_history', perm: 'sales' },
      { path: '/returns', icon: HiOutlineTruck, labelKey: 'sidebar.returns', perm: 'customer_returns' },
      { path: '/exchanges', icon: HiOutlineArrowsRightLeft, labelKey: 'sidebar.exchanges', perm: 'exchanges' },
      { path: '/customers', icon: HiOutlineUserGroup, labelKey: 'sidebar.customers', perm: 'customers' },
      { path: '/approvals', icon: HiOutlineDocumentText, labelKey: 'sidebar.approvals', perm: 'pos' },
    ]
  },
  {
    titleKey: 'sidebar.products_inventory',
    items: [
      { path: '/products', icon: HiOutlineCube, labelKey: 'sidebar.products', perm: 'products' },
      { path: '/box-templates', icon: HiOutlineCube, labelKey: 'sidebar.box_templates', perm: 'box_templates' },
      { path: '/catalog-setup', icon: HiOutlineCube, labelKey: 'sidebar.catalog_setup', perm: 'products' },
      { path: '/inventory', icon: HiOutlineClipboardDocumentList, labelKey: 'sidebar.inventory', perm: 'inventory' },
      { path: '/stock-intakes', icon: HiOutlineClipboardDocumentList, labelKey: 'sidebar.stock_intakes', perm: 'inventory' },
      { path: '/stock-counts', icon: HiOutlineClipboardDocumentList, labelKey: 'sidebar.stock_counts', perm: 'inventory' },
      { path: '/transfers', icon: HiOutlineArrowsRightLeft, labelKey: 'sidebar.transfers', perm: 'transfers' },
    ]
  },
  {
    titleKey: 'sidebar.purchases_finance',
    items: [
      { path: '/purchases', icon: HiOutlineDocumentText, labelKey: 'sidebar.purchases', perm: 'purchases' },
      { path: '/suppliers', icon: HiOutlineTruck, labelKey: 'sidebar.suppliers', perm: 'suppliers' },
      { path: '/dealers', icon: HiOutlineUsers, labelKey: 'sidebar.dealers', perm: 'dealers' },
      { path: '/expenses', icon: HiOutlineBanknotes, labelKey: 'sidebar.expenses', perm: 'expenses' },
      { path: '/loans', icon: HiOutlineBanknotes, labelKey: 'sidebar.loans', perm: 'loans' },
    ]
  },
  {
    titleKey: 'sidebar.management',
    items: [
      { path: '/reports', icon: HiOutlineChartBarSquare, labelKey: 'sidebar.reports', perm: 'reports' },
      { path: '/stores', icon: HiOutlineBuildingStorefront, labelKey: 'sidebar.stores', perm: 'stores' },
      { path: '/users', icon: HiOutlineUsers, labelKey: 'sidebar.users', perm: 'users' },
      { path: '/activity-log', icon: HiOutlineClipboardDocumentList, labelKey: 'sidebar.activity_log', perm: 'audit_log' },
    ]
  }
];

const COLLAPSED_GROUPS_KEY = 'sidebar_collapsed_groups';

export default function Sidebar({ mobileOpen }) {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout, hasPermission, isPageHidden } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // Which groups the user has folded away, remembered between sessions. Stored as the
  // collapsed set rather than the open one, so a group added later starts open instead
  // of hidden.
  const [closedGroups, setClosedGroups] = useState(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });

  const toggleGroup = (titleKey) => {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(titleKey)) next.delete(titleKey); else next.add(titleKey);
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  };

  /**
   * The group holding the current page always opens.
   *
   * A collapsed sidebar must never hide where you already are — otherwise the active
   * link is invisible and the app looks like it has lost the page.
   */
  useEffect(() => {
    const owning = navGroups.find((g) => g.items.some((i) =>
      i.path === '/' ? location.pathname === '/' : location.pathname.startsWith(i.path)
    ));
    if (!owning) return;
    setClosedGroups((prev) => {
      if (!prev.has(owning.titleKey)) return prev;
      const next = new Set(prev);
      next.delete(owning.titleKey);
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${mobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar__header">
        <div className="sidebar__logo">
          {!collapsed && <span className="sidebar__logo-text">Shoe ERP</span>}
          <button className="sidebar__toggle" onClick={() => setCollapsed(!collapsed)}>
            <HiOutlineBars3 size={20} />
          </button>
        </div>
      </div>

      <nav className="sidebar__nav">
        {navGroups.map((group, groupIndex) => {
          const visibleGroupItems = group.items.filter(
            // Two different reasons a link is absent: the person may not use the page
            // (permission), or has been told not to be shown it (hidden_pages).
            (item) => (!item.perm || hasPermission(item.perm, 'read')) && !isPageHidden(item.path)
          );
          
          if (visibleGroupItems.length === 0) return null;

          // With the whole sidebar collapsed to icons there are no headings to fold,
          // so every group stays open — otherwise links would vanish with nothing to
          // click to bring them back.
          const isOpen = collapsed || !closedGroups.has(group.titleKey);

          return (
            <div key={groupIndex} className="sidebar__group">
              {!collapsed && (
                <button
                  type="button"
                  className={`sidebar__group-title sidebar__group-title--toggle ${isOpen ? '' : 'is-closed'}`}
                  data-testid={`sidebar-group-${group.titleKey}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleGroup(group.titleKey)}
                >
                  <span>{t(group.titleKey)}</span>
                  <HiOutlineChevronDown size={14} className="sidebar__group-chevron" />
                </button>
              )}
              {isOpen && visibleGroupItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
                  }
                  end={item.path === '/'}
                  title={collapsed ? t(item.labelKey) : undefined}
                >
                  <item.icon size={20} />
                  {!collapsed && <span>{t(item.labelKey)}</span>}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <NotificationsPanel collapsed={collapsed} />

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
          }
          title={collapsed ? t('sidebar.settings') : undefined}
        >
          <HiOutlineCog6Tooth size={20} />
          {!collapsed && <span>{t('sidebar.settings')}</span>}
        </NavLink>
        
        <div className="sidebar__user" title={collapsed ? user?.full_name : undefined}>
          <HiOutlineUserCircle size={22} />
          {!collapsed && (
            <div className="sidebar__user-info">
              <span className="sidebar__user-name">{user?.full_name || user?.username}</span>
              <span className="sidebar__user-role">{user?.role_name}</span>
            </div>
          )}
        </div>
        <button className="sidebar__logout" onClick={handleLogout} title={t('sidebar.logout')}>
          <HiOutlineArrowRightOnRectangle size={20} />
          {!collapsed && <span>{t('sidebar.logout')}</span>}
        </button>
      </div>
    </aside>
  );
}
