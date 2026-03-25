const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const db = require('../config/database');

/**
 * Authentication middleware.
 * Verifies the JWT access token from the Authorization header.
 * Attaches the decoded user object to req.user.
 * 
 * Expected header format: "Authorization: Bearer <token>"
 */
async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] });

    // Fetch full user from DB to ensure they're still active
    const user = await db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .where('users.id', decoded.userId)
      .where('users.is_active', true)
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.store_id',
        'users.role_id',
        'roles.name as role_name'
      )
      .first();

    if (!user) {
      throw new AppError('User account is deactivated or not found', 401);
    }

    // Fetch user permissions
    const permissions = await db('user_permissions')
      .where('user_id', user.id)
      .select('permission_code', 'access_level');

    user.permissions = permissions.reduce((acc, p) => {
      acc[p.permission_code] = p.access_level;
      return acc;
    }, {});

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(new AppError('Invalid token', 401));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new AppError('Token expired', 401));
    }
    next(error);
  }
}

module.exports = auth;
