const { Router } = require('express');
const Joi = require('joi');
const service = require('./exchanges.service');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');

const createSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  original_sale_id: Joi.string().uuid().required(),
  // What comes back. refund_amount is optional — left out, the line is credited at what
  // it actually sold for after its share of any discount, which is the right answer
  // almost always and the one a person would have to work out by hand otherwise.
  returned: Joi.array().items(Joi.object({
    sale_item_id: Joi.string().uuid().required(),
    refund_amount: Joi.number().precision(2).min(0).allow(null),
  })).min(1).max(100).required(),
  // What goes out. Ordinary inventory items: a different size and a different product
  // are the same thing here.
  new_items: Joi.array().items(Joi.object({
    id: Joi.string().uuid().required(),
    sale_price: Joi.number().precision(2).min(0).allow(null),
  })).min(1).max(100).required(),
  settlement: Joi.string().valid(...service.SETTLEMENTS),
  // Optional by design: most exchanges are "wrong size", and a required dropdown just
  // fills the column with whatever is first in the list.
  reason: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(1000).allow('', null),
  customer_id: Joi.string().uuid().allow(null, ''),
  discount_request_id: Joi.string().uuid().allow(null, ''),
  seller_code: Joi.string().max(50).allow('', null),
  sold_by: Joi.string().uuid().allow(null, ''),
});

const router = Router();
router.use(auth);

const canRead = permission('exchanges', 'read');
const canWrite = permission('exchanges', 'write');

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
    const data = await service.create(req.body, req.user);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/:id', canRead, async (req, res, next) => {
  try {
    const scope = resolveStoreScope(req.user, req.query);
    res.json({ success: true, data: await service.getById(req.params.id, scope) });
  } catch (error) { next(error); }
});

module.exports = router;
