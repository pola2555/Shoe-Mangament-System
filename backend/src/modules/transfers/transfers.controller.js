const transfersService = require('./transfers.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');

// Helper: verify user has access to the given store
async function verifyStoreAccess(user, storeId) {
  if (user.role_name === 'admin' || user.permissions.all_stores) return;
  const assignment = await db('user_stores')
    .where({ user_id: user.id, store_id: storeId })
    .first();
  if (!assignment && user.store_id !== storeId) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
}

class TransfersController {
  async list(req, res, next) {
    try {
      const filters = { ...req.query };
      // Non-admin users only see transfers involving their store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        filters.store_id = req.user.store_id;
      }
      const transfers = await transfersService.list(filters);
      res.json({ success: true, data: transfers });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const transfer = await transfersService.getById(req.params.id);
      // Verify user has access to source or destination store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        await verifyStoreAccess(req.user, transfer.from_store_id).catch(() => null)
          || await verifyStoreAccess(req.user, transfer.to_store_id);
      }
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      await verifyStoreAccess(req.user, req.body.from_store_id);
      const transfer = await transfersService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async ship(req, res, next) {
    try {
      // Verify user has access to source store
      const existing = await transfersService.getById(req.params.id);
      await verifyStoreAccess(req.user, existing.from_store_id);
      const transfer = await transfersService.ship(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async receive(req, res, next) {
    try {
      // Verify user has access to the destination store
      const transfer = await transfersService.getById(req.params.id);
      await verifyStoreAccess(req.user, transfer.to_store_id);
      const result = await transfersService.receive(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async cancel(req, res, next) {
    try {
      // Verify user has access to source store
      const existing = await transfersService.getById(req.params.id);
      await verifyStoreAccess(req.user, existing.from_store_id);
      const transfer = await transfersService.cancel(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }
}

module.exports = new TransfersController();
