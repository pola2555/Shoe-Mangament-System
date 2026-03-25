const Joi = require('joi');

const createUserSchema = Joi.object({
  username: Joi.string().min(3).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(128).required(),
  full_name: Joi.string().max(100).allow('', null),
  role_id: Joi.number().integer().valid(1, 2, 3).required(),
  store_id: Joi.string().uuid().allow(null), // null for admin
});

const updateUserSchema = Joi.object({
  email: Joi.string().email(),
  full_name: Joi.string().max(100).allow('', null),
  password: Joi.string().min(6).max(128),
  role_id: Joi.number().integer().valid(1, 2, 3),
  store_id: Joi.string().uuid().allow(null),
  is_active: Joi.boolean(),
}).min(1);

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().max(128).required(),
  newPassword: Joi.string().min(6).max(128).required(),
});

const setPermissionsSchema = Joi.object({
  permissions: Joi.array().items(
    Joi.object({
      permission_code: Joi.string().required(),
      access_level: Joi.string().valid('read', 'write').required(),
    })
  ).max(50).required(),
});

const setStoresSchema = Joi.object({
  store_ids: Joi.array().items(Joi.string().uuid()).max(50).required(),
});

module.exports = { createUserSchema, updateUserSchema, changePasswordSchema, setPermissionsSchema, setStoresSchema };
