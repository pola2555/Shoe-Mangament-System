const authService = require('./auth.service');

/**
 * Auth controller — thin layer that delegates to auth service.
 * Handles HTTP request/response only. No business logic here.
 */
class AuthController {
  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      const result = await authService.login(username, password);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async refresh(req, res, next) {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refresh(refreshToken);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      const { refreshToken } = req.body;
      await authService.logout(refreshToken);
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }

  async me(req, res, next) {
    try {
      const user = await authService.getProfile(req.user.id);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  async updatePreferences(req, res, next) {
    try {
      const updated = await authService.updatePreferences(req.user.id, req.body);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
