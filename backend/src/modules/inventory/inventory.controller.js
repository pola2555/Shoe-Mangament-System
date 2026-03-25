const inventoryService = require('./inventory.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');

// Helper: verify user has access to the given store
async function verifyStoreAccess(user, storeId) {
  if (user.role_name === 'admin' || user.permissions?.all_stores) return;
  const assignment = await db('user_stores')
    .where({ user_id: user.id, store_id: storeId })
    .first();
  if (!assignment && user.store_id !== storeId) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
}

class InventoryController {
  async list(req, res, next) {
    try {
      const filters = { ...req.query };
      // Enforce store scoping for non-admin users
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        filters.store_id = req.user.store_id;
      }
      const items = await inventoryService.list(filters);
      res.json({ success: true, data: items });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const filters = { ...req.query };
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        filters.store_id = req.user.store_id;
      }
      const data = await inventoryService.summary(filters);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async manualEntry(req, res, next) {
    try {
      await verifyStoreAccess(req.user, req.body.store_id);
      const result = await inventoryService.manualEntry(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async markDamaged(req, res, next) {
    try {
      // Verify item is in user's store
      const item = await db('inventory_items').where('id', req.params.id).first();
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores && item.store_id !== req.user.store_id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const result = await inventoryService.markDamaged(req.params.id, req.body.notes);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }
}

module.exports = new InventoryController();
