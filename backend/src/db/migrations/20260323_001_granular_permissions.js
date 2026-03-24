/**
 * MIGRATION: Granular permissions system.
 *
 * Changes:
 *   1. Create `user_stores` table (many-to-many user↔store assignment)
 *   2. Create `activity_log` table (system-wide audit trail)
 *   3. Replace 12 broad permission codes with 33 granular codes
 *   4. Migrate existing user_permissions to new codes
 */
exports.up = async function (knex) {

  // ============================================================
  // 1. USER_STORES — multi-store assignment
  // ============================================================
  await knex.schema.createTable('user_stores', (t) => {
    t.increments('id').primary();
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['user_id', 'store_id']);
  });

  // ============================================================
  // 2. ACTIVITY_LOG — audit trail
  // ============================================================
  await knex.schema.createTable('activity_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 50).notNullable();
    t.string('module', 50).notNullable();
    t.string('entity_id');
    t.string('entity_type', 50);
    t.jsonb('details');
    t.uuid('store_id').references('id').inTable('stores').onDelete('SET NULL');
    t.string('ip_address', 45);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('created_at');
    t.index('user_id');
    t.index('module');
    t.index('action');
  });

  // ============================================================
  // 3. MIGRATE PERMISSIONS — old codes → new granular codes
  // ============================================================

  // Mapping: old_code → [new_codes]
  const expansions = {
    purchases: ['purchases', 'purchase_boxes', 'purchase_images', 'suppliers', 'supplier_payments'],
    sales: ['pos', 'sales', 'sale_payments', 'customers'],
    returns: ['customer_returns', 'supplier_returns'],
    dealers: ['dealers', 'dealer_invoices', 'dealer_payments'],
    products: ['products', 'product_variants', 'product_images', 'product_prices', 'box_templates'],
  };

  // Save existing user_permissions before clearing
  const existingPerms = await knex('user_permissions').select('*');

  // Delete all existing permissions & user_permissions
  await knex('user_permissions').del();
  await knex('permissions').del();

  // Insert all 33 new permission codes
  await knex('permissions').insert([
    // Administration
    { code: 'users', description: 'User account management', category: 'administration' },
    { code: 'user_permissions', description: 'Permission assignment', category: 'administration' },
    { code: 'user_password_reset', description: 'Admin password resets', category: 'administration' },
    { code: 'stores', description: 'Store management', category: 'administration' },
    { code: 'all_stores', description: 'Cross-store data access', category: 'administration' },
    // Product Catalog
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
  ]);

  // Re-insert user permissions, expanding old codes to new ones
  const newPerms = [];
  for (const perm of existingPerms) {
    const oldCode = perm.permission_code;
    if (expansions[oldCode]) {
      // Expand to multiple new codes
      for (const newCode of expansions[oldCode]) {
        newPerms.push({
          user_id: perm.user_id,
          permission_code: newCode,
          access_level: perm.access_level,
        });
      }
    } else {
      // Code is the same (users, stores, all_stores, inventory, transfers, expenses, reports)
      newPerms.push({
        user_id: perm.user_id,
        permission_code: oldCode,
        access_level: perm.access_level,
      });
    }
  }

  // Also grant new codes that didn't exist before to users who had the parent
  // For users with old 'users' permission, also grant user_permissions, user_password_reset
  for (const perm of existingPerms) {
    if (perm.permission_code === 'users') {
      newPerms.push({ user_id: perm.user_id, permission_code: 'user_permissions', access_level: perm.access_level });
      newPerms.push({ user_id: perm.user_id, permission_code: 'user_password_reset', access_level: perm.access_level });
    }
    if (perm.permission_code === 'transfers') {
      newPerms.push({ user_id: perm.user_id, permission_code: 'transfer_actions', access_level: perm.access_level });
    }
    if (perm.permission_code === 'sales') {
      newPerms.push({ user_id: perm.user_id, permission_code: 'pos_store_access', access_level: perm.access_level });
    }
    if (perm.permission_code === 'expenses') {
      newPerms.push({ user_id: perm.user_id, permission_code: 'expense_categories', access_level: perm.access_level });
    }
  }

  // Grant notifications, audit_log to admin users (role_id=1)
  const adminUsers = await knex('users').where('role_id', 1).select('id');
  for (const admin of adminUsers) {
    newPerms.push({ user_id: admin.id, permission_code: 'notifications', access_level: 'write' });
    newPerms.push({ user_id: admin.id, permission_code: 'audit_log', access_level: 'read' });
  }

  // Deduplicate (user_id + permission_code must be unique)
  const seen = new Set();
  const dedupedPerms = [];
  for (const p of newPerms) {
    const key = `${p.user_id}::${p.permission_code}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedPerms.push(p);
    }
  }

  if (dedupedPerms.length > 0) {
    // Insert in batches to avoid hitting parameter limits
    const batchSize = 100;
    for (let i = 0; i < dedupedPerms.length; i += batchSize) {
      await knex('user_permissions').insert(dedupedPerms.slice(i, i + batchSize));
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('activity_log');
  await knex.schema.dropTableIfExists('user_stores');

  // Restore original 12 permissions (simplified — does not restore user_permissions mapping)
  await knex('user_permissions').del();
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
};
