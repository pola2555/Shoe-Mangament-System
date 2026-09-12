const logActivity = require('../utils/logActivity');
const db = require('../config/database');
const { findDeleteTarget } = require('./auditTargets');

/**
 * THE AUDIT TRAIL.
 *
 * App-level: wraps res.json and records every successful write. Runs BEFORE the
 * per-router `auth`, so `req.user` is empty here but populated by the time the wrapper
 * fires — which is why the user is read inside res.json, not out here.
 *
 * Three things this used to get wrong, all fixed below:
 *
 *   1. A DELETE has no request body, and the log was built entirely from the body — so
 *      every delete recorded `details: null`. See auditTargets.js: the target row is now
 *      read and summarised BEFORE the handler destroys it.
 *   2. A request body carries ids, never names, so the log read
 *      `store_id: 10748133-4451-…`. Names are resolved when the log is READ
 *      (audit-log.service.js) rather than written: it costs nothing on the hot path, it
 *      fixes the rows already stored, and a delete keeps its own snapshot for the case
 *      where the record no longer exists to resolve.
 *   3. Half the app was not logged at all. The module map covered fifteen mounts; the
 *      till, the cash drawer, exchanges, stock counts, stock intakes, discounts, loans,
 *      barcodes and seller codes were invisible — including the owner taking money out
 *      of the drawer, which is exactly what an audit trail is for.
 */

function activityLoggerMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Only log successful write operations
    if (body && body.success && req.method !== 'GET') {
      const info = resolveActivityInfo(req);
      if (info) {
        const entityId = resolveEntityId(req, body, info);
        logActivity({
          userId: req.user?.id,
          action: info.action,
          module: info.module,
          entityId,
          entityType: info.entityType,
          details: buildDetails(req, body, info),
          storeId: resolveStoreId(req, body),
          ipAddress: req.ip,
        });
      }
    }
    return originalJson(body);
  };

  // A delete destroys the evidence, so read it first. Confined to paths that are
  // actually delete targets, and to requests carrying a token, so an unauthenticated
  // probe cannot make the server run queries.
  if (req.method === 'DELETE' && req.headers.authorization) {
    captureDeleteSnapshot(req)
      .then((snap) => { req._auditSnapshot = snap; })
      .catch(() => { /* the log must never be the reason a delete fails */ })
      .finally(() => next());
    return;
  }

  next();
}

/**
 * Read the row a DELETE is about to remove.
 * Never throws: a failure here loses detail, and must never lose the delete.
 */
async function captureDeleteSnapshot(req) {
  const pathname = req.originalUrl.replace(/\?.*$/, '');
  const found = findDeleteTarget(pathname);
  if (!found) return null;

  const { target, match } = found;
  const row = await db(target.table)
    .where(target.where(match))
    .select(target.columns)
    .first();

  return row ? { table: target.table, entityType: target.entityType, row } : null;
}

function resolveEntityId(req, body, info) {
  if (info.entityIdFrom && req.params?.[info.entityIdFrom]) return req.params[info.entityIdFrom];
  return body.data?.id
    || req._auditSnapshot?.row?.id
    || req.params?.id
    || req.params?.boxId
    || null;
}

/**
 * The store the action AFFECTED — not the actor's home branch.
 *
 * It used to be `req.user.store_id`, so a sale rung at branch B by a head-office user
 * was filed under nothing, and a transfer was filed under wherever the person happened
 * to be based. The Store column on the audit page was quietly describing the wrong
 * thing, which is worse than leaving it blank.
 */
function resolveStoreId(req, body) {
  return body.data?.store_id
    || req.body?.store_id
    || req.body?.from_store_id
    || req._auditSnapshot?.row?.store_id
    || req.query?.store_id
    || req.user?.store_id
    || null;
}

