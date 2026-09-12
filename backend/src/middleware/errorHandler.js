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
  } else {
    console.error('Error:', err.message, err.stack?.split('\n').slice(0, 3).join('\n'));
  }

  // Known operational error
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      // Structured facts a screen can render, when the thrower supplied them. The
      // discount floor is the first user: the dialog shows "under by 120" rather than
      // parsing that number back out of an English sentence.
      ...(err.details ? { details: err.details } : {}),
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

  /**
   * PostgreSQL "invalid input syntax" — a malformed id, date or number reached the
   * database as a cast error.
   *
   * `GET /api/sales/not-a-uuid` answered 500 before this: the id went straight into a
   * WHERE clause, Postgres refused to cast it, and an ordinary bad request came back
   * looking like a server fault. That is worth more than a tidier status code — a 500
   * is what you page someone about, so a stream of them from mistyped links buries the
   * real ones.
   *
   * A backstop, not a substitute for validation. Routes that can say something more
   * useful ("category_id must be a uuid") still should; this catches the ones nobody
   * has got to yet, and every route added later.
   *
   *   22P02  invalid_text_representation   ('abc' as a uuid)
   *   22007  invalid_datetime_format
   *   22003  numeric_value_out_of_range
   */
  if (['22P02', '22007', '22003'].includes(err.code)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid value in the request — check the identifier, date or number.',
    });
  }

  // Unknown error — don't leak details
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
}

module.exports = errorHandler;
