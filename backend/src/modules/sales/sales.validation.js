const Joi = require('joi');

const createSaleSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  customer_id: Joi.string().uuid().allow(null),
  items: Joi.array().items(
    Joi.object({
      id: Joi.string().uuid().required(),
      sale_price: Joi.number().precision(2).min(0).max(999999999).allow(null)
    })
  ).min(1).max(200).required(),
  discount_amount: Joi.number().precision(2).min(0).max(999999999).default(0),
  // The manager approval this discount is being spent against. Only needed when the
  // person at the till may not grant one themselves.
  discount_request_id: Joi.string().uuid().allow(null, ''),
  // The manager's approval for leaving part of this sale unpaid. Same machinery as
  // the discount approval, different question — see migration 20260904_003.
  credit_request_id: Joi.string().uuid().allow(null, ''),
  // Whose sale this is, at a branch that asks. The code is compared against a bcrypt
  // hash server-side and never stored or logged.
  seller_code: Joi.string().max(50).allow('', null),
  sold_by: Joi.string().uuid().allow(null, ''),
  notes: Joi.string().max(500).allow('', null),
  payments: Joi.array().items(
    Joi.object({
      amount: Joi.number().precision(2).min(0.01).required(),
      payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash', 'card').required(),
      reference_no: Joi.string().max(100).allow('', null),
    })
  // May be empty: a registered customer can take the goods and pay later. The service
  // refuses that for a walk-in, where an unpaid balance would be owed by nobody.
  ).max(10).default([]),
});

const voidSaleSchema = Joi.object({
  // Why this sale never happened. Not required — but it is the only thing anyone will
  // have to go on later, so the UI asks for it.
  reason: Joi.string().max(500).allow('', null),
});

const updateSaleSchema = Joi.object({
  // Items and prices are deliberately absent. A sale is a receipt the customer holds
  // and a figure the shop banked; a mis-rung one is voided and rung again, which says
  // what happened instead of quietly rewriting it.
  customer_id: Joi.string().uuid().allow(null, ''),
  notes: Joi.string().max(500).allow('', null),
}).min(1);

const addPaymentSchema = Joi.object({
  amount: Joi.number().precision(2).min(0.01).required(),
  payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash', 'card').required(),
  reference_no: Joi.string().max(100).allow('', null),
});

module.exports = { createSaleSchema, addPaymentSchema, voidSaleSchema, updateSaleSchema };
