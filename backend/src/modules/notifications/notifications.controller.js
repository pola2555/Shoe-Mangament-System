const notificationsService = require('./notifications.service');

class NotificationsController {
  async getUnread(req, res, next) {
    try {
      const data = await notificationsService.getUnread(req.user.id);
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
