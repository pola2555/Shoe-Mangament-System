const usersService = require('./users.service');

class UsersController {
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
      const user = await usersService.getById(req.params.id);
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
      const user = await usersService.update(req.params.id, req.body);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async deactivate(req, res, next) {
    try {
      const user = await usersService.deactivate(req.params.id);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async setPermissions(req, res, next) {
    try {
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
}

module.exports = new UsersController();
