const Joi = require('joi');

const createSaleSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  customer_id: Joi.string().uuid().allow(null),
  items: Joi.array().items(
    Joi.object({
      id: Joi.string().uuid().required(),
      sale_price: Joi.number().precision(2).min(0).allow(null, '')
    })
  ).min(1).required(),
  discount_amount: Joi.number().precision(2).min(0).default(0),
  notes: Joi.string().allow('', null),
  payments: Joi.array().items(
    Joi.object({
      amount: Joi.number().precision(2).min(0.01).required(),
      payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash', 'card').required(),
      reference_no: Joi.string().max(100).allow('', null),
    })
  ).min(1).required(),
});

const addPaymentSchema = Joi.object({
  amount: Joi.number().precision(2).min(0.01).required(),
  payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash', 'card').required(),
  reference_no: Joi.string().max(100).allow('', null),
});

module.exports = { createSaleSchema, addPaymentSchema };