function resolveActivityInfo(req) {
  const method = req.method;
  const path = req.originalUrl.replace(/\?.*$/, ''); // strip query params
  const segments = path.replace('/api/', '').split('/').filter(Boolean);

  // Determine action from HTTP method
  let action;
  if (method === 'POST') action = 'create';
  else if (method === 'PUT' || method === 'PATCH') action = 'update';
  else if (method === 'DELETE') action = 'delete';
  else return null;

  // Module routing. Every mount in app.js appears here — a missing entry means the
  // whole module goes unaudited, silently, which is how the till and the cash drawer
  // were invisible until 2026-09-03.
  const moduleMap = {
    auth: { module: 'auth', entityType: 'session' },
    users: { module: 'users', entityType: 'user' },
    stores: { module: 'stores', entityType: 'store' },
    products: { module: 'products', entityType: 'product' },
    'product-categories': { module: 'catalog', entityType: 'product_category' },
    'size-scales': { module: 'catalog', entityType: 'size_scale' },
    'color-presets': { module: 'catalog', entityType: 'color_preset' },
    'box-templates': { module: 'products', entityType: 'box_template' },
    suppliers: { module: 'suppliers', entityType: 'supplier' },
    purchases: { module: 'purchases', entityType: 'invoice' },
    inventory: { module: 'inventory', entityType: 'inventory_item' },
    transfers: { module: 'transfers', entityType: 'transfer' },
    customers: { module: 'customers', entityType: 'customer' },
    sales: { module: 'sales', entityType: 'sale' },
    dealers: { module: 'dealers', entityType: 'dealer' },
    expenses: { module: 'expenses', entityType: 'expense' },
    returns: { module: 'returns', entityType: 'return' },
    notifications: { module: 'notifications', entityType: 'notification' },
    loans: { module: 'loans', entityType: 'loan' },
    barcodes: { module: 'barcodes', entityType: 'variant' },
    'stock-intakes': { module: 'stock_intakes', entityType: 'stock_intake' },
    shifts: { module: 'shifts', entityType: 'shift' },
    exchanges: { module: 'exchanges', entityType: 'exchange' },
    'stock-counts': { module: 'stock_counts', entityType: 'stock_count' },
    discounts: { module: 'discounts', entityType: 'discount_request' },
  };

  const base = segments[0];
  const info = moduleMap[base];
  if (!info) return null;

  let result = { ...info, action };

  // Refine based on sub-paths
  if (base === 'users') {
    if (path.includes('/permissions')) { result.action = 'set_permissions'; result.entityType = 'user'; }
    else if (path.includes('/change-password')) { result.action = 'change_password'; result.entityType = 'user'; }
    else if (path.includes('/stores')) { result.action = 'set_stores'; result.entityType = 'user'; }
    else if (method === 'DELETE') { result.action = 'deactivate'; }
  }
  if (base === 'stores') {
    if (path.includes('/staff')) { result.action = 'set_staff'; }
    else if (path.includes('/prices')) { result.action = method === 'DELETE' ? 'clear_price' : 'set_price'; result.entityType = 'store_price'; }
  }
  if (base === 'products') {
    if (path.includes('/colors') && path.includes('/images')) { result.entityType = 'image'; result.action = 'upload'; }
    else if (path.includes('/images') && path.includes('/primary')) { result.entityType = 'image'; result.action = 'update'; }
    else if (path.includes('/images') && method === 'DELETE') { result.entityType = 'image'; }
    else if (path.includes('/colors')) { result.entityType = 'color'; }
    else if (path.includes('/variants/bulk')) { result.entityType = 'variant'; result.action = 'bulk_create'; }
    else if (path.includes('/variants')) { result.entityType = 'variant'; }
    else if (path.includes('/prices')) { result.entityType = 'store_price'; }
    else if (path.includes('/toggle-active')) { result.action = 'toggle_active'; }
  }
  if (base === 'purchases') {
    if (path.includes('/boxes') && path.includes('/complete')) { result.action = 'complete'; result.entityType = 'box'; }
    else if (path.includes('/boxes') && path.includes('/duplicate')) { result.action = 'duplicate'; result.entityType = 'box'; }
    else if (path.includes('/boxes') && path.includes('/items')) { result.action = 'set_items'; result.entityType = 'box'; }
    else if (path.includes('/boxes')) { result.entityType = 'box'; result.entityIdFrom = 'boxId'; }
    else if (path.includes('/withdrawals')) { result.entityType = 'withdrawal'; }
    else if (path.includes('/payments') && path.includes('/images')) { result.entityType = 'payment_image'; result.action = 'upload'; }
    else if (path.includes('/payments')) { result.entityType = 'payment'; }
    else if (path.includes('/images')) { result.entityType = 'invoice_image'; result.action = method === 'DELETE' ? 'delete' : 'upload'; }
  }
  if (base === 'transfers') {
    if (path.includes('/ship')) result.action = 'ship';
    else if (path.includes('/receive')) result.action = 'receive';
    else if (path.includes('/cancel')) result.action = 'cancel';
  }
  if (base === 'inventory') {
    if (path.includes('/manual')) { result.action = 'manual_entry'; }
    else if (path.includes('/damaged')) { result.action = 'mark_damaged'; }
  }
  if (base === 'sales') {
    if (path.includes('/void')) { result.action = 'void'; }
    else if (path.includes('/payments') && path.includes('/images')) { result.entityType = 'payment_image'; result.action = 'upload'; }
    else if (path.includes('/payments')) { result.entityType = 'payment'; result.action = 'add_payment'; }
  }
  if (base === 'dealers') {
    if (path.includes('/invoices')) { result.entityType = 'dealer_invoice'; }
    else if (path.includes('/payments')) { result.entityType = 'dealer_payment'; }
  }
  if (base === 'returns') {
    if (path.includes('/customer')) { result.entityType = 'customer_return'; }
    else if (path.includes('/supplier')) { result.entityType = 'supplier_return'; }
  }
  if (base === 'expenses') {
    if (path.includes('/categories')) { result.entityType = 'expense_category'; }
    else if (path.includes('/recurring') && path.includes('/post')) { result.action = 'post_recurring'; result.entityType = 'expense'; }
    else if (path.includes('/recurring')) { result.entityType = 'recurring_expense'; }
    else if (path.includes('/budgets')) { result.entityType = 'budget'; }
    else if (path.includes('/receipts')) { result.entityType = 'expense_receipt'; }
  }
  if (base === 'loans') {
    if (path.includes('/images')) { result.entityType = 'loan_payment_proof'; result.action = method === 'DELETE' ? 'delete' : 'upload'; }
    else if (path.includes('/payments')) { result.entityType = 'loan_payment'; }
    else if (path.includes('/installments')) { result.entityType = 'installment_plan'; }
  }
  if (base === 'shifts') {
    // The drawer. Every one of these moves cash, and none of them was audited before.
    if (path.includes('/movements')) { result.action = 'cash_movement'; result.entityType = 'cash_movement'; }
    else if (path.includes('/close')) { result.action = 'close_shift'; }
    else if (path.includes('/reopen')) { result.action = 'reopen_shift'; }
    else if (method === 'POST') { result.action = 'open_shift'; }
  }
  if (base === 'stock-counts') {
    if (path.includes('/post')) result.action = 'post_count';
    else if (path.includes('/cancel')) result.action = 'cancel';
    else if (path.includes('/counts') || path.includes('/lines')) result.action = 'enter_counts';
  }
  if (base === 'stock-intakes') {
    if (path.includes('/post')) result.action = 'post_intake';
    else if (path.includes('/cancel')) result.action = 'cancel';
    else if (path.includes('/revert')) { result.action = 'revert_correction'; result.entityType = 'cost_correction'; }
    else if (path.includes('/recost')) { result.action = 'recost'; result.entityType = 'product'; }
  }
  if (base === 'discounts') {
    // A seller code is a credential. Record that it changed and for whom; the code
    // itself is filtered out of the details below.
    if (path.includes('/sellers') && path.includes('/code')) {
      result.action = method === 'DELETE' ? 'clear_seller_code' : 'set_seller_code';
      result.entityType = 'seller_code';
      result.entityIdFrom = 'userId';
    } else if (path.includes('/decide')) { result.action = 'decide_discount'; }
    else if (path.includes('/cancel')) { result.action = 'cancel'; }
  }
  if (base === 'barcodes') {
    if (path.includes('/assign')) result.action = 'assign';
    else if (path.includes('/link')) result.action = 'link';
    else if (method === 'DELETE') { result.action = 'clear_barcode'; result.entityIdFrom = 'variantId'; }
  }
  if (base === 'auth') {
    if (path.includes('/login')) { result.action = 'login'; }
    else if (path.includes('/logout')) { result.action = 'logout'; }
    else if (path.includes('/preferences')) { result.action = 'set_preferences'; result.entityType = 'user'; }
    else return null; // don't log refresh
  }

  return result;
}

