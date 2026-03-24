const db = require('../../config/database');

class NotificationsService {
  async getUnread() {
    return await db('notifications')
      .where('is_read', false)
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  async markAsRead(id) {
    return await db('notifications')
      .where('id', id)
      .update({ is_read: true });
  }

  async createNotification(data) {
    const [result] = await db('notifications').insert(data).returning('*');
    return result;
  }
}

module.exports = new NotificationsService();
