const Joi = require('joi');

const listInventorySchema = Joi.object({
  store_id: Joi.string().uuid(),
  product_id: Joi.string().uuid(),
  variant_id: Joi.string().uuid(),
  status: Joi.string().valid('in_stock', 'sold', 'returned', 'damaged', 'in_transfer'),
  source: Joi.string().valid('purchase', 'manual'),
  search: Joi.string().max(100),
}).unknown(true);

const manualEntrySchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  cost: Joi.number().precision(2).min(0).required(),
  quantity: Joi.number().integer().min(1).max(100).required(),
  notes: Joi.string().allow('', null),
});

module.exports = { listInventorySchema, manualEntrySchema };
