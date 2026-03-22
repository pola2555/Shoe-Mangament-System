const Joi = require('joi');

const createExpenseSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  category_id: Joi.number().integer().required(),
  amount: Joi.number().precision(2).min(0.01).required(),
  description: Joi.string().max(500).required(),
  expense_date: Joi.date().required(),
});

const updateExpenseSchema = Joi.object({
  category_id: Joi.number().integer(),
  amount: Joi.number().precision(2).min(0.01),
  description: Joi.string().max(500),
  expense_date: Joi.date(),
}).min(1);

module.exports = { createExpenseSchema, updateExpenseSchema };
