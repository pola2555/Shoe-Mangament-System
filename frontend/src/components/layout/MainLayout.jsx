import { useState, useEffect, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { HiOutlineBars3, HiOutlineXMark } from 'react-icons/hi2';
import Sidebar from './Sidebar';
import RouteErrorBoundary from '../common/RouteErrorBoundary';
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
        <span className="mobile-header__logo">
          <img src="/logo.png?v=bavly" alt="" className="mobile-header__logo-img" />
          <span className="mobile-header__logo-text">Bavly Shoes</span>
        </span>
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
        {/*
          THE PAGE SUSPENDS AND FAILS IN HERE, NOT AROUND THE WHOLE APP.
          Both of these used to wrap everything from App.jsx, which meant the sidebar
          was torn down and rebuilt on every navigation (the boundary was keyed on the
          pathname) and again whenever a code-split page was first visited (Suspense
          swapped the entire app for a spinner). A rebuilt menu is a menu scrolled back
          to the top, which is what made a long sidebar jump on every click.

          Keyed on the pathname so a page that throws clears when you navigate away
          instead of latching — the reason the key existed in the first place. It is
          safe here: this boundary no longer has the chrome inside it.
        */}
        <RouteErrorBoundary key={location.pathname}>
          <Suspense fallback={<div className="loading-screen"><div className="spinner" /></div>}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
