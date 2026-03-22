const AppError = require('../utils/AppError');

/**
 * Request validation middleware factory.
 * Validates req.body, req.params, or req.query against a Joi schema.
 * 
 * Usage:
 *   const schema = Joi.object({ name: Joi.string().required() });
 *   router.post('/', validate(schema), controller.create);
 *   router.get('/', validate(querySchema, 'query'), controller.list);
 *
 * @param {object} schema - Joi schema object
 * @param {string} source - 'body' (default), 'params', or 'query'
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,    // Report all errors, not just the first
      stripUnknown: true,   // Remove fields not in the schema
      allowUnknown: false,
    });

    if (error) {
      const messages = error.details.map((d) => d.message);
      return next(new AppError(messages.join('; '), 400));
    }

    // Replace source with validated+cleaned values
    req[source] = value;
    next();
  };
}

module.exports = validate;
