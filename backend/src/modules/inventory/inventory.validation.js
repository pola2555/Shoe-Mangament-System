const Joi = require('joi');

/**
 * A list as a query string can actually carry it: a real array (?v=a&v=b), a single
 * value, or one comma-joined string. A plain `array of string` schema rejects the
 * last form outright — which is exactly how barcode label printing broke once before.
 */
const stringList = (max, itemMax) =>
  Joi.alternatives().try(
    Joi.array().items(Joi.string().trim().max(itemMax)).max(max),
    Joi.string().trim().allow('').max(max * (itemMax + 1))
  );

/**
 * Query schema for GET /inventory and /inventory/summary.
 *
 * These routes validated nothing at all, so a malformed uuid reached Postgres as a
 * cast error and surfaced to the user as a 500. Unknown keys are still allowed
 * through: the value here is coercing and rejecting the keys the service reads, not
 * policing the shape of a request that some other page might add a param to.
 */
const inventoryQuerySchema = Joi.object({
  store_id: Joi.string().uuid(),
  product_id: Joi.string().uuid(),
  variant_id: Joi.string().uuid(),
  category_id: Joi.string().uuid(),
  supplier_id: Joi.string().uuid(),
  status: Joi.string().valid('in_stock', 'sold', 'returned', 'damaged', 'in_transfer'),
  source: Joi.string().valid('purchase', 'manual'),
  search: Joi.string().max(100).allow(''),
  size_min: Joi.number().allow(''),
  size_max: Joi.number().allow(''),
  // Exact sizes as stored: 'Kids', 'M', '42', 'OS'. Length matches size_eu varchar(20).
  size_values: stringList(200, 20),
  limit: Joi.number().integer().min(1).max(10000),
}).unknown(true);

const manualEntrySchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  cost: Joi.number().precision(2).min(0).required(),
  quantity: Joi.number().integer().min(1).max(100).required(),
  notes: Joi.string().allow('', null),
});

const markDamagedSchema = Joi.object({
  notes: Joi.string().max(500).allow('', null),
});

module.exports = { inventoryQuerySchema, manualEntrySchema, markDamagedSchema };
