const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const db = require('../config/database');

/**
 * Short-lived cache of the authenticated user's profile, permissions and stores.
 *
 * Every authenticated request used to run three separate queries (user, permissions,
 * stores). At the global 200 req/min ceiling that was ~600 queries a minute spent
 * purely on auth.
 *
 * The TTL is deliberately short: a permission or store change takes effect within a
 * few seconds, and invalidateUserCache() clears it immediately on the paths that
 * change those. Process-local by design — this is a single pm2 instance.
 */
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map();

/**
 * Drop a user's cached profile. Call after changing permissions, stores, role,
 * or active status, so the next request re-reads from the database.
 */
function invalidateUserCache(userId) {
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

/**
 * Load a user with permissions and assigned stores in a single round-trip.
 * Returns null when the user is missing or deactivated.
 */
async function loadUser(userId) {
  const cached = userCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.user;

  // json_agg subqueries: one query instead of three, and no row fan-out from
  // joining two independent one-to-many tables at once.
  const row = await db('users')
    .join('roles', 'users.role_id', 'roles.id')
    .where('users.id', userId)
    .where('users.is_active', true)
    .select(
      'users.id',
      'users.username',
      'users.email',
      'users.full_name',
      'users.store_id',
      'users.role_id',
      'roles.name as role_name',
      db.raw(`COALESCE((
        SELECT json_agg(json_build_object('c', up.permission_code, 'a', up.access_level))
        FROM user_permissions up WHERE up.user_id = users.id
      ), '[]'::json) as permission_rows`),
      db.raw(`COALESCE((
        SELECT json_agg(us.store_id)
        FROM user_stores us WHERE us.user_id = users.id
      ), '[]'::json) as store_rows`)
    )
    .first();

  if (!row) {
    userCache.delete(userId);
    return null;
  }

  const { permission_rows, store_rows, ...user } = row;
  user.permissions = (permission_rows || []).reduce((acc, p) => {
    acc[p.c] = p.a;
    return acc;
  }, {});
  user.assigned_stores = store_rows || [];

  userCache.set(userId, { user, expires: Date.now() + USER_CACHE_TTL_MS });
  return user;
}

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

    const user = await loadUser(decoded.userId);
    if (!user) {
      throw new AppError('User account is deactivated or not found', 401);
    }

    // Fresh object per request so a handler mutating req.user cannot poison the cache.
    req.user = { ...user, permissions: { ...user.permissions }, assigned_stores: [...user.assigned_stores] };
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

/**
 * Check if a user has access to a specific store.
 * Admins and users with all_stores permission always have access.
 * Otherwise checks assigned_stores first, then falls back to store_id.
 */
function userHasStoreAccess(user, storeId) {
  if (!storeId) return true;
  if (user.role_name === 'admin' || user.permissions?.all_stores) return true;
  if (user.assigned_stores && user.assigned_stores.length > 0) {
    return user.assigned_stores.includes(storeId);
  }
  return user.store_id === storeId;
}

module.exports = auth;
module.exports.userHasStoreAccess = userHasStoreAccess;
module.exports.invalidateUserCache = invalidateUserCache;
