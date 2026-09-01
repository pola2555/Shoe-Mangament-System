const Joi = require('joi');

// --- Product ---
const createProductSchema = Joi.object({
  product_code: Joi.string().max(50).required(),
  category_id: Joi.string().uuid().required(),
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
  category_id: Joi.string().uuid(),
}).min(1);

// --- Variant ---
// Both optional: a colourless category resolves to the product's placeholder colour
// and a sizeless one to its scale's only value. The service rejects an omission that
// the category cannot fill in.
const createVariantSchema = Joi.object({
  product_color_id: Joi.string().uuid(),
  size_eu: Joi.string().max(10),
  size_us: Joi.string().max(10).allow('', null),
  size_uk: Joi.string().max(10).allow('', null),
  size_cm: Joi.number().precision(1).min(0).allow(null),
});

// Two shapes. The matrix form (color_ids x size_values) is what the product page
// sends; the older single-colour form stays for anything already calling it.
const bulkCreateVariantsSchema = Joi.object({
  product_color_id: Joi.string().uuid(),
  variants: Joi.array().items(
    Joi.object({
      // Optional: falls back to the top-level product_color_id. The matrix sets it
      // per row so one call can create an irregular colour/size selection.
      product_color_id: Joi.string().uuid(),
      size_eu: Joi.string().max(10).allow('', null),
      size_us: Joi.string().max(10).allow('', null),
      size_uk: Joi.string().max(10).allow('', null),
      size_cm: Joi.number().precision(1).min(0).allow(null),
    })
  ).min(1).max(500),
  color_ids: Joi.array().items(Joi.string().uuid()).min(1).max(100).unique(),
  size_values: Joi.array().items(Joi.string().max(10)).min(1).max(200).unique(),
})
  .oxor('variants', 'size_values')
  .or('variants', 'color_ids', 'size_values');

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
