const Joi = require('joi');

const PAYMENT_METHODS = ['cash', 'bank', 'instapay', 'wallet', 'cheque', 'card', 'salary_deduction', 'other'];

/**
 * A borrower is a staff member OR a written name.
 *
 * `borrower_user_id` used to be `required()`, which meant a shop could not record
 * lending to a customer, a driver or a relative — the overwhelmingly common case —
 * even though `loans.borrower_name` has always existed for exactly that. `.or()`
 * enforces that at least one arrives, and the service decides which wins.
 */
const createLoanSchema = Joi.object({
  borrower_user_id: Joi.string().uuid().allow('', null),
  borrower_name: Joi.string().trim().max(100).allow('', null),
  borrower_phone: Joi.string().max(30).allow('', null),
  amount: Joi.number().positive().max(999999999).required(),
  loan_date: Joi.date().required(),
  due_date: Joi.date().allow(null, ''),
  notes: Joi.string().max(1000).allow('', null),
  store_id: Joi.string().uuid().allow(null, ''),
  // Optional repayment plan, generated with the loan in one transaction.
  installments: Joi.number().integer().min(2).max(60),
  installment_start: Joi.date(),
})
  .or('borrower_user_id', 'borrower_name')
  .messages({ 'object.missing': 'Choose a staff member, or type the borrower\'s name' });

const updateLoanSchema = Joi.object({
  borrower_user_id: Joi.string().uuid().allow('', null),
  borrower_name: Joi.string().trim().max(100).allow('', null),
  borrower_phone: Joi.string().max(30).allow('', null),
  amount: Joi.number().positive().max(999999999),
  loan_date: Joi.date(),
  due_date: Joi.date().allow(null, ''),
  notes: Joi.string().max(1000).allow('', null),
  store_id: Joi.string().uuid().allow(null, ''),
}).min(1);

const listLoansSchema = Joi.object({
  store_id: Joi.string().uuid().allow(''),
  status: Joi.string().valid('active', 'partial', 'paid').allow(''),
  search: Joi.string().max(100).allow(''),
  overdue_only: Joi.boolean(),
  borrower_user_id: Joi.string().uuid().allow(''),
}).unknown(true);

const loanPaymentSchema = Joi.object({
  amount: Joi.number().positive().max(999999999).required(),
  payment_method: Joi.string().valid(...PAYMENT_METHODS).default('cash'),
  payment_date: Joi.date().required(),
  notes: Joi.string().max(1000).allow('', null),
});

const installmentsSchema = Joi.object({
  // 0 or 1 clears the plan; the service treats anything under 2 as "no schedule".
  count: Joi.number().integer().min(0).max(60).required(),
  start_date: Joi.date(),
});

module.exports = {
  PAYMENT_METHODS,
  createLoanSchema,
  updateLoanSchema,
  listLoansSchema,
  loanPaymentSchema,
  installmentsSchema,
};
