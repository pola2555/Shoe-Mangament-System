const { Router } = require('express');
const Joi = require('joi');
const service = require('./discounts.service');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');

const requestSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  items: Joi.array().items(Joi.object({
    id: Joi.string().uuid().required(),
    sale_price: Joi.number().precision(2).min(0).allow(null),
  })).min(1).max(200).required(),
  // Exactly one of these, decided by `kind`. A discount request asks to give away
  // margin; a credit request asks to let the customer walk out owing money.
  kind: Joi.string().valid('discount', 'credit').default('discount'),
  requested_discount: Joi.number().precision(2).greater(0).max(999999999)
    .when('kind', { is: 'credit', then: Joi.forbidden(), otherwise: Joi.required() }),
  requested_credit: Joi.number().precision(2).greater(0).max(999999999)
    .when('kind', { is: 'credit', then: Joi.required(), otherwise: Joi.forbidden() }),
  customer_id: Joi.string().uuid().allow(null, ''),
  reason: Joi.string().max(500).allow('', null),
});

const decideSchema = Joi.object({
  approve: Joi.boolean().required(),
  // Left out on an approval, the full requested amount is granted. A manager can grant
  // less, which is the common real answer to "can I give 100 off?".
  amount: Joi.number().precision(2).min(0).max(999999999).allow(null),
  note: Joi.string().max(500).allow('', null),
  // Sent on the SECOND attempt, after the server has refused once and told the manager
  // how far under the floor they are going. Deliberately a repeat action rather than a
  // box that is ticked before the numbers are known.
  acknowledge_below_min: Joi.boolean().default(false),
});

const codeSchema = Joi.object({
  code: Joi.string().min(3).max(20).required(),
});

const router = Router();
router.use(auth);

// Asking is part of selling. Answering is a separate, deliberate permission.
const canAsk = permission('pos', 'write');
/**
 * Either approver may reach the endpoint; the service then checks the one that matches
 * the request's kind. Gating the route on `discount_approval` alone would have locked
 * out somebody trusted with pay-later and nothing else.
 */
const canDecide = (req, res, next) => {
  if (req.user.role_name === 'admin') return next();
  const p = req.user.permissions || {};
  if (p.discount_approval === 'write' || p.credit_approval === 'write') return next();
  return next(new AppError('Access denied: you cannot answer these requests', 403));
};
const canManageCodes = permission('seller_codes', 'write');

router.get('/', permission('pos', 'read'), async (req, res, next) => {
  try {
    const { store_id: _s, store_ids: _si, ...rest } = req.query;
    const scope = resolveStoreScope(req.user, req.query);
    const data = await service.list({ ...rest, ...scope, user: req.user });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/', canAsk, validate(requestSchema), async (req, res, next) => {
  try {
    if (!userHasStoreAccess(req.user, req.body.store_id)) {
      throw new AppError('Access denied: you are not assigned to this store', 403);
    }
    res.status(201).json({ success: true, data: await service.request(req.body, req.user) });
  } catch (error) { next(error); }
});

// Fixed paths before /:id.
router.get('/sellers', permission('pos', 'read'), async (req, res, next) => {
  try {
    if (!req.query.store_id) throw new AppError('store_id is required', 400);
    if (!userHasStoreAccess(req.user, req.query.store_id)) {
      throw new AppError('Access denied: you are not assigned to this store', 403);
    }
    res.json({ success: true, data: await service.sellersAt(req.query.store_id) });
  } catch (error) { next(error); }
});

router.put('/sellers/:userId/code', canManageCodes, validate(codeSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.setSellerCode(req.params.userId, req.body.code) });
  } catch (error) { next(error); }
});

router.delete('/sellers/:userId/code', canManageCodes, async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.clearSellerCode(req.params.userId) });
  } catch (error) { next(error); }
});

router.get('/:id', permission('pos', 'read'), async (req, res, next) => {
  try {
    // Pass the user so getById can refuse another branch's request — see the service.
    res.json({ success: true, data: await service.getById(req.params.id, req.user) });
  } catch (error) { next(error); }
});

router.post('/:id/decide', canDecide, validate(decideSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.decide(req.params.id, req.body, req.user) });
  } catch (error) { next(error); }
});

router.post('/:id/cancel', canAsk, async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.cancel(req.params.id, req.user) });
  } catch (error) { next(error); }
});

router.get('/:id/resume', canAsk, async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.resume(req.params.id, req.user) });
  } catch (error) { next(error); }
});

module.exports = router;
