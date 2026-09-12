const Joi = require('joi');

const createStoreSchema = Joi.object({
  name: Joi.string().max(100).required(),
  address: Joi.string().max(500).allow('', null),
  phone: Joi.string().max(20).allow('', null),
  is_warehouse: Joi.boolean().default(false),
});

const updateStoreSchema = Joi.object({
  name: Joi.string().max(100),
  address: Joi.string().max(500).allow('', null),
  phone: Joi.string().max(20).allow('', null),
  is_warehouse: Joi.boolean(),
  is_active: Joi.boolean(),
}).min(1); // At least one field required

/**
 * The whole set of users assigned to this store, not a delta — the screen is a list of
 * checkboxes and one Save, so an empty array is a legitimate "nobody", never a missing
 * field. `unique()` matters because user_stores has a UNIQUE(user_id, store_id): a
 * duplicated id would otherwise hit the constraint and surface as "a record with this
 * value already exists", which says nothing about what went wrong.
 */
const setStaffSchema = Joi.object({
  user_ids: Joi.array().items(Joi.string().uuid()).unique().required(),
});

/**
 * A store's own price for one product.
 *
 * `null` clears the override and returns the product to the catalogue price. That has
 * to stay expressible and distinct from zero — otherwise the only way back would be to
 * retype the catalogue price, which then silently stops tracking it.
 */
const setPriceSchema = Joi.object({
  selling_price: Joi.number().min(0).allow(null, ''),
  min_selling_price: Joi.number().min(0).allow(null, ''),
  max_selling_price: Joi.number().min(0).allow(null, ''),
});

module.exports = { createStoreSchema, updateStoreSchema, setStaffSchema, setPriceSchema };
