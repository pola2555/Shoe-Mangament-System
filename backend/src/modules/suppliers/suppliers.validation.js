const Joi = require('joi');

const createSupplierSchema = Joi.object({
  name: Joi.string().max(200).required(),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(1000).allow('', null),
});

const updateSupplierSchema = Joi.object({
  name: Joi.string().max(200),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().max(500).allow('', null),
  notes: Joi.string().max(1000).allow('', null),
  is_active: Joi.boolean(),
}).min(1);

module.exports = { createSupplierSchema, updateSupplierSchema };
