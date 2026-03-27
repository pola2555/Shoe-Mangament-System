const transfersService = require('./transfers.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');

class TransfersController {
  async list(req, res, next) {
    try {
      const filters = { ...req.query };
      // Non-admin users only see transfers involving their store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        if (req.user.assigned_stores?.length > 0) {
          filters.store_ids = req.user.assigned_stores;
        } else {
          filters.store_id = req.user.store_id;
        }
      }
      const transfers = await transfersService.list(filters);
      res.json({ success: true, data: transfers });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const transfer = await transfersService.getById(req.params.id);
      // Verify user has access to source or destination store
      if (!userHasStoreAccess(req.user, transfer.from_store_id) && !userHasStoreAccess(req.user, transfer.to_store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.from_store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const transfer = await transfersService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async ship(req, res, next) {
    try {
      // Verify user has access to source store
      const existing = await transfersService.getById(req.params.id);
      if (!userHasStoreAccess(req.user, existing.from_store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const transfer = await transfersService.ship(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async receive(req, res, next) {
    try {
      // Verify user has access to the destination store
      const transfer = await transfersService.getById(req.params.id);
      if (!userHasStoreAccess(req.user, transfer.to_store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const result = await transfersService.receive(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async cancel(req, res, next) {
    try {
      // Verify user has access to source store
      const existing = await transfersService.getById(req.params.id);
      if (!userHasStoreAccess(req.user, existing.from_store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const transfer = await transfersService.cancel(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }
}

module.exports = new TransfersController();
