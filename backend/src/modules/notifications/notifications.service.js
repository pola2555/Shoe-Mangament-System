const db = require('../../config/database');
const AppError = require('../../utils/AppError');

class NotificationsService {
  async getUnread(userId) {
    // Notifications scoped to the requesting user (or global notifications with null user_id)
    // Exclude global notifications this user has already dismissed
    const dismissed = db('notification_dismissals')
      .where('user_id', userId)
      .select('notification_id');

    return await db('notifications')
      .where('is_read', false)
      .andWhere(function () {
        this.where('user_id', userId).orWhereNull('user_id');
      })
      .whereNotIn('id', dismissed)
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  async markAsRead(id, userId) {
    // Verify the notification belongs to this user (or is global)
    const notification = await db('notifications').where('id', id).first();
    if (!notification) throw new AppError('Notification not found', 404);
    if (notification.user_id && notification.user_id !== userId) {
      throw new AppError('Access denied', 403);
    }
    // For global notifications (user_id IS NULL), create a per-user dismissal
    // rather than modifying the shared record
    if (!notification.user_id) {
      const existing = await db('notification_dismissals')
        .where({ notification_id: id, user_id: userId }).first();
      if (!existing) {
        await db('notification_dismissals').insert({ notification_id: id, user_id: userId }).catch(() => {
          // Table may not exist yet — fall back to marking the notification directly
          return db('notifications').where('id', id).update({ is_read: true });
        });
      }
      return;
    }
    return await db('notifications')
      .where('id', id)
      .update({ is_read: true });
  }

  async createNotification(data) {
    // Whitelist allowed fields
    const safeData = {
      type: data.type,
      title: data.title,
      message: data.message,
      reference_id: data.reference_id || null,
      user_id: data.user_id || null,
      title_key: data.title_key || null,
      message_key: data.message_key || null,
      params: data.params ? JSON.stringify(data.params) : null,
    };
    const [result] = await db('notifications').insert(safeData).returning('*');
    return result;
  }
}

module.exports = new NotificationsService();
