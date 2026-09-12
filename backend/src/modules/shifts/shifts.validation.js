const Joi = require('joi');

const openSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  // Required and never defaulted: the float is what somebody counted into the drawer,
  // and a guessed float makes every close after it meaningless.
  opening_float: Joi.number().precision(2).min(0).max(9999999).required(),
  notes: Joi.string().max(1000).allow('', null),
});

const closeSchema = Joi.object({
  counted_cash: Joi.number().precision(2).min(0).max(9999999).required(),
  notes: Joi.string().max(1000).allow('', null),
});

const movementSchema = Joi.object({
  store_id: Joi.string().uuid().required(),
  type: Joi.string().valid('owner_take', 'drop', 'float_in', 'correction').required(),
  // Always positive. The type decides the direction, so a stray minus sign cannot turn
  // the owner taking 5000 into the owner putting 5000 in.
  amount: Joi.number().precision(2).greater(0).max(9999999).required(),
  reason: Joi.string().max(500).allow('', null),
});

const listSchema = Joi.object({
  store_id: Joi.string().uuid(),
  status: Joi.string().valid('open', 'closed'),
  from: Joi.date(),
  to: Joi.date(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
}).unknown(true);

/**
 * Correcting a count. `reason` is optional but strongly wanted — a recount with no
 * explanation is the one an owner will ask about later.
 */
const recountSchema = Joi.object({
  counted_cash: Joi.number().precision(2).min(0).max(99999999).required(),
  reason: Joi.string().max(500).allow('', null),
});

module.exports = { openSchema, closeSchema, movementSchema, listSchema, recountSchema };
