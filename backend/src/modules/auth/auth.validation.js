const Joi = require('joi');

const loginSchema = Joi.object({
  username: Joi.string().required().messages({
    'any.required': 'Username is required',
  }),
  password: Joi.string().max(128).required().messages({
    'any.required': 'Password is required',
    'string.max': 'Password is too long',
  }),
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required().messages({
    'any.required': 'Refresh token is required',
  }),
});

module.exports = { loginSchema, refreshSchema };
