/**
 * Custom application error class.
 * Extends Error with an HTTP status code for consistent error handling.
 * 
 * Usage:
 *   throw new AppError('User not found', 404);
 *   throw new AppError('Forbidden', 403);
 */
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // Distinguishes expected errors from bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
