const Joi = require('joi');

const uuid = Joi.string().uuid();

// Lower-case identifier, because `code` is the stable key a category is known by in
// data and in tests. Names are what change; codes are not editable after creation.
const code = Joi.string().max(50).pattern(/^[a-z0-9_]+$/).messages({
  'string.pattern.base': 'Code may contain only lowercase letters, numbers and underscores',
});

const hex = Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null).messages({
  'string.pattern.base': 'Colour must be a hex value like #1A2B3C',
});

// varchar(10) on both size_scale_values.value and product_variants.size_eu — a size
// that does not fit the variant column could never be stored on a variant.
const sizeValue = Joi.string().trim().max(10);

const scaleValueSchema = Joi.object({
  value: sizeValue.required(),
  label_en: Joi.string().max(50).allow('', null),
  label_ar: Joi.string().max(50).allow('', null),
  sort_order: Joi.number().integer().required(),
  is_active: Joi.boolean(),
});

const createCategorySchema = Joi.object({
  code: code.required(),
  name_en: Joi.string().max(100).required(),
  name_ar: Joi.string().max(100).required(),
  has_colors: Joi.boolean().default(true),
  has_sizes: Joi.boolean().default(true),
  size_scale_id: uuid.required(),
  placeholder_color_name: Joi.string().max(50).default('Standard'),
  sort_order: Joi.number().integer().default(0),
  is_active: Joi.boolean(),
});

// `code` is deliberately absent: it is the stable identity, like products.product_code.
const updateCategorySchema = Joi.object({
  name_en: Joi.string().max(100),
  name_ar: Joi.string().max(100),
  has_colors: Joi.boolean(),
  has_sizes: Joi.boolean(),
  size_scale_id: uuid,
  placeholder_color_name: Joi.string().max(50),
  sort_order: Joi.number().integer(),
  is_active: Joi.boolean(),
}).min(1);

const createScaleSchema = Joi.object({
  code: code.required(),
  name_en: Joi.string().max(100).required(),
  name_ar: Joi.string().max(100).required(),
  display_prefix: Joi.string().max(10).allow('').default(''),
  display_suffix: Joi.string().max(10).allow('').default(''),
  is_numeric: Joi.boolean().default(false),
  is_active: Joi.boolean(),
  values: Joi.array().items(scaleValueSchema).min(1).max(200).unique('value').required(),
});

const updateScaleSchema = Joi.object({
  name_en: Joi.string().max(100),
  name_ar: Joi.string().max(100),
  display_prefix: Joi.string().max(10).allow(''),
  display_suffix: Joi.string().max(10).allow(''),
  is_numeric: Joi.boolean(),
  is_active: Joi.boolean(),
}).min(1);

const replaceScaleValuesSchema = Joi.object({
  values: Joi.array().items(scaleValueSchema).min(1).max(200).unique('value').required(),
});

const createColorPresetSchema = Joi.object({
  name_en: Joi.string().max(50).required(),
  name_ar: Joi.string().max(50).required(),
  hex_code: hex,
  sort_order: Joi.number().integer().default(0),
  is_active: Joi.boolean(),
});

const updateColorPresetSchema = Joi.object({
  name_en: Joi.string().max(50),
  name_ar: Joi.string().max(50),
  hex_code: hex,
  sort_order: Joi.number().integer(),
  is_active: Joi.boolean(),
}).min(1);

module.exports = {
  createCategorySchema,
  updateCategorySchema,
  createScaleSchema,
  updateScaleSchema,
  replaceScaleValuesSchema,
  createColorPresetSchema,
  updateColorPresetSchema,
};
