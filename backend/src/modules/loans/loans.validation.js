const Joi = require('joi');

const createLoanSchema = Joi.object({
  borrower_name: Joi.string().max(100).required(),
  borrower_phone: Joi.string().max(30).allow('', null),
  amount: Joi.number().positive().required(),
  loan_date: Joi.date().required(),
  due_date: Joi.date().allow(null),
  notes: Joi.string().allow('', null),
  store_id: Joi.string().uuid().allow(null),
});

const updateLoanSchema = Joi.object({
  borrower_name: Joi.string().max(100),
  borrower_phone: Joi.string().max(30).allow('', null),
  amount: Joi.number().positive(),
  loan_date: Joi.date(),
  due_date: Joi.date().allow(null),
  notes: Joi.string().allow('', null),
  store_id: Joi.string().uuid().allow(null),
}).min(1);

const loanPaymentSchema = Joi.object({
  amount: Joi.number().positive().required(),
  payment_method: Joi.string().max(30).default('cash'),
  payment_date: Joi.date().required(),
  notes: Joi.string().allow('', null),
});

module.exports = { createLoanSchema, updateLoanSchema, loanPaymentSchema };
