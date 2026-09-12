const service = require('./shifts.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');

function scopeOf(req) {
  const { store_id: _s, store_ids: _si, ...rest } = req.query;
  return { rest, scope: resolveStoreScope(req.user, req.query) };
}

/** A shift is a branch's drawer, so reaching one means being assigned to that branch. */
async function assertCanTouch(req, id) {
  const shift = await db('shifts').where('id', id).first();
  if (!shift) throw new AppError('Shift not found', 404);
  if (!userHasStoreAccess(req.user, shift.store_id)) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
  return shift;
}

class ShiftsController {
  async list(req, res, next) {
    try {
      const { rest, scope } = scopeOf(req);
      res.json({ success: true, ...(await service.list({ ...rest, ...scope })) });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      res.json({ success: true, data: await service.getById(req.params.id, scope) });
    } catch (error) { next(error); }
  }

  async current(req, res, next) {
    try {
      const storeId = req.query.store_id;
      if (!storeId) throw new AppError('store_id is required', 400);
      if (!userHasStoreAccess(req.user, storeId)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      res.json({ success: true, data: await service.current(storeId) });
    } catch (error) { next(error); }
  }

  async open(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      const shift = await service.open(req.body, req.user.id);
      res.status(201).json({ success: true, data: shift });
    } catch (error) { next(error); }
  }

  async close(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      res.json({ success: true, data: await service.close(req.params.id, req.body, req.user.id) });
    } catch (error) { next(error); }
  }

  async recount(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      res.json({ success: true, data: await service.recount(req.params.id, req.body, req.user.id) });
    } catch (error) { next(error); }
  }

  async reopen(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      res.json({ success: true, data: await service.reopen(req.params.id, req.user.id) });
    } catch (error) { next(error); }
  }

  async position(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      res.json({ success: true, data: await service.cashPosition(req.params.id) });
    } catch (error) { next(error); }
  }

  async addMovement(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      const row = await service.addMovement(req.body, req.user.id);
      res.status(201).json({ success: true, data: row });
    } catch (error) { next(error); }
  }

  async listMovements(req, res, next) {
    try {
      const { rest, scope } = scopeOf(req);
      res.json({ success: true, data: await service.listMovements({ ...rest, ...scope }) });
    } catch (error) { next(error); }
  }

  async unassignedCash(req, res, next) {
    try {
      const { rest, scope } = scopeOf(req);
      res.json({ success: true, data: await service.unassignedCash({ ...rest, ...scope }) });
    } catch (error) { next(error); }
  }
}

module.exports = new ShiftsController();
