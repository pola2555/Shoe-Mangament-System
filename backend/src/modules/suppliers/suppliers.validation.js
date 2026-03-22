const Joi = require('joi');

const createSupplierSchema = Joi.object({
  name: Joi.string().max(200).required(),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
});

const updateSupplierSchema = Joi.object({
  name: Joi.string().max(200),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  is_active: Joi.boolean(),
}).min(1);

module.exports = { createSupplierSchema, updateSupplierSchema };
