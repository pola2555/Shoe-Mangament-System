const notificationsService = require('./notifications.service');

class NotificationsController {
  async getUnread(req, res, next) {
    try {
      const data = await notificationsService.getUnread(req.user.id);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async history(req, res, next) {
    try {
      const result = await notificationsService.history(req.query, req.user.id);
      res.json({ success: true, ...result });
    } catch (error) { next(error); }
  }

  async clear(req, res, next) {
    try {
      const result = await notificationsService.clear(req.user.id);
      res.json({ success: true, ...result, message: 'Notifications cleared' });
    } catch (error) { next(error); }
  }

  async deleteRange(req, res, next) {
    try {
      const result = await notificationsService.deleteRange(req.query, req.user.id);
      res.json({ success: true, ...result, message: 'Notifications deleted' });
    } catch (error) { next(error); }
  }

  /** The topic list for whoever is asking — used by Settings. */
  async getMyPreferences(req, res, next) {
    try {
      res.json({ success: true, data: await notificationsService.getPreferences(req.user.id) });
    } catch (error) { next(error); }
  }

  async setMyPreferences(req, res, next) {
    try {
      const data = await notificationsService.setPreferences(req.user.id, req.body.preferences || []);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  /** Another person's topics. Gated on notification_topics:write in the routes. */
  async getUserPreferences(req, res, next) {
    try {
      res.json({ success: true, data: await notificationsService.getPreferences(req.params.userId) });
    } catch (error) { next(error); }
  }

  async setUserPreferences(req, res, next) {
    try {
      const data = await notificationsService.setPreferences(
        req.params.userId, req.body.preferences || []);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async markAsRead(req, res, next) {
    try {
      await notificationsService.markAsRead(req.params.id, req.user.id);
      res.json({ success: true, message: 'Notification marked as read' });
    } catch (error) { next(error); }
  }
}

module.exports = new NotificationsController();
