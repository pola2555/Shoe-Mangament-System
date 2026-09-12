/**
 * THE SCREENS THIS APP HAS.
 *
 * Used by the "hide pages from this person" feature so a stored value is always a real
 * page. It mirrors the groups in frontend/src/components/layout/Sidebar.jsx, and
 * `npm run check:audit` asserts the two agree — a page in the sidebar but not here
 * could never be hidden, and one here but not in the sidebar would be an option that
 * does nothing.
 *
 * `perm` is the permission that already governs the page. It is recorded so the admin
 * screen can say "this person cannot see this anyway", which is the difference between
 * tidying a menu and believing you have locked something.
 */

const APP_PAGES = [
  { path: '/', key: 'dashboard', group: 'overview' },
  { path: '/pos', key: 'pos', group: 'sales_returns', perm: 'pos' },
  { path: '/shifts', key: 'shifts', group: 'sales_returns', perm: 'shifts' },
  { path: '/sales', key: 'sales_history', group: 'sales_returns', perm: 'sales' },
  { path: '/returns', key: 'returns', group: 'sales_returns', perm: 'customer_returns' },
  { path: '/exchanges', key: 'exchanges', group: 'sales_returns', perm: 'exchanges' },
  { path: '/customers', key: 'customers', group: 'sales_returns', perm: 'customers' },
  { path: '/approvals', key: 'approvals', group: 'sales_returns', perm: 'pos' },
  { path: '/products', key: 'products', group: 'products_inventory', perm: 'products' },
  { path: '/box-templates', key: 'box_templates', group: 'products_inventory', perm: 'box_templates' },
  { path: '/catalog-setup', key: 'catalog_setup', group: 'products_inventory', perm: 'products' },
  { path: '/inventory', key: 'inventory', group: 'products_inventory', perm: 'inventory' },
  { path: '/stock-intakes', key: 'stock_intakes', group: 'products_inventory', perm: 'inventory' },
  { path: '/stock-counts', key: 'stock_counts', group: 'products_inventory', perm: 'inventory' },
  { path: '/transfers', key: 'transfers', group: 'products_inventory', perm: 'transfers' },
  { path: '/purchases', key: 'purchases', group: 'purchases_finance', perm: 'purchases' },
  { path: '/suppliers', key: 'suppliers', group: 'purchases_finance', perm: 'suppliers' },
  { path: '/dealers', key: 'dealers', group: 'purchases_finance', perm: 'dealers' },
  { path: '/expenses', key: 'expenses', group: 'purchases_finance', perm: 'expenses' },
  { path: '/loans', key: 'loans', group: 'purchases_finance', perm: 'loans' },
  { path: '/reports', key: 'reports', group: 'management', perm: 'reports' },
  { path: '/stores', key: 'stores', group: 'management', perm: 'stores' },
  { path: '/users', key: 'users', group: 'management', perm: 'users' },
  { path: '/activity-log', key: 'activity_log', group: 'management', perm: 'audit_log' },
];

/**
 * Pages nobody may hide. Settings holds the language switch and the password change, so
 * hiding it would leave somebody unable to fix their own account, and the dashboard is
 * where a hidden page redirects TO — hiding it would make that redirect a loop.
 */
const UNHIDEABLE = new Set(['/', '/settings']);

module.exports = { APP_PAGES, UNHIDEABLE };
