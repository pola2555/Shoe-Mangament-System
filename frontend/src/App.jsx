import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
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
        <Route path="pos" element={<POSPage />} />
        <Route path="products" element={<ProductsListPage />} />
        <Route path="products/:id" element={<ProductDetailPage />} />
        <Route path="box-templates" element={<BoxTemplatesPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="purchases/:id" element={<PurchaseDetailPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="returns" element={<ReturnsPage />} />
        <Route path="suppliers" element={<SuppliersListPage />} />
        <Route path="suppliers/:id" element={<SupplierDetailPage />} />
        <Route path="dealers" element={<DealersPage />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="reports" element={<ComingSoonPage title="Reports" />} />
        <Route path="stores" element={<StoresPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="sales" element={<SalesPage />} />
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
              background: '#1a1d27',
              color: '#e8e8ef',
              border: '1px solid #2d3045',
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
