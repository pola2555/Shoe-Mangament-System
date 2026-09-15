const service = require('./stock-intakes.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');

/**
 * Every list route re-derives the store filter from the user rather than trusting the
 * query, and every :id route checks the sheet's own branch. A sheet creates stock, so
 * reaching one you are not assigned to would mean putting stock on somebody else's
 * shelf.
 */
function scopeOf(req) {
  const { store_id: _s, store_ids: _si, ...rest } = req.query;
  return { rest, scope: resolveStoreScope(req.user, req.query) };
}

async function assertCanTouch(req, id) {
  const intake = await db('stock_intakes').where('id', id).first();
  if (!intake) throw new AppError('Stock intake not found', 404);
  if (!userHasStoreAccess(req.user, intake.store_id)) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
  return intake;
}

class StockIntakesController {
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

  async create(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      const intake = await service.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: intake });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      // Moving a sheet to a branch the caller cannot reach is the same hole as creating
      // one there, so the destination is checked too.
      if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      res.json({ success: true, data: await service.update(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      await service.delete(req.params.id);
      res.json({ success: true, message: 'Draft deleted' });
    } catch (error) { next(error); }
  }

  async post(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      res.json({ success: true, data: await service.post(req.params.id, req.user.id) });
    } catch (error) { next(error); }
  }

  async reverse(req, res, next) {
    try {
      await assertCanTouch(req, req.params.id);
      const data = await service.reverse(req.params.id, req.body?.reason, req.user.id, req.body?.reopen === true);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async costHint(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const data = await service.costHint(req.query.product_id, scope);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async estimatedSummary(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      res.json({ success: true, data: await service.estimatedSummary(scope) });
    } catch (error) { next(error); }
  }

  async recost(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const data = await service.recost(req.params.productId, { ...req.body, ...scope }, req.user.id);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async listCorrections(req, res, next) {
    try {
      res.json({ success: true, data: await service.listCorrections(req.query) });
    } catch (error) { next(error); }
  }

  async revertCorrection(req, res, next) {
    try {
      const data = await service.revertCorrection(req.params.batchId, req.user.id);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }
}

module.exports = new StockIntakesController();
