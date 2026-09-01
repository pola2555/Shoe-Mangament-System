/**
 * MIGRATION: Foreign-key and hot-path indexes.
 *
 * PostgreSQL creates an index for a PRIMARY KEY and for UNIQUE constraints, but NOT
 * for foreign keys. This schema declared only 7 indexes across ~40 tables, so almost
 * every join in the application was driven by a sequential scan.
 *
 * The worst offender is customer_return_items(sale_item_id): every report LEFT JOINs
 * it to exclude returned items, so a full scan of that table happened on each one.
 *
 * Uses CREATE INDEX CONCURRENTLY so nothing takes an exclusive lock — this can run
 * against a live database during business hours.
 *
 * CONCURRENTLY cannot run inside a transaction, hence `config.transaction = false`.
 * The trade-off is that a failure leaves an INVALID index behind; IF NOT EXISTS makes
 * a re-run safe, but check for invalid indexes if this migration ever fails:
 *   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
 */
exports.config = { transaction: false };

const INDEXES = [
  // --- Sales: driven by every report's date/store grouping ---
  ['idx_sales_store_created', 'sales', '(store_id, created_at DESC)'],
  ['idx_sales_created_at', 'sales', '(created_at DESC)'],
  ['idx_sales_customer', 'sales', '(customer_id)'],
  ['idx_sales_created_by', 'sales', '(created_by)'],

  // --- Sale lines ---
  ['idx_sale_items_sale', 'sale_items', '(sale_id)'],
  ['idx_sale_items_inventory_item', 'sale_items', '(inventory_item_id)'],
  ['idx_sale_payments_sale', 'sale_payments', '(sale_id)'],

  // --- Customer returns: LEFT JOINed by every profit/revenue report ---
  ['idx_customer_return_items_sale_item', 'customer_return_items', '(sale_item_id)'],
  ['idx_customer_return_items_return', 'customer_return_items', '(return_id)'],
  ['idx_customer_returns_sale', 'customer_returns', '(sale_id)'],
  ['idx_customer_returns_store_created', 'customer_returns', '(store_id, created_at DESC)'],

  // --- Purchasing ---
  ['idx_purchase_invoices_supplier', 'purchase_invoices', '(supplier_id)'],
  ['idx_purchase_invoices_status_date', 'purchase_invoices', '(status, invoice_date)'],
  ['idx_purchase_invoice_boxes_invoice', 'purchase_invoice_boxes', '(invoice_id)'],
  ['idx_box_items_invoice_box', 'box_items', '(invoice_box_id)'],
  ['idx_inventory_items_invoice_box', 'inventory_items', '(invoice_box_id)'],
  ['idx_supplier_payments_supplier_type', 'supplier_payments', '(supplier_id, type)'],
  ['idx_supplier_payment_alloc_invoice', 'supplier_payment_allocations', '(invoice_id)'],
  ['idx_supplier_payment_alloc_payment', 'supplier_payment_allocations', '(payment_id)'],
  ['idx_supplier_returns_supplier', 'supplier_returns', '(supplier_id)'],
  ['idx_supplier_return_items_return', 'supplier_return_items', '(return_id)'],
  ['idx_supplier_return_items_inventory', 'supplier_return_items', '(inventory_item_id)'],

  // --- Transfers ---
  ['idx_transfer_items_transfer', 'transfer_items', '(transfer_id)'],
  ['idx_transfer_items_inventory', 'transfer_items', '(inventory_item_id)'],
  ['idx_store_transfers_from', 'store_transfers', '(from_store_id, status)'],
  ['idx_store_transfers_to', 'store_transfers', '(to_store_id, status)'],

  // --- Catalog: product_color_images is hit by the LATERAL image lookup per row ---
  ['idx_product_color_images_color', 'product_color_images', '(product_color_id, is_primary DESC, created_at ASC)'],
  ['idx_product_colors_product', 'product_colors', '(product_id)'],
  ['idx_product_variants_product', 'product_variants', '(product_id)'],
  ['idx_product_variants_color', 'product_variants', '(product_color_id)'],
  ['idx_store_product_prices_product', 'store_product_prices', '(product_id)'],

  // --- Finance ---
  ['idx_expenses_store_date', 'expenses', '(store_id, expense_date DESC)'],
  ['idx_expenses_category', 'expenses', '(category_id)'],
  ['idx_loans_store_status', 'loans', '(store_id, status)'],
  ['idx_loan_payments_loan', 'loan_payments', '(loan_id)'],

  // --- Wholesale ---
  ['idx_wholesale_invoices_dealer', 'wholesale_invoices', '(dealer_id, status)'],
  ['idx_wholesale_invoice_boxes_invoice', 'wholesale_invoice_boxes', '(invoice_id)'],
  ['idx_dealer_payments_dealer', 'dealer_payments', '(dealer_id)'],
  ['idx_dealer_payment_alloc_invoice', 'dealer_payment_allocations', '(invoice_id)'],
  ['idx_dealer_payment_alloc_payment', 'dealer_payment_allocations', '(payment_id)'],

  // --- Auth: refresh_tokens.token is looked up on every token refresh ---
  ['idx_refresh_tokens_token', 'refresh_tokens', '(token)'],
  ['idx_refresh_tokens_user', 'refresh_tokens', '(user_id)'],
  // Supports the retention sweep.
  ['idx_refresh_tokens_expires', 'refresh_tokens', '(expires_at)'],

  // --- Audit ---
  ['idx_activity_log_store', 'activity_log', '(store_id)'],
];

exports.up = async function (knex) {
  for (const [name, table, columns] of INDEXES) {
    await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${columns}`);
  }
};

exports.down = async function (knex) {
  for (const [name] of INDEXES) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  }
};
