const Joi = require('joi');

const createStoreSchema = Joi.object({
  name: Joi.string().max(100).required(),
  address: Joi.string().allow('', null),
  phone: Joi.string().max(20).allow('', null),
  is_warehouse: Joi.boolean().default(false),
});

const updateStoreSchema = Joi.object({
  name: Joi.string().max(100),
  address: Joi.string().allow('', null),
  phone: Joi.string().max(20).allow('', null),
  is_warehouse: Joi.boolean(),
  is_active: Joi.boolean(),
}).min(1); // At least one field required

module.exports = { createStoreSchema, updateStoreSchema };
