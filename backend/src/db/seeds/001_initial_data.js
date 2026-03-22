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
  // 2. PERMISSIONS
  // ============================================================
  await knex('permissions').del();
  await knex('permissions').insert([
    { code: 'users', description: 'User management', category: 'administration' },
    { code: 'stores', description: 'Store management', category: 'administration' },
    { code: 'all_stores', description: 'Access data from all stores', category: 'administration' },
    { code: 'products', description: 'Product catalog management', category: 'catalog' },
    { code: 'inventory', description: 'Inventory management', category: 'operations' },
    { code: 'purchases', description: 'Purchase invoice management', category: 'procurement' },
    { code: 'transfers', description: 'Store-to-store transfers', category: 'operations' },
    { code: 'sales', description: 'Point of sale', category: 'sales' },
    { code: 'returns', description: 'Customer and supplier returns', category: 'sales' },
    { code: 'dealers', description: 'Wholesale dealer management', category: 'wholesale' },
    { code: 'expenses', description: 'Expense tracking', category: 'finance' },
    { code: 'reports', description: 'Reports and analytics', category: 'finance' },
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

  const passwordHash = await bcrypt.hash('admin123', 12);
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
