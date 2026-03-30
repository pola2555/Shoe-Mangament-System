import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
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
      { path: '/pos', icon: HiOutlineShoppingBag, labelKey: 'sidebar.pos', perm: 'pos' },
      { path: '/sales', icon: HiOutlineDocumentText, labelKey: 'sidebar.sales_history', perm: 'sales' },
      { path: '/returns', icon: HiOutlineTruck, labelKey: 'sidebar.returns', perm: 'customer_returns' },
      { path: '/customers', icon: HiOutlineUserGroup, labelKey: 'sidebar.customers', perm: 'customers' },
    ]
  },
  {
    titleKey: 'sidebar.products_inventory',
    items: [
      { path: '/products', icon: HiOutlineCube, labelKey: 'sidebar.products', perm: 'products' },
      { path: '/box-templates', icon: HiOutlineCube, labelKey: 'sidebar.box_templates', perm: 'box_templates' },
      { path: '/inventory', icon: HiOutlineClipboardDocumentList, labelKey: 'sidebar.inventory', perm: 'inventory' },
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

export default function Sidebar({ mobileOpen }) {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout, hasPermission } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

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
            (item) => !item.perm || hasPermission(item.perm, 'read')
          );
          
          if (visibleGroupItems.length === 0) return null;

          return (
            <div key={groupIndex} className="sidebar__group">
              {!collapsed && (
                <div className="sidebar__group-title">
                  {t(group.titleKey)}
                </div>
              )}
              {visibleGroupItems.map((item) => (
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
