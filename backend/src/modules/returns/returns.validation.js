const Joi = require('joi');

const createCustomerReturnSchema = Joi.object({
  sale_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  reason: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  refund_method: Joi.string().valid('cash', 'store_credit', 'card', 'exchange', 'other').required(),
  items: Joi.array().items(
    Joi.object({
      sale_item_id: Joi.string().uuid().required(),
      refund_amount: Joi.number().precision(2).min(0).required()
    })
  ).min(1).required()
});

const createSupplierReturnSchema = Joi.object({
  supplier_id: Joi.string().uuid().required(),
  reason: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  items: Joi.array().items(Joi.string().uuid()).min(1).required()
});

module.exports = {
  createCustomerReturnSchema,
  createSupplierReturnSchema
};
