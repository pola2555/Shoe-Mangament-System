const usersService = require('./users.service');
const db = require('../../config/database');
const { userHasStoreAccess } = require('../../middleware/auth');

/** Is this role the all-powerful admin role? Resolved by NAME, not by a magic id. */
async function isAdminRole(roleId) {
  if (roleId === undefined || roleId === null) return false;
  const role = await db('roles').where('id', roleId).select('name').first();
  return role?.name === 'admin';
}

class UsersController {
  async listRoles(req, res, next) {
    try {
      const roles = await usersService.listRoles();
      res.json({ success: true, data: roles });
    } catch (error) {
      next(error);
    }
  }

  async listPermissions(req, res, next) {
    try {
      const permissions = await usersService.listPermissions();
      res.json({ success: true, data: permissions });
    } catch (error) {
      next(error);
    }
  }

  async list(req, res, next) {
    try {
      const users = await usersService.list(req.user);
      res.json({ success: true, data: users });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      // Users can view their own profile, or admins/users with 'users' permission can view others
      const targetId = req.params.id;
      const isSelf = targetId === req.user.id;
      const isAdmin = req.user.role_name === 'admin';
      const hasAllStores = req.user.permissions?.all_stores;

      if (!isSelf && !isAdmin) {
        // Non-admin: only allow viewing users in same store
        const target = await usersService.getById(targetId);
        if (!hasAllStores && !req.user.assigned_stores?.includes(target.store_id) && target.store_id !== req.user.store_id) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
        return res.json({ success: true, data: target });
      }

      const user = await usersService.getById(targetId);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      // PRIVILEGE-ESCALATION GUARD. The update path has always blocked a non-admin from
      // handing out roles and store assignments; create did not, so anyone holding
      // users:write could POST { role_id: <admin> } and mint themselves a full admin —
      // role_name 'admin' bypasses every permission and all store scoping. Same intent
      // as update, applied where a user is born.
      if (req.user.role_name !== 'admin') {
        if (await isAdminRole(req.body.role_id)) {
          return res.status(403).json({
            success: false,
            message: 'Only an admin can create another admin account',
          });
        }
        // And a non-admin cannot plant a user in a branch they do not control — that
        // would be a way to seed access into someone else's shop.
        if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
          return res.status(403).json({
            success: false,
            message: 'You can only add a user to a branch you are assigned to',
          });
        }
      }
      const user = await usersService.create(req.body);
      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      // Only admins can change role_id, store_id, or is_active
      if (req.user.role_name !== 'admin') {
        if (req.body.role_id !== undefined) {
          return res.status(403).json({ success: false, message: 'Only admins can change user roles' });
        }
        if (req.body.store_id !== undefined) {
          return res.status(403).json({ success: false, message: 'Only admins can change user store assignment' });
        }
        if (req.body.is_active !== undefined) {
          return res.status(403).json({ success: false, message: 'Only admins can activate/deactivate users' });
        }

        // Resetting another user's password is a separate, stronger capability than
        // general user editing. Without this check, anyone holding 'users:write' could
        // set the admin's password and take over the account.
        if (req.body.password !== undefined) {
          if (req.user.permissions?.user_password_reset !== 'write') {
            return res.status(403).json({
              success: false,
              message: "Access denied: resetting another user's password requires the 'user_password_reset' permission",
            });
          }
          // Even with that permission, never let a non-admin reset an admin's password.
          const target = await db('users')
            .join('roles', 'users.role_id', 'roles.id')
            .where('users.id', req.params.id)
            .select('roles.name as role_name')
            .first();
          if (!target) {
            return res.status(404).json({ success: false, message: 'User not found' });
          }
          if (target.role_name === 'admin') {
            return res.status(403).json({ success: false, message: "Only admins can reset an admin's password" });
          }
        }
      }
      const user = await usersService.update(req.params.id, req.body);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async deactivate(req, res, next) {
    try {
      // Prevent self-deactivation
      if (req.params.id === req.user.id) {
        return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
      }
      const user = await usersService.deactivate(req.params.id);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  /** Screens kept out of this person's way. Not a permission — see appPages.js. */
  async getHiddenPages(req, res, next) {
    try {
      res.json({ success: true, data: await usersService.getHiddenPages(req.params.id) });
    } catch (error) { next(error); }
  }

  async setHiddenPages(req, res, next) {
    try {
      const data = await usersService.setHiddenPages(req.params.id, req.body.pages || []);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async setPermissions(req, res, next) {
    try {
      // Only admin users can modify permissions
      if (req.user.role_name !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only admins can modify permissions' });
      }
      const permissions = await usersService.setPermissions(req.params.id, req.body.permissions);
      res.json({ success: true, data: permissions });
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req, res, next) {
    try {
      await usersService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }

  async getStores(req, res, next) {
    try {
      const stores = await usersService.getStores(req.params.id);
      res.json({ success: true, data: stores });
    } catch (error) {
      next(error);
    }
  }

  async setStores(req, res, next) {
    try {
      if (req.user.role_name !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only admins can change store assignments' });
      }
      const stores = await usersService.setStores(req.params.id, req.body.store_ids);
      res.json({ success: true, data: stores });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new UsersController();