/**
 * Fields that must never reach the log.
 *
 * `seller_code` is the one that matters most and was missing: PLAN 3 accepts it in the
 * body of every sale and exchange, and it is bcrypt-hashed in `users.seller_code_hash`
 * precisely because it is a credential said out loud across a counter. Copying the
 * plaintext into a table any `audit_log:read` holder can page through would have
 * undone that the moment a branch switched passcodes on.
 */
const SENSITIVE_FIELDS = new Set([
  'password', 'currentPassword', 'newPassword', 'password_hash',
  'refreshToken', 'token', 'access_token', 'refresh_token',
  'authorization', 'cookie', 'secret', 'api_key',
  'credit_card', 'card_number', 'cvv', 'ssn',
  'seller_code', 'code', 'pin', 'passcode', 'seller_code_hash',
]);

/**
 * Drop every sensitive key, at any depth.
 *
 * The scrub used to look only at top-level keys — safe today, because every credential
 * this API accepts (seller_code, password, pin, tokens) sits at the top of its payload.
 * But it was one nested field away from writing a secret to the audit log in plaintext:
 * the first endpoint to accept `{ credentials: { password } }` would have leaked it.
 * Recursing closes that before it can happen. Depth-limited so a pathological payload
 * cannot hang the logger.
 */
function scrubSensitive(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    out[key] = v && typeof v === 'object' ? scrubSensitive(v, depth + 1) : v;
  }
  return out;
}

