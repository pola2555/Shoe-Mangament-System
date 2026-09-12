const { Router } = require('express');
const Joi = require('joi');
const service = require('./stock-counts.service');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');

const createSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  scope: Joi.string().valid('full', 'category', 'product').default('full'),
  category_id: Joi.string().uuid().allow(null, ''),
  product_id: Joi.string().uuid().allow(null, ''),
  counted_at: Joi.date().allow(null, ''),
  notes: Joi.string().max(1000).allow('', null),
});

const countsSchema = Joi.object({
  lines: Joi.array().items(Joi.object({
    variant_id: Joi.string().uuid().required(),
    // null is meaningful: "not counted", which posting skips. It is NOT zero.
    counted_qty: Joi.number().integer().min(0).max(100000).allow(null, ''),
    notes: Joi.string().max(300).allow('', null),
  })).max(5000).required(),
});

const addLineSchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  counted_qty: Joi.number().integer().min(0).max(100000).allow(null),
  notes: Joi.string().max(300).allow('', null),
});

const router = Router();
router.use(auth);

const canRead = permission('inventory', 'read');
const canWrite = permission('stock_count', 'write');

async function assertCanTouch(req, id) {
  const count = await db('stock_counts').where('id', id).first();
  if (!count) throw new AppError('Stock count not found', 404);
  if (!userHasStoreAccess(req.user, count.store_id)) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
  return count;
}

router.get('/', canRead, async (req, res, next) => {
  try {
    const { store_id: _s, store_ids: _si, ...rest } = req.query;
    const scope = resolveStoreScope(req.user, req.query);
    res.json({ success: true, data: await service.list({ ...rest, ...scope }) });
  } catch (error) { next(error); }
});

router.post('/', canWrite, validate(createSchema), async (req, res, next) => {
  try {
    if (!userHasStoreAccess(req.user, req.body.store_id)) {
      throw new AppError('Access denied: you are not assigned to this store', 403);
    }
    res.status(201).json({ success: true, data: await service.create(req.body, req.user.id) });
  } catch (error) { next(error); }
});

router.get('/:id', canRead, async (req, res, next) => {
  try {
    const scope = resolveStoreScope(req.user, req.query);
    res.json({ success: true, data: await service.getById(req.params.id, scope) });
  } catch (error) { next(error); }
});

router.put('/:id/counts', canWrite, validate(countsSchema), async (req, res, next) => {
  try {
    await assertCanTouch(req, req.params.id);
    res.json({ success: true, data: await service.setCounts(req.params.id, req.body.lines) });
  } catch (error) { next(error); }
});

router.post('/:id/lines', canWrite, validate(addLineSchema), async (req, res, next) => {
  try {
    await assertCanTouch(req, req.params.id);
    res.status(201).json({ success: true, data: await service.addLine(req.params.id, req.body) });
  } catch (error) { next(error); }
});

router.post('/:id/post', canWrite, async (req, res, next) => {
  try {
    await assertCanTouch(req, req.params.id);
    res.json({ success: true, data: await service.post(req.params.id, req.user.id) });
  } catch (error) { next(error); }
});

router.post('/:id/cancel', canWrite, async (req, res, next) => {
  try {
    await assertCanTouch(req, req.params.id);
    res.json({ success: true, data: await service.cancel(req.params.id) });
  } catch (error) { next(error); }
});

module.exports = router;
