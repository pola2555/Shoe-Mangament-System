const Joi = require('joi');

const uuid = Joi.string().uuid();

/**
 * A list of UUIDs as it can actually arrive on a query string: a real array
 * (?ids=a&ids=b), a single value, or one comma-joined string — which is what the
 * frontend sends, and what a plain `array of uuid` schema rejects outright.
 */
const uuidList = (max = 1000) =>
  Joi.alternatives().try(
    Joi.array().items(uuid).max(max),
    uuid,
    Joi.string()
      .allow('')
      .custom((value, helpers) => {
        if (value === '') return value;
        const parts = value.split(',').map((v) => v.trim()).filter(Boolean);
        if (parts.length > max) return helpers.error('any.invalid');
        const bad = parts.find((p) => Joi.string().uuid().validate(p).error);
        return bad ? helpers.error('any.invalid') : value;
      }, 'comma-separated uuids')
      .messages({ 'any.invalid': 'must be a comma-separated list of UUIDs' })
  );

// Either a whole product or an explicit set of variants, never neither.
const assignSchema = Joi.object({
  product_id: uuid,
  variant_ids: Joi.array().items(uuid).min(1).max(500).unique(),
})
  .or('product_id', 'variant_ids')
  .nand('product_id', 'variant_ids');

const linkSchema = Joi.object({
  variant_id: uuid.required(),
  // Manufacturer codes are 12 (UPC-A) or 13 (EAN-13) digits; the service widens
  // UPC-A and validates the check digit.
  barcode: Joi.string().trim().pattern(/^[0-9]{12,13}$/).required().messages({
    'string.pattern.base': 'A manufacturer barcode must be 12 or 13 digits',
  }),
});

const lookupSchema = Joi.object({
  code: Joi.string().trim().max(64).required(),
  store_id: uuid,
  store_ids: uuidList(200),
  // Inventory items already sitting in the cart, so a rescan picks a different pair.
  exclude_ids: uuidList(500),
}).unknown(true);

const labelsSchema = Joi.object({
  variant_ids: uuidList(1000),
  product_id: uuid,
  invoice_box_id: uuid,
  store_id: uuid,
  store_ids: uuidList(200),
}).unknown(true);

module.exports = { assignSchema, linkSchema, lookupSchema, labelsSchema };
