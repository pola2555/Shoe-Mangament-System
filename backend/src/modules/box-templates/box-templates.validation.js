const Joi = require('joi');

const createBoxTemplateSchema = Joi.object({
  name: Joi.string().max(100).required(),
  product_id: Joi.string().uuid().allow(null),
  notes: Joi.string().allow('', null),
  items: Joi.array().items(
    Joi.object({
      size: Joi.string().max(10).required(),
      quantity: Joi.number().integer().min(1).required(),
      color_label: Joi.string().max(50).allow('', null),
    })
  ).min(1).required(),
});

const updateBoxTemplateSchema = Joi.object({
  name: Joi.string().max(100),
  product_id: Joi.string().uuid().allow(null),
  notes: Joi.string().allow('', null),
  items: Joi.array().items(
    Joi.object({
      size: Joi.string().max(10).required(),
      quantity: Joi.number().integer().min(1).required(),
      color_label: Joi.string().max(50).allow('', null),
    })
  ).min(1),
}).min(1);

module.exports = { createBoxTemplateSchema, updateBoxTemplateSchema };
