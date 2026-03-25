const Joi = require('joi');

const createCustomerReturnSchema = Joi.object({
  sale_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  reason: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(500).allow('', null),
  refund_method: Joi.string().valid('cash', 'store_credit', 'card', 'exchange', 'other').required(),
  items: Joi.array().items(
    Joi.object({
      sale_item_id: Joi.string().uuid().required(),
      refund_amount: Joi.number().precision(2).min(0).max(999999999).required()
    })
  ).min(1).max(100).required()
});

const createSupplierReturnSchema = Joi.object({
  supplier_id: Joi.string().uuid().required(),
  reason: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(500).allow('', null),
  items: Joi.array().items(Joi.string().uuid()).min(1).max(200).required()
});

module.exports = {
  createCustomerReturnSchema,
  createSupplierReturnSchema
};
