/**
 * MIGRATION: Create all core tables for the Shoe ERP system.
 * 
 * This single migration creates the entire schema because all tables are
 * interdependent and should be created together on first setup.
 * Future schema changes will be separate migration files.
 * 
 * Table creation order matters due to foreign key dependencies:
 *   1. Independent tables (roles, permissions, stores, etc.)
 *   2. Tables depending on #1 (users, products, etc.)
 *   3. Tables depending on #2 (variants, invoices, etc.)
 *   4. Tables depending on #3 (inventory, sales, etc.)
 */
exports.up = async function (knex) {

  // ============================================================
  // 1. ROLES & PERMISSIONS
  // ============================================================

  await knex.schema.createTable('roles', (t) => {
    t.increments('id').primary();
    t.string('name', 50).notNullable().unique();
    t.text('description');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('permissions', (t) => {
    t.increments('id').primary();
    t.string('code', 50).notNullable().unique();
    t.text('description');
    t.string('category', 50);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 2. STORES
  // ============================================================

  await knex.schema.createTable('stores', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 100).notNullable();
    t.text('address');
    t.string('phone', 20);
    t.boolean('is_warehouse').defaultTo(false);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 3. USERS
  // ============================================================

  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('username', 50).notNullable().unique();
    t.string('email', 100).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('full_name', 100);
    t.integer('role_id').unsigned().references('id').inTable('roles').onDelete('RESTRICT');
    t.uuid('store_id').references('id').inTable('stores').onDelete('SET NULL');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_login_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('user_permissions', (t) => {
    t.increments('id').primary();
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('permission_code', 50).notNullable().references('code').inTable('permissions').onDelete('CASCADE');
    t.enu('access_level', ['read', 'write']).notNullable().defaultTo('read');
    t.timestamp('granted_at').defaultTo(knex.fn.now());
    t.unique(['user_id', 'permission_code']);
  });

  await knex.schema.createTable('refresh_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('token', 500).notNullable();
    t.timestamp('expires_at').notNullable();
    t.boolean('is_revoked').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 4. PRODUCTS
  // ============================================================

  await knex.schema.createTable('products', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('product_code', 50).notNullable().unique();
    t.string('brand', 100);
    t.string('model_name', 200).notNullable();
    t.decimal('net_price', 10, 2);
    t.decimal('default_selling_price', 10, 2);
    t.decimal('min_selling_price', 10, 2);
    t.decimal('max_selling_price', 10, 2);
    t.text('description');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('store_product_prices', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.decimal('selling_price', 10, 2).notNullable();
    t.decimal('min_selling_price', 10, 2);
    t.decimal('max_selling_price', 10, 2);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['store_id', 'product_id']);
  });

  await knex.schema.createTable('product_colors', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.string('color_name', 50).notNullable();
    t.string('hex_code', 7);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['product_id', 'color_name']);
  });

  await knex.schema.createTable('product_color_images', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('product_color_id').notNullable().references('id').inTable('product_colors').onDelete('CASCADE');
    t.text('image_url').notNullable();
    t.boolean('is_primary').defaultTo(false);
    t.integer('sort_order').defaultTo(0);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('product_variants', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.uuid('product_color_id').notNullable().references('id').inTable('product_colors').onDelete('CASCADE');
    t.string('size_eu', 10).notNullable();
    t.string('size_us', 10);
    t.string('size_uk', 10);
    t.decimal('size_cm', 4, 1);
    t.string('sku', 50).notNullable().unique();
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['product_id', 'product_color_id', 'size_eu']);
  });

  // ============================================================
  // 5. BOX TEMPLATES
  // ============================================================

  await knex.schema.createTable('box_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 100).notNullable();
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('box_template_items', (t) => {
    t.increments('id').primary();
    t.uuid('template_id').notNullable().references('id').inTable('box_templates').onDelete('CASCADE');
    t.string('size', 10).notNullable();
    t.integer('quantity').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 6. SUPPLIERS & PURCHASE INVOICES
  // ============================================================

  await knex.schema.createTable('suppliers', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 200).notNullable();
    t.string('phone', 20);
    t.string('email', 100);
    t.text('address');
    t.text('notes');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('purchase_invoices', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('invoice_number', 50).notNullable().unique();
    t.uuid('supplier_id').notNullable().references('id').inTable('suppliers').onDelete('RESTRICT');
    t.decimal('total_amount', 12, 2).notNullable().defaultTo(0);
    t.decimal('paid_amount', 12, 2).defaultTo(0);
    t.enu('status', ['pending', 'partial', 'paid']).defaultTo('pending');
    t.text('notes');
    t.date('invoice_date').notNullable();
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('purchase_invoice_boxes', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('invoice_id').notNullable().references('id').inTable('purchase_invoices').onDelete('CASCADE');
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL');        // nullable: deferred
    t.uuid('box_template_id').references('id').inTable('box_templates').onDelete('SET NULL');
    t.decimal('cost_per_item', 10, 2);
    t.integer('total_items');
    t.uuid('destination_store_id').references('id').inTable('stores').onDelete('SET NULL'); // nullable: deferred
    t.enu('detail_status', ['pending', 'partial', 'complete']).defaultTo('pending');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('box_items', (t) => {
    t.increments('id').primary();
    t.uuid('invoice_box_id').notNullable().references('id').inTable('purchase_invoice_boxes').onDelete('CASCADE');
    t.uuid('product_color_id').references('id').inTable('product_colors').onDelete('SET NULL'); // nullable: deferred
    t.string('size_eu', 10).notNullable();
    t.string('size_us', 10);
    t.string('size_uk', 10);
    t.decimal('size_cm', 4, 1);
    t.integer('quantity').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Supplier payments (FIFO auto-assignment to invoices)
  await knex.schema.createTable('supplier_payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('supplier_id').notNullable().references('id').inTable('suppliers').onDelete('RESTRICT');
    t.decimal('total_amount', 10, 2).notNullable();
    t.string('payment_method', 50).notNullable();
    t.date('payment_date').notNullable();
    t.string('reference_no', 100);
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('supplier_payment_allocations', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('payment_id').notNullable().references('id').inTable('supplier_payments').onDelete('CASCADE');
    t.uuid('invoice_id').notNullable().references('id').inTable('purchase_invoices').onDelete('CASCADE');
    t.decimal('allocated_amount', 10, 2).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 7. INVENTORY
  // ============================================================

  await knex.schema.createTable('inventory_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('variant_id').notNullable().references('id').inTable('product_variants').onDelete('RESTRICT');
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.decimal('cost', 10, 2);
    t.uuid('invoice_box_id').references('id').inTable('purchase_invoice_boxes').onDelete('SET NULL'); // nullable for manual
    t.enu('source', ['purchase', 'manual']).defaultTo('purchase');
    t.enu('status', ['in_stock', 'sold', 'returned', 'damaged', 'in_transfer']).defaultTo('in_stock');
    t.string('barcode', 100);
    t.timestamp('sold_at');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['store_id', 'status']);
    t.index(['variant_id', 'store_id']);
  });

  // ============================================================
  // 8. STORE TRANSFERS
  // ============================================================

  await knex.schema.createTable('store_transfers', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('transfer_number', 50).notNullable().unique();
    t.uuid('from_store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.uuid('to_store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.enu('status', ['pending', 'shipped', 'received', 'cancelled']).defaultTo('pending');
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('shipped_at');
    t.timestamp('received_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('transfer_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('transfer_id').notNullable().references('id').inTable('store_transfers').onDelete('CASCADE');
    t.uuid('inventory_item_id').notNullable().references('id').inTable('inventory_items').onDelete('RESTRICT');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 9. CUSTOMERS
  // ============================================================

  await knex.schema.createTable('customers', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('phone', 20).notNullable().unique();
    t.string('name', 100);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 10. SALES (POS)
  // ============================================================

  await knex.schema.createTable('sales', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('sale_number', 50).notNullable().unique();
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.decimal('total_amount', 10, 2).notNullable();
    t.decimal('discount_amount', 10, 2).defaultTo(0);
    t.decimal('final_amount', 10, 2).notNullable();
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('sale_payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('sale_id').notNullable().references('id').inTable('sales').onDelete('CASCADE');
    t.enu('payment_method', ['cash', 'card', 'instapay', 'vodafone_cash', 'fawry', 'bank_transfer', 'other']).notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.string('reference_no', 100);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('sale_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('sale_id').notNullable().references('id').inTable('sales').onDelete('CASCADE');
    t.uuid('inventory_item_id').notNullable().references('id').inTable('inventory_items').onDelete('RESTRICT');
    t.decimal('sale_price', 10, 2).notNullable();
    t.decimal('cost_at_sale', 10, 2).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 11. CUSTOMER RETURNS
  // ============================================================

  await knex.schema.createTable('customer_returns', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('return_number', 50).notNullable().unique();
    t.uuid('sale_id').notNullable().references('id').inTable('sales').onDelete('RESTRICT');
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.text('reason');
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('customer_return_items', (t) => {
    t.increments('id').primary();
    t.uuid('return_id').notNullable().references('id').inTable('customer_returns').onDelete('CASCADE');
    t.uuid('sale_item_id').notNullable().references('id').inTable('sale_items').onDelete('RESTRICT');
    t.decimal('refund_amount', 10, 2).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 12. SUPPLIER RETURNS
  // ============================================================

  await knex.schema.createTable('supplier_returns', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('return_number', 50).notNullable().unique();
    t.uuid('supplier_id').notNullable().references('id').inTable('suppliers').onDelete('RESTRICT');
    t.uuid('purchase_invoice_id').references('id').inTable('purchase_invoices').onDelete('SET NULL');
    t.text('reason');
    t.text('notes');
    t.decimal('total_amount', 10, 2).defaultTo(0);
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('supplier_return_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('return_id').notNullable().references('id').inTable('supplier_returns').onDelete('CASCADE');
    t.uuid('inventory_item_id').notNullable().references('id').inTable('inventory_items').onDelete('RESTRICT');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 13. WHOLESALE DEALERS
  // ============================================================

  await knex.schema.createTable('dealers', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 200).notNullable();
    t.string('phone', 20);
    t.string('email', 100);
    t.text('address');
    t.text('notes');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('wholesale_invoices', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('invoice_number', 50).notNullable().unique();
    t.uuid('dealer_id').notNullable().references('id').inTable('dealers').onDelete('RESTRICT');
    t.decimal('total_amount', 12, 2).notNullable().defaultTo(0);
    t.decimal('paid_amount', 12, 2).defaultTo(0);
    t.enu('status', ['pending', 'partial', 'paid']).defaultTo('pending');
    t.text('notes');
    t.date('invoice_date').notNullable();
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('wholesale_invoice_boxes', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('invoice_id').notNullable().references('id').inTable('wholesale_invoices').onDelete('CASCADE');
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL');
    t.uuid('product_color_id').references('id').inTable('product_colors').onDelete('SET NULL');
    t.jsonb('size_quantities');      // { "40": 1, "41": 2, "42": 3 }
    t.decimal('price_per_item', 10, 2);
    t.integer('total_items');
    t.decimal('total_price', 10, 2);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Dealer payments (FIFO auto-assignment)
  await knex.schema.createTable('dealer_payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('dealer_id').notNullable().references('id').inTable('dealers').onDelete('RESTRICT');
    t.decimal('total_amount', 10, 2).notNullable();
    t.string('payment_method', 50).notNullable();
    t.date('payment_date').notNullable();
    t.string('reference_no', 100);
    t.text('notes');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('dealer_payment_allocations', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('payment_id').notNullable().references('id').inTable('dealer_payments').onDelete('CASCADE');
    t.uuid('invoice_id').notNullable().references('id').inTable('wholesale_invoices').onDelete('CASCADE');
    t.decimal('allocated_amount', 10, 2).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 14. EXPENSES
  // ============================================================

  await knex.schema.createTable('expense_categories', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable().unique();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('expenses', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
    t.integer('category_id').unsigned().references('id').inTable('expense_categories').onDelete('RESTRICT');
    t.decimal('amount', 10, 2).notNullable();
    t.text('description');
    t.date('expense_date').notNullable();
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ============================================================
  // 15. ATTACHED IMAGES (polymorphic)
  // ============================================================

  await knex.schema.createTable('attached_images', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('entity_type', 30).notNullable();    // 'purchase_invoice', 'wholesale_invoice', 'supplier_payment', 'dealer_payment', 'sale_payment'
    t.uuid('entity_id').notNullable();
    t.text('image_url').notNullable();
    t.string('original_name', 255);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['entity_type', 'entity_id']);
  });

  // ============================================================
  // 16. AUDIT LOGS
  // ============================================================

  await knex.schema.createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 50).notNullable();          // CREATE, UPDATE, DELETE
    t.string('entity_type', 50).notNullable();
    t.uuid('entity_id');
    t.jsonb('old_data');
    t.jsonb('new_data');
    t.string('ip_address', 45);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['entity_type', 'entity_id']);
    t.index(['user_id', 'created_at']);
  });
};


/**
 * ROLLBACK: Drop all tables in reverse dependency order.
 */
exports.down = async function (knex) {
  const tables = [
    'audit_logs',
    'attached_images',
    'expenses',
    'expense_categories',
    'dealer_payment_allocations',
    'dealer_payments',
    'wholesale_invoice_boxes',
    'wholesale_invoices',
    'dealers',
    'supplier_return_items',
    'supplier_returns',
    'customer_return_items',
    'customer_returns',
    'sale_items',
    'sale_payments',
    'sales',
    'customers',
    'transfer_items',
    'store_transfers',
    'inventory_items',
    'supplier_payment_allocations',
    'supplier_payments',
    'box_items',
    'purchase_invoice_boxes',
    'purchase_invoices',
    'suppliers',
    'box_template_items',
    'box_templates',
    'product_variants',
    'product_color_images',
    'product_colors',
    'store_product_prices',
    'products',
    'refresh_tokens',
    'user_permissions',
    'users',
    'stores',
    'permissions',
    'roles',
  ];

  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};
