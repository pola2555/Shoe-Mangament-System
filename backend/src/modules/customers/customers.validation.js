const Joi = require('joi');

const createCustomerSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9+\-() ]{3,20}$/).required()
    .messages({ 'string.pattern.base': 'Phone must contain only digits, +, -, (, ) and spaces' }),
  name: Joi.string().max(100).allow('', null),
  notes: Joi.string().max(500).allow('', null),
});

const updateCustomerSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9+\-() ]{3,20}$/)
    .messages({ 'string.pattern.base': 'Phone must contain only digits, +, -, (, ) and spaces' }),
  name: Joi.string().max(100).allow('', null),
  notes: Joi.string().max(500).allow('', null),
}).min(1);

module.exports = { createCustomerSchema, updateCustomerSchema };
