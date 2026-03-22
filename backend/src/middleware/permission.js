const AppError = require('../utils/AppError');

/**
 * Permission checking middleware factory.
 * Returns middleware that verifies the user has the required permission at the required level.
 * 
 * Dual-level system:
 *   'read'  → user can view data
 *   'write' → user can view AND create/edit/delete data (write implies read)
 * 
 * Admin role bypasses all permission checks.
 * 
 * Usage in routes:
 *   router.get('/',  auth, permission('inventory', 'read'),  controller.list);
 *   router.post('/', auth, permission('inventory', 'write'), controller.create);
 *
 * @param {string} permissionCode - The permission to check (e.g., 'inventory', 'sales')
 * @param {string} requiredLevel - 'read' or 'write'
 */
function permission(permissionCode, requiredLevel = 'read') {
  return (req, res, next) => {
    const user = req.user;

    // Admin bypasses all permission checks
    if (user.role_name === 'admin') {
      return next();
    }

    const userLevel = user.permissions[permissionCode];

    if (!userLevel) {
      return next(
        new AppError(`Access denied: you do not have '${permissionCode}' permission`, 403)
      );
    }

    // If write is required but user only has read
    if (requiredLevel === 'write' && userLevel === 'read') {
      return next(
        new AppError(
          `Access denied: you have read-only access to '${permissionCode}'`,
          403
        )
      );
    }

    next();
  };
}

module.exports = permission;