function buildDetails(req, body, info) {
  const details = {};

  if (req.body) {
    const safeBody = scrubSensitive(req.body);

    // Only include a subset of keys to keep details small
    const keys = Object.keys(safeBody);
    if (keys.length <= 10) {
      Object.assign(details, safeBody);
    } else {
      // Just record the keys that were changed
      details.fields = keys;
    }
  }

  // What the delete destroyed. Kept under its own key so the reader can tell a
  // snapshot of a vanished record from the request that removed it.
  if (req._auditSnapshot?.row) {
    details.deleted = req._auditSnapshot.row;
    if (req._auditSnapshot.entityType) details.deleted_type = req._auditSnapshot.entityType;
  }

  // Add useful identifiers
  if (body.data?.sale_number) details.sale_number = body.data.sale_number;
  if (body.data?.invoice_number) details.invoice_number = body.data.invoice_number;
  if (body.data?.transfer_number) details.transfer_number = body.data.transfer_number;
  if (body.data?.intake_number) details.intake_number = body.data.intake_number;
  if (body.data?.shift_number) details.shift_number = body.data.shift_number;
  if (body.data?.count_number) details.count_number = body.data.count_number;
  if (body.data?.request_number) details.request_number = body.data.request_number;
  if (body.data?.username) details.username = body.data.username;

  return Object.keys(details).length > 0 ? details : null;
}

module.exports = activityLoggerMiddleware;
module.exports.resolveActivityInfo = resolveActivityInfo;
module.exports.SENSITIVE_FIELDS = SENSITIVE_FIELDS;
// Exported so the security check can prove a nested credential is dropped.
module.exports.scrubSensitive = scrubSensitive;
