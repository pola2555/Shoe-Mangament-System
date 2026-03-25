const Joi = require('joi');

const createTransferSchema = Joi.object({
  from_store_id: Joi.string().uuid().required(),
  to_store_id: Joi.string().uuid().required(),
  notes: Joi.string().allow('', null),
  item_ids: Joi.array().items(Joi.string().uuid()).min(1).max(200).required(),
});

module.exports = { createTransferSchema };
