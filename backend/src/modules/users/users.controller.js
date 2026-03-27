const usersService = require('./users.service');

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
