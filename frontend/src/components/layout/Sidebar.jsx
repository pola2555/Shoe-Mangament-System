import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
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
} from 'react-icons/hi2';
import './Sidebar.css';

const navGroups = [
  {
    title: 'Overview',
    items: [
      { path: '/', icon: HiOutlineHome, label: 'Dashboard' },
    ]
  },
  {
    title: 'Sales & Returns',
    items: [
      { path: '/pos', icon: HiOutlineShoppingBag, label: 'POS', perm: 'sales' },
      { path: '/sales', icon: HiOutlineDocumentText, label: 'Sales History', perm: 'sales' },
      { path: '/returns', icon: HiOutlineTruck, label: 'Returns', perm: 'returns' },
      { path: '/customers', icon: HiOutlineUserGroup, label: 'Customers', perm: 'sales' },
    ]
  },
  {
    title: 'Products & Inventory',
    items: [
      { path: '/products', icon: HiOutlineCube, label: 'Products', perm: 'products' },
      { path: '/box-templates', icon: HiOutlineCube, label: 'Box Templates', perm: 'products' },
      { path: '/inventory', icon: HiOutlineClipboardDocumentList, label: 'Inventory', perm: 'inventory' },
      { path: '/transfers', icon: HiOutlineArrowsRightLeft, label: 'Transfers', perm: 'transfers' },
    ]
  },
  {
    title: 'Purchases & Finance',
    items: [
      { path: '/purchases', icon: HiOutlineDocumentText, label: 'Purchases', perm: 'purchases' },
      { path: '/suppliers', icon: HiOutlineTruck, label: 'Suppliers', perm: 'purchases' },
      { path: '/dealers', icon: HiOutlineUsers, label: 'Dealers', perm: 'dealers' },
      { path: '/expenses', icon: HiOutlineBanknotes, label: 'Expenses', perm: 'expenses' },
    ]
  },
  {
    title: 'Management',
    items: [
      { path: '/reports', icon: HiOutlineChartBarSquare, label: 'Reports', perm: 'reports' },
      { path: '/stores', icon: HiOutlineBuildingStorefront, label: 'Stores', perm: 'stores' },
      { path: '/users', icon: HiOutlineUsers, label: 'Users', perm: 'users' },
    ]
  }
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Group visibility calculations happen on render

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
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
                  {group.title}
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
                  title={collapsed ? item.label : undefined}
                >
                  <item.icon size={20} />
                  {!collapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__user" title={collapsed ? user?.full_name : undefined}>
          <HiOutlineUserCircle size={22} />
          {!collapsed && (
            <div className="sidebar__user-info">
              <span className="sidebar__user-name">{user?.full_name || user?.username}</span>
              <span className="sidebar__user-role">{user?.role_name}</span>
            </div>
          )}
        </div>
        <button className="sidebar__logout" onClick={handleLogout} title="Logout">
          <HiOutlineArrowRightOnRectangle size={20} />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
}
