import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { HiOutlineBars3, HiOutlineXMark } from 'react-icons/hi2';
import Sidebar from './Sidebar';
import './MainLayout.css';

export default function MainLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close drawer when navigating
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="layout">
      {/* Mobile hamburger header */}
      <div className="mobile-header">
        <span className="mobile-header__logo">Shoe ERP</span>
        <button
          className="mobile-header__btn"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? <HiOutlineXMark size={22} /> : <HiOutlineBars3 size={22} />}
        </button>
      </div>

      {/* Overlay backdrop (mobile only) */}
      <div
        className={`sidebar-overlay ${mobileOpen ? 'sidebar-overlay--visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      <Sidebar mobileOpen={mobileOpen} />
      <main className="layout__main">
        <Outlet />
      </main>
    </div>
  );
}
