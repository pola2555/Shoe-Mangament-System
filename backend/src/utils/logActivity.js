const db = require('../config/database');
const { generateUUID } = require('./generateCodes');

/**
 * Log an activity to the audit trail.
 * Fire-and-forget — errors are caught silently to never block the main operation.
 *
 * @param {Object} params
 * @param {string} params.userId - Who performed the action
 * @param {string} params.action - Action type: create, update, delete, login, logout, ship, receive, cancel, complete, deactivate, activate, upload, set_permissions, reset_password, mark_damaged, refund
 * @param {string} params.module - Module: users, products, inventory, sales, purchases, transfers, dealers, expenses, stores, returns, auth, customers, suppliers, notifications
 * @param {string} [params.entityId] - ID of the affected record
 * @param {string} [params.entityType] - Type: user, product, variant, color, image, invoice, box, sale, payment, transfer, dealer, expense, store, customer, supplier, return, notification
 * @param {Object} [params.details] - Contextual data (what changed, etc.)
 * @param {string} [params.storeId] - Store context
 * @param {string} [params.ipAddress] - Request IP
 */
function logActivity({ userId, action, module, entityId, entityType, details, storeId, ipAddress }) {
  db('activity_log')
    .insert({
      id: generateUUID(),
      user_id: userId || null,
      action,
      module,
      entity_id: entityId || null,
      entity_type: entityType || null,
      details: details ? JSON.stringify(details) : null,
      store_id: storeId || null,
      ip_address: ipAddress || null,
    })
    .catch(() => {});
}

module.exports = logActivity;
