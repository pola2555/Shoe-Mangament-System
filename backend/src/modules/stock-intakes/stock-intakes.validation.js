const Joi = require('joi');

const REASONS = ['opening', 'count', 'found', 'damaged'];

const lineSchema = Joi.object({
  product_id: Joi.string().uuid().required(),
  // Both optional: a colourless or sizeless category resolves its own placeholder when
  // the sheet is posted, exactly as a purchase box does.
  product_color_id: Joi.string().uuid().allow(null, ''),
  size_eu: Joi.string().max(20).allow(null, ''),
  quantity: Joi.number().integer().min(1).max(10000).required(),
  unit_cost: Joi.number().precision(2).min(0).max(9999999).required(),
  // Defaults to a guess, because that is the honest default for stock being entered
  // without an invoice. The owner ticks the lines they actually know.
  cost_is_estimated: Joi.boolean().default(true),
  notes: Joi.string().max(500).allow('', null),
});

const createSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  supplier_id: Joi.string().uuid().allow(null, ''),
  reason: Joi.string().valid(...REASONS).default('opening'),
  intake_date: Joi.date().required(),
  notes: Joi.string().max(1000).allow('', null),
  lines: Joi.array().items(lineSchema).max(2000).default([]),
});

const updateSchema = Joi.object({
  store_id: Joi.string().uuid(),
  supplier_id: Joi.string().uuid().allow(null, ''),
  reason: Joi.string().valid(...REASONS),
  intake_date: Joi.date(),
  notes: Joi.string().max(1000).allow('', null),
  lines: Joi.array().items(lineSchema).max(2000),
}).min(1);

const listSchema = Joi.object({
  store_id: Joi.string().uuid(),
  status: Joi.string().valid('draft', 'posted', 'cancelled'),
  reason: Joi.string().valid(...REASONS),
  from: Joi.date(),
  to: Joi.date(),
  search: Joi.string().max(100).allow(''),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
}).unknown(true);

const reverseSchema = Joi.object({
  reason: Joi.string().max(500).allow('', null),
});

const recostSchema = Joi.object({
  unit_cost: Joi.number().precision(2).min(0).max(9999999).required(),
  // Leaving it estimated keeps it eligible for healing by a future invoice. Turning it
  // off says "this is the real number" — after which nothing will ever overwrite it.
  still_estimated: Joi.boolean().default(true),
});

const costHintSchema = Joi.object({
  product_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid(),
}).unknown(true);

module.exports = {
  createSchema,
  updateSchema,
  listSchema,
  reverseSchema,
  recostSchema,
  costHintSchema,
  REASONS,
};
