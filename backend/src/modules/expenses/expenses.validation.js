const Joi = require('joi');

const PAYMENT_METHODS = ['cash', 'bank', 'instapay', 'wallet', 'cheque', 'card', 'other'];
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];

/**
 * category_id is nullable on purpose.
 *
 * It was `required()`, but the column has always been nullable and the reports layer
 * carries an explicit "Uncategorised" bucket for rows that have none. Forcing a
 * category at the door means someone in a hurry files rent under "Other", which is
 * worse for a report than an honest blank.
 */
const categoryRef = Joi.number().integer().positive().allow(null);

const listExpensesSchema = Joi.object({
  store_id: Joi.string().uuid(),
  category_id: categoryRef,
  from_date: Joi.date().allow(''),
  to_date: Joi.date().allow(''),
  search: Joi.string().max(100).allow(''),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).allow(''),
  recurring_only: Joi.boolean(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
}).unknown(true);

const createExpenseSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  category_id: categoryRef,
  amount: Joi.number().precision(2).min(0.01).max(999999999).required(),
  description: Joi.string().max(500).allow('', null),
  expense_date: Joi.date().required(),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).allow('', null),
  paid_to: Joi.string().max(120).allow('', null),
});

const updateExpenseSchema = Joi.object({
  store_id: Joi.string().uuid(),
  category_id: categoryRef,
  amount: Joi.number().precision(2).min(0.01).max(999999999),
  description: Joi.string().max(500).allow('', null),
  expense_date: Joi.date(),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).allow('', null),
  paid_to: Joi.string().max(120).allow('', null),
}).min(1);

// ---------------------------------------------------------------- categories

const createCategorySchema = Joi.object({
  name: Joi.string().trim().max(100).required(),
  name_ar: Joi.string().trim().max(100).allow('', null),
  parent_id: Joi.number().integer().positive().allow(null),
  sort_order: Joi.number().integer().min(0).max(9999),
  is_active: Joi.boolean(),
});

const updateCategorySchema = Joi.object({
  name: Joi.string().trim().max(100),
  name_ar: Joi.string().trim().max(100).allow('', null),
  parent_id: Joi.number().integer().positive().allow(null),
  sort_order: Joi.number().integer().min(0).max(9999),
  is_active: Joi.boolean(),
}).min(1);

// ---------------------------------------------------------------- recurring

const createRecurringSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  category_id: Joi.number().integer().positive().required(),
  amount: Joi.number().precision(2).min(0.01).max(999999999).required(),
  description: Joi.string().max(500).allow('', null),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).allow('', null),
  paid_to: Joi.string().max(120).allow('', null),
  frequency: Joi.string().valid(...FREQUENCIES).required(),
  next_date: Joi.date().required(),
  end_date: Joi.date().allow(null),
  is_active: Joi.boolean(),
});

const updateRecurringSchema = Joi.object({
  store_id: Joi.string().uuid(),
  category_id: Joi.number().integer().positive(),
  amount: Joi.number().precision(2).min(0.01).max(999999999),
  description: Joi.string().max(500).allow('', null),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).allow('', null),
  paid_to: Joi.string().max(120).allow('', null),
  frequency: Joi.string().valid(...FREQUENCIES),
  next_date: Joi.date(),
  end_date: Joi.date().allow(null),
  is_active: Joi.boolean(),
}).min(1);

const postRecurringSchema = Joi.object({
  // Both optional: posting with neither books exactly what the template says, on the
  // day it was due, which is the common case.
  expense_date: Joi.date(),
  amount: Joi.number().precision(2).min(0.01).max(999999999),
});

// ---------------------------------------------------------------- budgets

const setBudgetSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  category_id: Joi.number().integer().positive().required(),
  period_month: Joi.date().required(),
  // Zero is how a budget is removed, so it must be allowed through.
  amount: Joi.number().precision(2).min(0).max(999999999).required(),
});

module.exports = {
  PAYMENT_METHODS,
  FREQUENCIES,
  listExpensesSchema,
  createExpenseSchema,
  updateExpenseSchema,
  createCategorySchema,
  updateCategorySchema,
  createRecurringSchema,
  updateRecurringSchema,
  postRecurringSchema,
  setBudgetSchema,
};
