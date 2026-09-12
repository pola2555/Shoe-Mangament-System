/**
 * WHAT A DELETE DESTROYED.
 *
 * The activity log used to build every entry out of `req.body`. A DELETE has no body,
 * so every delete in the system logged `details: null` — the log said somebody deleted
 * an expense and nothing whatsoever about which one. That is exactly backwards: a
 * delete is the ONE case where the log is the only surviving copy of the record, so it
 * is the case that needs the most detail, not the least.
 *
 * So before a DELETE handler runs, we read the row it is about to destroy and keep a
 * short, human summary of it. Columns are chosen to answer "which one was that?" a year
 * later — never a password hash, never a whole row.
 *
 * The map is hand-kept, which is a thing that rots. `e2e`/check coverage asserts that
 * every DELETE route the app mounts is either listed here or explicitly excused, so a
 * new delete route fails a test rather than quietly logging nothing.
 */

/**
 * @typedef {Object} Target
 * @property {string} table          table to read
 * @property {string[]} columns      columns worth keeping
 * @property {(p: Object) => Object} where  builds the lookup from req.params
 * @property {string} [entityType]   overrides the module's default entity type
 * @property {boolean} [softDelete]  the row survives (deactivate / clear a field)
 */

/** Ordered: the FIRST pattern that matches wins, so put nested paths before `/:id`. */
const DELETE_TARGETS = [
  // ---------------------------------------------------------------- expenses
  {
    match: /^\/api\/expenses\/categories\/([^/]+)$/,
    table: 'expense_categories',
    columns: ['id', 'name', 'name_ar', 'parent_id', 'is_active'],
    where: (m) => ({ id: m[1] }),
    entityType: 'expense_category',
  },
  {
    match: /^\/api\/expenses\/recurring\/([^/]+)$/,
    table: 'expense_recurring',
    columns: ['id', 'description', 'amount', 'frequency', 'next_date', 'store_id', 'category_id'],
    where: (m) => ({ id: m[1] }),
    entityType: 'recurring_expense',
  },
  {
    match: /^\/api\/expenses\/[^/]+\/receipts\/([^/]+)$/,
    table: 'attached_images',
    columns: ['id', 'entity_type', 'entity_id', 'original_name'],
    where: (m) => ({ id: m[1] }),
    entityType: 'expense_receipt',
  },
  {
    match: /^\/api\/expenses\/([^/]+)$/,
    table: 'expenses',
    columns: ['id', 'description', 'amount', 'expense_date', 'store_id', 'category_id',
      'payment_method', 'paid_to'],
    where: (m) => ({ id: m[1] }),
    entityType: 'expense',
  },

  // ---------------------------------------------------------------- loans
  {
    match: /^\/api\/loans\/[^/]+\/payments\/[^/]+\/images\/([^/]+)$/,
    table: 'attached_images',
    columns: ['id', 'entity_type', 'entity_id', 'original_name'],
    where: (m) => ({ id: m[1] }),
    entityType: 'loan_payment_proof',
  },
  {
    match: /^\/api\/loans\/[^/]+\/payments\/([^/]+)$/,
    table: 'loan_payments',
    columns: ['id', 'loan_id', 'amount', 'payment_date', 'payment_method'],
    where: (m) => ({ id: m[1] }),
    entityType: 'loan_payment',
  },
  {
    match: /^\/api\/loans\/([^/]+)$/,
    table: 'loans',
    columns: ['id', 'borrower_name', 'amount', 'paid_amount', 'status', 'loan_date',
      'due_date', 'store_id'],
    where: (m) => ({ id: m[1] }),
    entityType: 'loan',
  },

  // ---------------------------------------------------------------- products
  {
    match: /^\/api\/products\/[^/]+\/colors\/([^/]+)$/,
    table: 'product_colors',
    columns: ['id', 'product_id', 'color_name', 'color_seq', 'is_placeholder'],
    where: (m) => ({ id: m[1] }),
    entityType: 'color',
  },
  {
    match: /^\/api\/products\/[^/]+\/images\/([^/]+)$/,
    table: 'product_color_images',
    columns: ['id', 'product_color_id', 'image_url', 'is_primary'],
    where: (m) => ({ id: m[1] }),
    entityType: 'image',
  },
  {
    match: /^\/api\/products\/[^/]+\/variants\/([^/]+)$/,
    table: 'product_variants',
    columns: ['id', 'product_id', 'product_color_id', 'size_eu', 'sku', 'barcode'],
    where: (m) => ({ id: m[1] }),
    entityType: 'variant',
  },
  {
    // A branch price override. Composite key, no surrogate id in the path.
    match: /^\/api\/products\/([^/]+)\/prices\/([^/]+)$/,
    table: 'store_product_prices',
    columns: ['id', 'store_id', 'product_id', 'selling_price', 'min_selling_price',
      'max_selling_price'],
    where: (m) => ({ product_id: m[1], store_id: m[2] }),
    entityType: 'store_price',
  },

  // ---------------------------------------------------------------- purchases
  {
    match: /^\/api\/purchases\/invoices\/[^/]+\/images\/([^/]+)$/,
    table: 'attached_images',
    columns: ['id', 'entity_type', 'entity_id', 'original_name'],
    where: (m) => ({ id: m[1] }),
    entityType: 'invoice_image',
  },
  {
    match: /^\/api\/purchases\/invoices\/([^/]+)$/,
    table: 'purchase_invoices',
    columns: ['id', 'invoice_number', 'supplier_id', 'total_amount', 'paid_amount',
      'status', 'invoice_date'],
    where: (m) => ({ id: m[1] }),
    entityType: 'invoice',
  },
  {
    match: /^\/api\/purchases\/boxes\/([^/]+)$/,
    table: 'purchase_invoice_boxes',
    columns: ['id', 'invoice_id', 'product_id', 'cost_per_item', 'total_items',
      'destination_store_id', 'detail_status'],
    where: (m) => ({ id: m[1] }),
    entityType: 'box',
  },

  // ---------------------------------------------------------------- everything else
  {
    match: /^\/api\/customers\/([^/]+)$/,
    table: 'customers',
    columns: ['id', 'name', 'phone'],
    where: (m) => ({ id: m[1] }),
    entityType: 'customer',
  },
  {
    match: /^\/api\/suppliers\/([^/]+)$/,
    table: 'suppliers',
    columns: ['id', 'name', 'phone', 'is_active'],
    where: (m) => ({ id: m[1] }),
    entityType: 'supplier',
  },
  {
    match: /^\/api\/dealers\/([^/]+)$/,
    table: 'dealers',
    columns: ['id', 'name', 'phone', 'is_active'],
    where: (m) => ({ id: m[1] }),
    entityType: 'dealer',
  },
  {
    match: /^\/api\/box-templates\/([^/]+)$/,
    table: 'box_templates',
    columns: ['id', 'name', 'product_id'],
    where: (m) => ({ id: m[1] }),
    entityType: 'box_template',
  },
  {
    match: /^\/api\/stock-intakes\/([^/]+)$/,
    table: 'stock_intakes',
    columns: ['id', 'intake_number', 'store_id', 'status', 'reason', 'intake_date'],
    where: (m) => ({ id: m[1] }),
    entityType: 'stock_intake',
  },
  {
    // Deactivation, not deletion — the row survives, so record the state it was in.
    match: /^\/api\/users\/([^/]+)$/,
    table: 'users',
    columns: ['id', 'username', 'full_name', 'role_id', 'store_id', 'is_active'],
    where: (m) => ({ id: m[1] }),
    entityType: 'user',
    softDelete: true,
  },
  {
    // Clearing a seller's checkout code. The code itself is bcrypt-hashed and must
    // never be read here — only who lost one.
    match: /^\/api\/discounts\/sellers\/([^/]+)\/code$/,
    table: 'users',
    columns: ['id', 'username', 'full_name'],
    where: (m) => ({ id: m[1] }),
    entityType: 'seller_code',
    softDelete: true,
  },
  {
    match: /^\/api\/barcodes\/([^/]+)$/,
    table: 'product_variants',
    columns: ['id', 'product_id', 'size_eu', 'sku', 'barcode'],
    where: (m) => ({ id: m[1] }),
    entityType: 'variant',
    softDelete: true,
  },
];

/**
 * DELETE routes that deliberately snapshot nothing, and why. Listed rather than
 * omitted so the coverage check can tell "considered" from "forgotten".
 */
const DELETE_TARGETS_EXCUSED = [
  { match: /^\/api\/notifications\/?$/, why: 'a date range of the caller\'s own notifications, not one record' },
  { match: /^\/api\/audit-log\/clear$/, why: 'clears the log itself; the row count is reported in the response' },
];

/** First matching target for a path, or null. */
function findDeleteTarget(pathname) {
  for (const t of DELETE_TARGETS) {
    const m = pathname.match(t.match);
    if (m) return { target: t, match: m };
  }
  return null;
}

function isExcusedDelete(pathname) {
  return DELETE_TARGETS_EXCUSED.some((e) => e.match.test(pathname));
}

module.exports = {
  DELETE_TARGETS,
  DELETE_TARGETS_EXCUSED,
  findDeleteTarget,
  isExcusedDelete,
};
