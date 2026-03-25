const Joi = require('joi');

const createPurchaseInvoiceSchema = Joi.object({
  supplier_id: Joi.string().uuid().required(),
  total_amount: Joi.number().precision(2).min(0).max(999999999).required(),
  discount_amount: Joi.number().precision(2).min(0).max(Joi.ref('total_amount')).default(0),
  invoice_date: Joi.date().required(),
  notes: Joi.string().max(500).allow('', null),
  boxes: Joi.array().items(
    Joi.object({
      product_id: Joi.string().uuid().allow(null),
      box_template_id: Joi.string().uuid().allow(null),
      cost_per_item: Joi.number().precision(2).min(0).required(),
      total_items: Joi.number().integer().min(1).required(),
      destination_store_id: Joi.string().uuid().allow(null),
      notes: Joi.string().max(500).allow('', null),
    })
  ).min(0),
});

const updatePurchaseInvoiceSchema = Joi.object({
  total_amount: Joi.number().precision(2).min(0).max(999999999),
  discount_amount: Joi.number().precision(2).min(0).max(999999999),
  invoice_date: Joi.date(),
  notes: Joi.string().max(500).allow('', null),
}).min(1);

const addBoxSchema = Joi.object({
  product_id: Joi.string().uuid().allow(null),
  box_template_id: Joi.string().uuid().allow(null),
  cost_per_item: Joi.number().precision(2).min(0).required(),
  total_items: Joi.number().integer().min(1).required(),
  destination_store_id: Joi.string().uuid().allow(null),
  notes: Joi.string().max(500).allow('', null),
});

const updateBoxSchema = Joi.object({
  product_id: Joi.string().uuid().allow(null),
  destination_store_id: Joi.string().uuid().allow(null),
  cost_per_item: Joi.number().precision(2).min(0),
  total_items: Joi.number().integer().min(1),
  notes: Joi.string().max(500).allow('', null),
}).min(1);

const setBoxItemsSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      product_color_id: Joi.string().uuid().allow('', null),
      size_eu: Joi.string().max(10).required(),
      size_us: Joi.string().max(10).allow('', null),
      size_uk: Joi.string().max(10).allow('', null),
      size_cm: Joi.number().precision(1).min(0).allow(null),
      quantity: Joi.number().integer().min(1).required(),
    })
  ).min(1).max(200).required(),
});

// --- Supplier Payments ---
const createSupplierPaymentSchema = Joi.object({
  supplier_id: Joi.string().uuid().required(),
  total_amount: Joi.number().precision(2).min(0.01).max(999999999).required(),
  payment_method: Joi.string().valid('cash', 'bank_transfer', 'instapay', 'vodafone_cash').required(),
  payment_date: Joi.date().required(),
  reference_no: Joi.string().max(100).allow('', null),
  notes: Joi.string().max(500).allow('', null),
});

module.exports = {
  createPurchaseInvoiceSchema, updatePurchaseInvoiceSchema,
  addBoxSchema, updateBoxSchema, setBoxItemsSchema,
  createSupplierPaymentSchema,
};
