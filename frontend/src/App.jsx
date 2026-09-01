import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { auditLogAPI } from './api';
import MainLayout from './components/layout/MainLayout';
import RouteErrorBoundary from './components/common/RouteErrorBoundary';

// Eager: the two entry points every session hits immediately.
import LoginPage from './pages/auth/LoginPage';
import DashboardPage from './pages/dashboard/DashboardPage';

// Everything else is split into its own chunk and fetched on first navigation.
// The app previously shipped as one 1.47 MB bundle, so every user downloaded the
// reports charting library and every page they never opened before seeing anything.
const ProductsListPage = lazy(() => import('./pages/products/ProductsListPage'));
const ProductDetailPage = lazy(() => import('./pages/products/ProductDetailPage'));
const SuppliersListPage = lazy(() => import('./pages/suppliers/SuppliersListPage'));
const PurchasesPage = lazy(() => import('./pages/purchases/PurchasesPage'));
const PurchaseDetailPage = lazy(() => import('./pages/purchases/PurchaseDetailPage'));
const InventoryPage = lazy(() => import('./pages/inventory/InventoryPage'));
const POSPage = lazy(() => import('./pages/pos/POSPage'));
const TransfersPage = lazy(() => import('./pages/transfers/TransfersPage'));
const SalesPage = lazy(() => import('./pages/sales/SalesPage'));
const DealersPage = lazy(() => import('./pages/dealers/DealersPage'));
const ExpensesPage = lazy(() => import('./pages/expenses/ExpensesPage'));
const CustomersPage = lazy(() => import('./pages/customers/CustomersPage'));
const ReturnsPage = lazy(() => import('./pages/returns/ReturnsPage'));
const StoresPage = lazy(() => import('./pages/stores/StoresPage'));
const UsersPage = lazy(() => import('./pages/users/UsersPage'));
const SupplierDetailPage = lazy(() => import('./pages/suppliers/SupplierDetailPage'));
const BoxTemplatesPage = lazy(() => import('./pages/box-templates/BoxTemplatesPage'));
const CatalogSetupPage = lazy(() => import('./pages/catalog/CatalogSetupPage'));
const ActivityLogPage = lazy(() => import('./pages/activity-log/ActivityLogPage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const LoansPage = lazy(() => import('./pages/loans/LoansPage'));

/**
 * Protected route wrapper.
 * Redirects to /login if not authenticated.
 */
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

/**
 * Guest route wrapper.
 * Redirects to / if already authenticated.
 */
function GuestRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return children;
}

/**
 * Placeholder page for routes not yet implemented.
 */
function ComingSoonPage({ title }) {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
      </div>
      <div className="card">
        <p style={{ color: 'var(--color-text-secondary)' }}>
          This page will be implemented in a future phase.
        </p>
      </div>
    </div>
  );
}

/**
 * Permission-gated route wrapper.
 * Redirects to dashboard and logs the attempt if user lacks the required permission.
 */
function PermissionRoute({ perm, children }) {
  const { hasPermission, user } = useAuth();
  if (!perm || hasPermission(perm, 'read')) return children;
  // Log unauthorized access attempt (fire-and-forget)
  auditLogAPI.log({
    action: 'unauthorized_access',
    module: 'auth',
    details: { attempted_page: window.location.pathname, required_permission: perm, username: user?.username },
  }).catch(() => {});
  return <Navigate to="/" replace />;
}

function AppRoutes() {
  const location = useLocation();
  return (
    // Suspense handles the loading state for the lazy route chunks above; the error
    // boundary handles the failure case, which Suspense does not cover — a chunk that
    // 404s after a deploy would otherwise unmount the app to a blank page.
    //
    // Keyed on pathname so navigating away remounts it: without the key one page's
    // render error would latch and blank the whole app until a manual reload.
    <RouteErrorBoundary key={location.pathname}>
    <Suspense fallback={<div className="loading-screen"><div className="spinner" /></div>}>
    <Routes>
      {/* Public */}
      <Route path="/login" element={
        <GuestRoute><LoginPage /></GuestRoute>
      } />

      {/* Protected — Main layout with sidebar */}
      <Route element={
        <ProtectedRoute><MainLayout /></ProtectedRoute>
      }>
        <Route index element={<DashboardPage />} />
        <Route path="pos" element={<PermissionRoute perm="pos"><POSPage /></PermissionRoute>} />
        <Route path="products" element={<PermissionRoute perm="products"><ProductsListPage /></PermissionRoute>} />
        <Route path="products/:id" element={<PermissionRoute perm="products"><ProductDetailPage /></PermissionRoute>} />
        <Route path="box-templates" element={<PermissionRoute perm="box_templates"><BoxTemplatesPage /></PermissionRoute>} />
        <Route path="catalog-setup" element={<PermissionRoute perm="products"><CatalogSetupPage /></PermissionRoute>} />
        <Route path="inventory" element={<PermissionRoute perm="inventory"><InventoryPage /></PermissionRoute>} />
        <Route path="purchases" element={<PermissionRoute perm="purchases"><PurchasesPage /></PermissionRoute>} />
        <Route path="purchases/:id" element={<PermissionRoute perm="purchases"><PurchaseDetailPage /></PermissionRoute>} />
        <Route path="transfers" element={<PermissionRoute perm="transfers"><TransfersPage /></PermissionRoute>} />
        <Route path="customers" element={<PermissionRoute perm="customers"><CustomersPage /></PermissionRoute>} />
        <Route path="returns" element={<PermissionRoute perm="customer_returns"><ReturnsPage /></PermissionRoute>} />
        <Route path="suppliers" element={<PermissionRoute perm="suppliers"><SuppliersListPage /></PermissionRoute>} />
        <Route path="suppliers/:id" element={<PermissionRoute perm="suppliers"><SupplierDetailPage /></PermissionRoute>} />
        <Route path="dealers" element={<PermissionRoute perm="dealers"><DealersPage /></PermissionRoute>} />
        <Route path="expenses" element={<PermissionRoute perm="expenses"><ExpensesPage /></PermissionRoute>} />
        <Route path="loans" element={<PermissionRoute perm="loans"><LoansPage /></PermissionRoute>} />
        <Route path="reports" element={<PermissionRoute perm="reports"><ReportsPage /></PermissionRoute>} />
        <Route path="stores" element={<PermissionRoute perm="stores"><StoresPage /></PermissionRoute>} />
        <Route path="users" element={<PermissionRoute perm="users"><UsersPage /></PermissionRoute>} />
        <Route path="sales" element={<PermissionRoute perm="sales"><SalesPage /></PermissionRoute>} />
        <Route path="activity-log" element={<PermissionRoute perm="audit_log"><ActivityLogPage /></PermissionRoute>} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </RouteErrorBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              borderRadius: '10px',
              fontSize: '14px',
              fontFamily: 'Inter, sans-serif',
            },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  );
}
