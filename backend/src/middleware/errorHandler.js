const AppError = require('../utils/AppError');

/**
 * Global error handler middleware.
 * Catches all errors thrown in routes/middleware and sends a uniform JSON response.
 * 
 * Operational errors (AppError) → send the error message + status code.
 * Unexpected errors → send 500 with generic message (details logged server-side).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Log the full error in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', err);
  }

  // Known operational error
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
  }

  // Joi validation error
  if (err.isJoi) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.details.map((d) => d.message),
    });
  }

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'A record with this value already exists',
    });
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({
      success: false,
      message: 'Referenced record does not exist',
    });
  }

  // Unknown error — don't leak details
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
}

module.exports = errorHandler;
