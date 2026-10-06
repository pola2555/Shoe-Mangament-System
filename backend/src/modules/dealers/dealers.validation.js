const Joi = require('joi');

const createDealerSchema = Joi.object({
  name: Joi.string().max(200).required(),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(1000).allow('', null),
});

const updateDealerSchema = createDealerSchema.fork(
  ['name'], (schema) => schema.optional()
).min(1);

const createWholesaleInvoiceSchema = Joi.object({
  dealer_id: Joi.string().uuid().required(),
  total_amount: Joi.number().precision(2).min(0).max(999999999).required(),
  invoice_date: Joi.date().required(),
  notes: Joi.string().max(500).allow('', null),
  boxes: Joi.array().items(
    Joi.object({
      product_id: Joi.string().uuid().required(),
      product_color_id: Joi.string().uuid().required(),
      size_quantities: Joi.object().pattern(Joi.string(), Joi.number().integer().min(1)).required(),
      price_per_item: Joi.number().precision(2).min(0).required(),
    })
  ).min(0),
});

const createDealerPaymentSchema = Joi.object({
  dealer_id: Joi.string().uuid().required(),
  total_amount: Joi.number().precision(2).min(0.01).max(999999999).required(),
  payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash').required(),
  payment_date: Joi.date().required(),
  reference_no: Joi.string().max(100).allow('', null),
  notes: Joi.string().allow('', null),
});

/**
 * Editing a recorded payment. Every field optional, at least one required.
 *
 * `total_amount` keeps the same floor as creation: a payment of zero is not a
 * correction, it is a deletion written in a way that leaves a misleading row behind.
 * Whoever wants the payment gone should delete it, which puts the invoices back.
 */
const updateDealerPaymentSchema = Joi.object({
  total_amount: Joi.number().precision(2).min(0.01).max(999999999),
  payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash'),
  payment_date: Joi.date(),
  reference_no: Joi.string().max(100).allow('', null),
  notes: Joi.string().allow('', null),
}).min(1);

module.exports = {
  createDealerSchema, updateDealerSchema, createWholesaleInvoiceSchema,
  createDealerPaymentSchema, updateDealerPaymentSchema,
};
