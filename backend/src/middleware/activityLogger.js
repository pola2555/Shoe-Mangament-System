const logActivity = require('../utils/logActivity');

/**
 * Express middleware that logs activity after a successful response.
 * Attach AFTER the controller handler to capture the result.
 *
 * Usage in routes:
 *   router.post('/', permission('products', 'write'), controller.create, activityLogger('create', 'products', 'product'));
 *
 * Or use as a response interceptor on the app level for automatic logging.
 */

/**
 * Map HTTP method + path patterns to action/module/entity info.
 * This runs as an app-level middleware that intercepts res.json.
 */
function activityLoggerMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Only log successful write operations
    if (body && body.success && req.method !== 'GET') {
      const info = resolveActivityInfo(req);
      if (info) {
        const entityId = body.data?.id || req.params?.id || req.params?.boxId || null;
        logActivity({
          userId: req.user?.id,
          action: info.action,
          module: info.module,
          entityId: entityId,
          entityType: info.entityType,
          details: buildDetails(req, body, info),
          storeId: req.user?.store_id || body.data?.store_id || null,
          ipAddress: req.ip,
        });
      }
    }
    return originalJson(body);
  };

  next();
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

  // Module routing
  const moduleMap = {
    auth: { module: 'auth', entityType: 'session' },
    users: { module: 'users', entityType: 'user' },
    stores: { module: 'stores', entityType: 'store' },
    products: { module: 'products', entityType: 'product' },
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
    else if (path.includes('/boxes') && path.includes('/items')) { result.action = 'set_items'; result.entityType = 'box'; }
    else if (path.includes('/boxes')) { result.entityType = 'box'; }
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
    if (path.includes('/payments') && path.includes('/images')) { result.entityType = 'payment_image'; result.action = 'upload'; }
    else if (path.includes('/payments')) { result.entityType = 'payment'; }
  }
  if (base === 'dealers') {
    if (path.includes('/invoices')) { result.entityType = 'dealer_invoice'; }
    else if (path.includes('/payments')) { result.entityType = 'dealer_payment'; }
  }
  if (base === 'returns') {
    if (path.includes('/customer')) { result.entityType = 'customer_return'; }
    else if (path.includes('/supplier')) { result.entityType = 'supplier_return'; }
  }
  if (base === 'auth') {
    if (path.includes('/login')) { result.action = 'login'; }
    else if (path.includes('/logout')) { result.action = 'logout'; }
    else return null; // don't log refresh
  }

  return result;
}

function buildDetails(req, body, info) {
  const details = {};

  // Include relevant body fields (but never passwords)
  if (req.body) {
    const safeBody = { ...req.body };
    delete safeBody.password;
    delete safeBody.currentPassword;
    delete safeBody.newPassword;
    delete safeBody.password_hash;
    delete safeBody.refreshToken;

    // Only include a subset of keys to keep details small
    const keys = Object.keys(safeBody);
    if (keys.length <= 10) {
      Object.assign(details, safeBody);
    } else {
      // Just record the keys that were changed
      details.fields = keys;
    }
  }

  // Add useful identifiers
  if (body.data?.sale_number) details.sale_number = body.data.sale_number;
  if (body.data?.invoice_number) details.invoice_number = body.data.invoice_number;
  if (body.data?.transfer_number) details.transfer_number = body.data.transfer_number;
  if (body.data?.username) details.username = body.data.username;

  return Object.keys(details).length > 0 ? details : null;
}

module.exports = activityLoggerMiddleware;
