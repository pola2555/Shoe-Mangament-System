import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { auditLogAPI } from './api';
import MainLayout from './components/layout/MainLayout';
import LoginPage from './pages/auth/LoginPage';
import DashboardPage from './pages/dashboard/DashboardPage';
import ProductsListPage from './pages/products/ProductsListPage';
import ProductDetailPage from './pages/products/ProductDetailPage';
import SuppliersListPage from './pages/suppliers/SuppliersListPage';
import PurchasesPage from './pages/purchases/PurchasesPage';
import PurchaseDetailPage from './pages/purchases/PurchaseDetailPage';
import InventoryPage from './pages/inventory/InventoryPage';
import POSPage from './pages/pos/POSPage';
import TransfersPage from './pages/transfers/TransfersPage';
import SalesPage from './pages/sales/SalesPage';
import DealersPage from './pages/dealers/DealersPage';
import ExpensesPage from './pages/expenses/ExpensesPage';
import CustomersPage from './pages/customers/CustomersPage';
import ReturnsPage from './pages/returns/ReturnsPage';
import StoresPage from './pages/stores/StoresPage';
import UsersPage from './pages/users/UsersPage';
import SupplierDetailPage from './pages/suppliers/SupplierDetailPage';
import BoxTemplatesPage from './pages/box-templates/BoxTemplatesPage';
import ActivityLogPage from './pages/activity-log/ActivityLogPage';
import SettingsPage from './pages/settings/SettingsPage';
import ReportsPage from './pages/reports/ReportsPage';

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
  return (
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
