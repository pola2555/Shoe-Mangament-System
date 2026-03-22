const Joi = require('joi');

const createCustomerSchema = Joi.object({
  phone: Joi.string().max(20).required(),
  name: Joi.string().max(100).allow('', null),
  notes: Joi.string().allow('', null),
});

const updateCustomerSchema = Joi.object({
  phone: Joi.string().max(20),
  name: Joi.string().max(100).allow('', null),
  notes: Joi.string().allow('', null),
}).min(1);

module.exports = { createCustomerSchema, updateCustomerSchema };
