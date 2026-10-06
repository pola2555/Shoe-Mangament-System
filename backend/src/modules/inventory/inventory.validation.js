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
  // Colour NAMES, not ids — see applyColorFilter. product_colors.color_name is
  // varchar(50).
  colors: stringList(60, 50),
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

/**
 * Correcting the colour or size stock was booked under.
 *
 * At least one of colour/size must be given, or there is nothing to correct — but
 * WHICH of them changed is decided in the service against the variant's current
 * values, because sending the colour it already has is not a change either and Joi
 * cannot see that from the request alone.
 *
 * `quantity` omitted means every pair in stock on that variant at that branch.
 */
const reassignSchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  product_color_id: Joi.string().uuid(),
  size_eu: Joi.string().max(20).trim(),
  quantity: Joi.number().integer().min(1).max(1000),
  reason: Joi.string().max(500).allow('', null),
}).or('product_color_id', 'size_eu');

/**
 * Removing stock that was recorded by mistake.
 *
 * `reason` is required, unlike everywhere else. This is the one action that destroys
 * rows outright, and the activity log is the only thing left afterwards — a log entry
 * that cannot say WHY is barely a log entry at all.
 */
const removeStockSchema = Joi.object({
  variant_id: Joi.string().uuid().required(),
  store_id: Joi.string().uuid().required(),
  quantity: Joi.number().integer().min(1).max(1000).required(),
  reason: Joi.string().trim().min(3).max(500).required(),
});

module.exports = {
  inventoryQuerySchema, manualEntrySchema, markDamagedSchema, reassignSchema,
  removeStockSchema,
};
