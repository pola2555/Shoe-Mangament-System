const bcrypt = require('bcryptjs');

/**
 * SEED: Initial data for the system.
 * Creates roles, permissions, expense categories, and a default admin user.
 * 
 * Default admin credentials:
 *   username: admin
 *   password: admin123 (CHANGE IN PRODUCTION!)
 */
exports.seed = async function (knex) {
  // ============================================================
  // 1. ROLES
  // ============================================================
  await knex('roles').del();
  await knex('roles').insert([
    { id: 1, name: 'admin', description: 'Full system access — manages all stores, users, and settings' },
    { id: 2, name: 'store_manager', description: 'Manages a single store — inventory, sales, expenses, staff' },
    { id: 3, name: 'employee', description: 'Store employee — POS, basic inventory viewing' },
  ]);

  // ============================================================
  // 2. PERMISSIONS (33 granular codes)
  // ============================================================
  await knex('permissions').del();
  await knex('permissions').insert([
    // Administration
    { code: 'users', description: 'User account management', category: 'administration' },
    { code: 'user_permissions', description: 'Permission assignment', category: 'administration' },
    { code: 'user_password_reset', description: 'Admin password resets', category: 'administration' },
    { code: 'stores', description: 'Store management', category: 'administration' },
    { code: 'all_stores', description: 'Cross-store data access', category: 'administration' },
    // Catalog
    { code: 'products', description: 'Core product info management', category: 'catalog' },
    { code: 'product_variants', description: 'Size/color variant management', category: 'catalog' },
    { code: 'product_images', description: 'Product image management', category: 'catalog' },
    { code: 'product_prices', description: 'Store price overrides', category: 'catalog' },
    { code: 'box_templates', description: 'Box template management', category: 'catalog' },
    // Operations
    { code: 'inventory', description: 'Inventory management', category: 'operations' },
    { code: 'transfers', description: 'Transfer creation and viewing', category: 'operations' },
    { code: 'transfer_actions', description: 'Ship, receive, cancel transfers', category: 'operations' },
    // Procurement
    { code: 'purchases', description: 'Purchase invoice management', category: 'procurement' },
    { code: 'purchase_boxes', description: 'Box management within invoices', category: 'procurement' },
    { code: 'purchase_images', description: 'Invoice document management', category: 'procurement' },
    { code: 'suppliers', description: 'Supplier management', category: 'procurement' },
    { code: 'supplier_payments', description: 'Supplier payment management', category: 'procurement' },
    // Sales
    { code: 'pos', description: 'Point of sale operations', category: 'sales' },
    { code: 'pos_store_access', description: 'Sell in assigned stores', category: 'sales' },
    { code: 'sales', description: 'Sales history viewing', category: 'sales' },
    { code: 'sale_payments', description: 'Sale payment management', category: 'sales' },
    { code: 'customers', description: 'Customer management', category: 'sales' },
    // Returns
    { code: 'customer_returns', description: 'Customer return processing', category: 'returns' },
    { code: 'supplier_returns', description: 'Supplier return processing', category: 'returns' },
    // Wholesale
    { code: 'dealers', description: 'Dealer management', category: 'wholesale' },
    { code: 'dealer_invoices', description: 'Dealer invoice management', category: 'wholesale' },
    { code: 'dealer_payments', description: 'Dealer payment management', category: 'wholesale' },
    // Finance
    { code: 'expenses', description: 'Expense tracking', category: 'finance' },
    { code: 'expense_categories', description: 'Expense category access', category: 'finance' },
    { code: 'reports', description: 'Reports and analytics', category: 'finance' },
    // Notifications
    { code: 'notifications', description: 'Notification management', category: 'notifications' },
    // Audit
    { code: 'audit_log', description: 'Activity history viewing', category: 'audit' },
    // Dashboard
    { code: 'dashboard_admin', description: 'Dashboard pending tasks, recent sales & activity', category: 'administration' },
  ]);

  // ============================================================
  // 3. EXPENSE CATEGORIES
  // ============================================================
  await knex('expense_categories').del();
  await knex('expense_categories').insert([
    { name: 'Rent' },
    { name: 'Salaries' },
    { name: 'Maintenance' },
    { name: 'Utilities' },
    { name: 'Supplies' },
    { name: 'Other' },
  ]);

  // ============================================================
  // 4. DEFAULT ADMIN USER
  // ============================================================
  await knex('user_permissions').del();
  await knex('users').del();

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const [adminUser] = await knex('users').insert({
    username: 'admin',
    email: 'admin@shoe-erp.com',
    password_hash: passwordHash,
    full_name: 'System Administrator',
    role_id: 1, // admin role
    store_id: null, // admin has access to all stores
    is_active: true,
  }).returning('id');

  // Grant all permissions at write level to admin
  const allPermissions = await knex('permissions').select('code');
  const adminPermissions = allPermissions.map((p) => ({
    user_id: adminUser.id,
    permission_code: p.code,
    access_level: 'write',
  }));
  await knex('user_permissions').insert(adminPermissions);
};
