const db = require('../config/database');

/**
 * TURNING IDS INTO NAMES, WHEN THE LOG IS READ.
 *
 * The activity log stores what the request contained, and a request contains ids: a row
 * read `store_id: 10748133-4451-4d05-…`, and the Entity column read `store #10748133`.
 * Nobody can audit that.
 *
 * WHY AT READ TIME, NOT WRITE TIME
 *
 *   - The log is fire-and-forget precisely so it can never slow down or fail a sale.
 *     Resolving names on the way in would add queries to every write in the system.
 *   - It fixes the rows already stored. There were 3,728 of them, all full of ids.
 *   - One page is 50 rows, so this is a handful of batched `whereIn`s regardless of how
 *     many ids those rows mention — never a query per row.
 *
 * The trade-off, stated plainly: a name resolved now is the name the record has NOW.
 * Rename a branch and last month's log entries show the new name. That is the right
 * answer for "which branch was this?" and the wrong one for "what was it called at the
 * time" — and for the case where the record no longer exists at all, the delete
 * snapshot in `details.deleted` carries the name as it was. See auditTargets.js.
 */

/**
 * Where each kind of id lives, and how to say it in one line.
 * `label` receives the row and returns a human string.
 */
const SOURCES = {
  store: {
    table: 'stores',
    columns: ['id', 'name'],
    label: (r) => r.name,
  },
  user: {
    table: 'users',
    columns: ['id', 'full_name', 'username'],
    label: (r) => r.full_name || r.username,
  },
  product: {
    table: 'products',
    columns: ['id', 'product_code', 'model_name', 'brand'],
    label: (r) => [r.brand, r.model_name].filter(Boolean).join(' ') + (r.product_code ? ` (${r.product_code})` : ''),
  },
  customer: {
    table: 'customers',
    columns: ['id', 'name', 'phone'],
    label: (r) => r.name + (r.phone ? ` · ${r.phone}` : ''),
  },
  supplier: { table: 'suppliers', columns: ['id', 'name'], label: (r) => r.name },
  dealer: { table: 'dealers', columns: ['id', 'name'], label: (r) => r.name },
  color: {
    table: 'product_colors',
    columns: ['id', 'color_name', 'is_placeholder'],
    // A placeholder colour is a sentinel row that stands in for "this category has no
    // colours". Printing its name would invent a choice nobody made.
    label: (r) => (r.is_placeholder ? null : r.color_name),
  },
  variant: {
    table: 'product_variants',
    columns: ['id', 'sku', 'size_eu'],
    label: (r) => (r.sku ? `${r.sku}` : `size ${r.size_eu}`),
  },
  inventory_item: {
    table: 'inventory_items',
    columns: ['id', 'barcode'],
    label: (r) => (r.barcode ? `pair ${r.barcode}` : 'one pair'),
  },
  sale: { table: 'sales', columns: ['id', 'sale_number'], label: (r) => r.sale_number },
  invoice: {
    table: 'purchase_invoices',
    columns: ['id', 'invoice_number'],
    label: (r) => r.invoice_number,
  },
  box: {
    table: 'purchase_invoice_boxes',
    columns: ['id', 'total_items', 'cost_per_item'],
    label: (r) => `box of ${r.total_items}`,
  },
  transfer: {
    table: 'store_transfers',
    columns: ['id', 'transfer_number'],
    label: (r) => r.transfer_number,
  },
  expense: {
    table: 'expenses',
    columns: ['id', 'description', 'amount'],
    label: (r) => `${r.description || 'expense'} — ${r.amount}`,
  },
  expense_category: {
    table: 'expense_categories',
    columns: ['id', 'name'],
    label: (r) => r.name,
  },
  product_category: {
    table: 'product_categories',
    columns: ['id', 'name_en'],
    label: (r) => r.name_en,
  },
  recurring_expense: {
    table: 'expense_recurring',
    columns: ['id', 'description', 'amount', 'frequency'],
    label: (r) => `${r.description || 'recurring'} — ${r.amount} ${r.frequency}`,
  },
  loan: {
    table: 'loans',
    columns: ['id', 'borrower_name', 'amount'],
    label: (r) => `${r.borrower_name} — ${r.amount}`,
  },
  loan_payment: {
    table: 'loan_payments',
    columns: ['id', 'amount', 'payment_date'],
    label: (r) => `${r.amount} on ${r.payment_date}`,
  },
  shift: { table: 'shifts', columns: ['id', 'shift_number'], label: (r) => r.shift_number },
  stock_count: {
    table: 'stock_counts',
    columns: ['id', 'count_number'],
    label: (r) => r.count_number,
  },
  stock_intake: {
    table: 'stock_intakes',
    columns: ['id', 'intake_number'],
    label: (r) => r.intake_number,
  },
  exchange: {
    table: 'exchanges',
    columns: ['id', 'exchange_number'],
    label: (r) => r.exchange_number,
  },
  discount_request: {
    table: 'discount_requests',
    columns: ['id', 'request_number'],
    label: (r) => r.request_number,
  },
  customer_return: {
    table: 'customer_returns',
    columns: ['id', 'return_number'],
    label: (r) => r.return_number,
  },
  supplier_return: {
    table: 'supplier_returns',
    columns: ['id', 'return_number'],
    label: (r) => r.return_number,
  },
  box_template: { table: 'box_templates', columns: ['id', 'name'], label: (r) => r.name },
  notification: {
    table: 'notifications',
    columns: ['id', 'title'],
    label: (r) => r.title,
  },
};

