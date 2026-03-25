const Joi = require('joi');

// --- Product ---
const createProductSchema = Joi.object({
  product_code: Joi.string().max(50).required(),
  brand: Joi.string().max(100).allow('', null),
  model_name: Joi.string().max(200).required(),
  net_price: Joi.number().precision(2).min(0).allow(null),
  default_selling_price: Joi.number().precision(2).min(0).allow(null),
  min_selling_price: Joi.number().precision(2).min(0).allow(null),
  max_selling_price: Joi.number().precision(2).min(0).allow(null),
  description: Joi.string().max(2000).allow('', null),
});

const updateProductSchema = Joi.object({
  product_code: Joi.string().max(50),
  brand: Joi.string().max(100).allow('', null),
  model_name: Joi.string().max(200),
  net_price: Joi.number().precision(2).min(0).allow(null),
  default_selling_price: Joi.number().precision(2).min(0).allow(null),
  min_selling_price: Joi.number().precision(2).min(0).allow(null),
  max_selling_price: Joi.number().precision(2).min(0).allow(null),
  description: Joi.string().max(2000).allow('', null),
  is_active: Joi.boolean(),
}).min(1);

// --- Color ---
const createColorSchema = Joi.object({
  color_name: Joi.string().max(50).required(),
  hex_code: Joi.string().max(7).pattern(/^#[0-9A-Fa-f]{6}$/).allow('', null),
});

const updateColorSchema = Joi.object({
  color_name: Joi.string().max(50),
  hex_code: Joi.string().max(7).pattern(/^#[0-9A-Fa-f]{6}$/).allow('', null),
  is_active: Joi.boolean(),
}).min(1);

// --- Variant ---
const createVariantSchema = Joi.object({
  product_color_id: Joi.string().uuid().required(),
  size_eu: Joi.string().max(10).required(),
  size_us: Joi.string().max(10).allow('', null),
  size_uk: Joi.string().max(10).allow('', null),
  size_cm: Joi.number().precision(1).min(0).allow(null),
});

const bulkCreateVariantsSchema = Joi.object({
  product_color_id: Joi.string().uuid().required(),
  variants: Joi.array().items(
    Joi.object({
      size_eu: Joi.string().max(10).required(),
      size_us: Joi.string().max(10).allow('', null),
      size_uk: Joi.string().max(10).allow('', null),
      size_cm: Joi.number().precision(1).min(0).allow(null),
    })
  ).min(1).max(100).required(),
});

const updateVariantSchema = Joi.object({
  size_us: Joi.string().max(10).allow('', null),
  size_uk: Joi.string().max(10).allow('', null),
  size_cm: Joi.number().precision(1).min(0).allow(null),
  is_active: Joi.boolean(),
}).min(1);

// --- Store Prices ---
const setStorePriceSchema = Joi.object({
  selling_price: Joi.number().precision(2).min(0).required(),
  min_selling_price: Joi.number().precision(2).min(0).allow(null),
  max_selling_price: Joi.number().precision(2).min(0).allow(null),
});

module.exports = {
  createProductSchema, updateProductSchema,
  createColorSchema, updateColorSchema,
  createVariantSchema, bulkCreateVariantsSchema, updateVariantSchema,
  setStorePriceSchema,
};
