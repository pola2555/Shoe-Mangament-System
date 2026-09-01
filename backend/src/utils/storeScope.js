/**
 * Store scoping helpers.
 *
 * Two pieces that must be used together:
 *
 *   1. `resolveStoreScope(user, query)` — called in controllers/routes. Takes the raw
 *      client query and returns the *trusted* scope. A client-supplied `store_id` is
 *      never taken at face value: it is intersected with what the user may actually see.
 *
 *   2. `applyStoreScope(qb, column, scope)` — called in services. Applies that scope to
 *      a knex query builder.
 *
 * Before this existed, controllers set `filters.store_ids` but no service read it, so a
 * scoped user silently received every store's data.
 */

/**
 * Does this user see everything?
 */
function hasGlobalStoreAccess(user) {
  return user?.role_name === 'admin' || Boolean(user?.permissions?.all_stores);
}

/**
 * Work out which stores a request is allowed to touch.
 *
 * @param {object} user - req.user
 * @param {object} [query] - req.query (untrusted)
 * @returns {{ store_id?: string, store_ids?: string[] }} trusted scope
 * @throws {AppError} 403 when the caller explicitly asks for a store they cannot see
 */
function resolveStoreScope(user, query = {}) {
  const AppError = require('./AppError');
  const requested = query.store_id || null;

  // Global access: honour an explicit filter, otherwise no restriction.
  if (hasGlobalStoreAccess(user)) {
    return requested ? { store_id: requested } : {};
  }

  // Everything the user may see: their user_stores rows UNION their legacy home
  // store. The union matters — the frontend still sends users.store_id as the default
  // filter, so treating assigned_stores as exclusive would 403 any user whose
  // user_stores rows don't happen to include their own home store.
  const allowed = [...new Set([
    ...(user?.assigned_stores || []),
    ...(user?.store_id ? [user.store_id] : []),
  ])];

  // No store at all — scope to a value that matches nothing rather than leaking everything.
  if (allowed.length === 0) {
    return { store_ids: [] };
  }

  if (requested) {
    if (!allowed.includes(requested)) {
      throw new AppError('Access denied: you are not assigned to this store', 403);
    }
    return { store_id: requested };
  }

  return allowed.length === 1 ? { store_id: allowed[0] } : { store_ids: allowed };
}

/**
 * Apply a resolved scope to a knex query builder.
 *
 * An empty `store_ids` array means "no accessible stores" and must match zero rows —
 * knex's whereIn already renders that correctly, but it is called out here because
 * getting it wrong leaks the whole table.
 *
 * @param {import('knex').Knex.QueryBuilder} qb
 * @param {string} column - fully qualified column, e.g. 'sales.store_id'
 * @param {{ store_id?: string, store_ids?: string[] }} scope
 */
function applyStoreScope(qb, column, scope = {}) {
  const { store_id, store_ids } = scope;
  if (store_id) {
    qb.where(column, store_id);
  } else if (Array.isArray(store_ids)) {
    qb.whereIn(column, store_ids);
  }
  return qb;
}

/**
 * Express middleware: replace the client's store filter with the trusted one.
 * Deletes `req.query.store_id` first so a stale value can never survive downstream.
 */
function scopeStoreQuery(req, res, next) {
  try {
    const scope = resolveStoreScope(req.user, req.query);
    delete req.query.store_id;
    delete req.query.store_ids;
    Object.assign(req.query, scope);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  hasGlobalStoreAccess,
  resolveStoreScope,
  applyStoreScope,
  scopeStoreQuery,
};