/**
 * Which source a `*_id` field in `details` points at.
 * Anything not listed is left as-is rather than guessed at.
 */
const FIELD_SOURCES = {
  store_id: 'store',
  from_store_id: 'store',
  to_store_id: 'store',
  destination_store_id: 'store',
  store_ids: 'store',
  user_id: 'user',
  borrower_user_id: 'user',
  created_by: 'user',
  sold_by: 'user',
  decided_by: 'user',
  requested_by: 'user',
  posted_by: 'user',
  cancelled_by: 'user',
  voided_by: 'user',
  approved_by: 'user',
  product_id: 'product',
  customer_id: 'customer',
  supplier_id: 'supplier',
  dealer_id: 'dealer',
  product_color_id: 'color',
  color_id: 'color',
  variant_id: 'variant',
  inventory_item_id: 'inventory_item',
  item_ids: 'inventory_item',
  sale_id: 'sale',
  original_sale_id: 'sale',
  new_sale_id: 'sale',
  invoice_id: 'invoice',
  purchase_invoice_id: 'invoice',
  invoice_box_id: 'box',
  box_id: 'box',
  transfer_id: 'transfer',
  expense_id: 'expense',
  loan_id: 'loan',
  shift_id: 'shift',
  intake_id: 'stock_intake',
  stock_count_id: 'stock_count',
  return_id: 'customer_return',
  recurring_id: 'recurring_expense',
  box_template_id: 'box_template',
};

/**
 * `category_id` means two unrelated things depending on where it came from, and
 * guessing wrong would name an expense category on a product row. Resolved by module.
 */
const CATEGORY_BY_MODULE = {
  expenses: 'expense_category',
  products: 'product_category',
  catalog: 'product_category',
  inventory: 'product_category',
  stock_counts: 'product_category',
};

/** entity_type on the log row itself → source. Drives the Entity column. */
const ENTITY_SOURCES = {
  store: 'store',
  user: 'user',
  product: 'product',
  variant: 'variant',
  color: 'color',
  image: null,
  sale: 'sale',
  payment: null,
  invoice: 'invoice',
  box: 'box',
  transfer: 'transfer',
  customer: 'customer',
  supplier: 'supplier',
  dealer: 'dealer',
  expense: 'expense',
  expense_category: 'expense_category',
  recurring_expense: 'recurring_expense',
  product_category: 'product_category',
  loan: 'loan',
  loan_payment: 'loan_payment',
  shift: 'shift',
  stock_count: 'stock_count',
  stock_intake: 'stock_intake',
  exchange: 'exchange',
  discount_request: 'discount_request',
  customer_return: 'customer_return',
  supplier_return: 'supplier_return',
  inventory_item: 'inventory_item',
  box_template: 'box_template',
  notification: 'notification',
  seller_code: 'user',
  store_price: null,
  session: null,
  page: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);

/**
 * Walk one row's details and collect every id worth naming, as [source, id] pairs.
 * Recurses one level into arrays and nested objects (sale items, box items), which is
 * where product_id and variant_id actually live.
 */
function collectFromDetails(details, module, out, depth = 0) {
  if (!details || typeof details !== 'object' || depth > 2) return;

  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value)) {
      const source = key === 'category_id' ? CATEGORY_BY_MODULE[module] : FIELD_SOURCES[key];
      if (source) {
        value.filter(isUuid).forEach((v) => out.push([source, v]));
      }
      value.forEach((v) => {
        if (v && typeof v === 'object') collectFromDetails(v, module, out, depth + 1);
      });
      continue;
    }
    if (value && typeof value === 'object') {
      collectFromDetails(value, module, out, depth + 1);
      continue;
    }
    if (!isUuid(value)) continue;

    const source = key === 'category_id' ? CATEGORY_BY_MODULE[module] : FIELD_SOURCES[key];
    if (source) out.push([source, value]);
  }
}

/**
 * Resolve every id mentioned across a page of activity rows into a flat
 * `{ id: label }` map, in one batched query per source table.
 *
 * Never throws: the audit page showing raw ids is a poor result, but failing to load
 * because a lookup table changed shape is a worse one.
 */
async function resolveNames(rows) {
  const wanted = new Map(); // source -> Set<id>

  const want = (source, id) => {
    if (!source || !isUuid(id) || !SOURCES[source]) return;
    if (!wanted.has(source)) wanted.set(source, new Set());
    wanted.get(source).add(id);
  };

  for (const row of rows) {
    // The Entity column — the user-visible "store #10748133".
    const entitySource = ENTITY_SOURCES[row.entity_type];
    if (entitySource) want(entitySource, row.entity_id);

    const pairs = [];
    collectFromDetails(row.details, row.module, pairs);
    pairs.forEach(([s, id]) => want(s, id));
  }

  const names = {};
  await Promise.all([...wanted.entries()].map(async ([source, ids]) => {
    const def = SOURCES[source];
    try {
      const found = await db(def.table).whereIn('id', [...ids]).select(def.columns);
      for (const r of found) {
        const label = def.label(r);
        if (label) names[r.id] = label;
      }
    } catch { /* a missing table must not take the page down */ }
  }));

  return names;
}

module.exports = { resolveNames, SOURCES, FIELD_SOURCES, ENTITY_SOURCES, CATEGORY_BY_MODULE };
