const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { businessDayBoundary, addDays } = require('../../utils/dateRange');
const { NOTIFICATION_TYPES, ALL_CODES, disabledTypesFor } = require('../../utils/notificationTypes');

class NotificationsService {
  /**
   * Topics this user has switched off, resolved against the registry defaults.
   * See utils/notificationTypes.js for why this is applied on read.
   */
  async _disabledTypes(userId) {
    const rows = await db('notification_preferences')
      .where('user_id', userId)
      .select('type', 'enabled')
      .catch(() => []);
    return disabledTypesFor(rows);
  }

  /** The topic list, with this user's current answer for each. */
  async getPreferences(userId) {
    const rows = await db('notification_preferences')
      .where('user_id', userId).select('type', 'enabled');
    const chosen = new Map(rows.map((r) => [r.type, r.enabled]));
    return NOTIFICATION_TYPES.map((t) => ({
      type: t.code,
      category: t.category,
      important: Boolean(t.important),
      default_on: t.defaultOn,
      enabled: chosen.has(t.code) ? chosen.get(t.code) : t.defaultOn,
      explicit: chosen.has(t.code),
    }));
  }

  /**
   * Replace this user's choices with exactly what was sent.
   *
   * A whole-set replace, mirroring setPermissions and setBoxItems: the screen is a list
   * of switches and one save, so one transaction should leave the table saying exactly
   * what is on screen. Unknown topic codes are dropped rather than stored, so a typo
   * cannot create a preference that silences nothing.
   */
  async setPreferences(userId, prefs = []) {
    const known = new Set(ALL_CODES);
    const rows = prefs
      .filter((p) => known.has(p.type))
      .map((p) => ({ user_id: userId, type: p.type, enabled: Boolean(p.enabled) }));

    await db.transaction(async (trx) => {
      await trx('notification_preferences').where('user_id', userId).del();
      if (rows.length) await trx('notification_preferences').insert(rows);
    });
    return this.getPreferences(userId);
  }

  async getUnread(userId) {
    // Notifications scoped to the requesting user (or global notifications with null user_id)
    // Exclude global notifications this user has already dismissed
    const dismissed = db('notification_dismissals')
      .where('user_id', userId)
      .select('notification_id');

    const muted = await this._disabledTypes(userId);

    return await db('notifications')
      .where('is_read', false)
      .modify((q) => { if (muted.length) q.whereNotIn('type', muted); })
      // Archived rows stay in the history but leave the bell. That is what "clear"
      // does: it empties what you are being shown without losing what happened.
      .whereNull('archived_at')
      .andWhere(function () {
        this.where('user_id', userId).orWhereNull('user_id');
      })
      .whereNotIn('id', dismissed)
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  /**
   * Everything that has ever been raised for this user, archived included.
   *
   * The bell only ever showed unread notifications and there was no way to look back,
   * so anything dismissed in a hurry was gone. This is the record.
   */
  async history({ from, to, page = 1, limit = 50, include_muted } = {}, userId) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    // History is the record, so it can deliberately show what the bell filtered out —
    // otherwise turning a topic off would look like the events stopped happening.
    const muted = include_muted === true || include_muted === 'true'
      ? [] : await this._disabledTypes(userId);

    const base = () => db('notifications')
      .modify((q) => { if (muted.length) q.whereNotIn('type', muted); })
      .where(function () {
        this.where('user_id', userId).orWhereNull('user_id');
      })
      .modify((q) => {
        if (from) q.where('created_at', '>=', businessDayBoundary(from));
        // Half-open: `< to + 1 day` rather than `<= to 23:59:59`, so the last second
        // of the range is not silently dropped.
        if (to) q.where('created_at', '<', businessDayBoundary(addDays(to, 1)));
      });

    const [{ total }] = await base().count('id as total');
    const rows = await base()
      .select('*')
      .orderBy('created_at', 'desc')
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);

    return {
      data: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: parseInt(total, 10),
        totalPages: Math.ceil(parseInt(total, 10) / safeLimit) || 1,
      },
    };
  }

  /**
   * Empty the bell without losing anything.
   *
   * Archives every notification currently visible to this user. A global notification
   * (user_id IS NULL) is shared, so archiving it for one person would hide it from
   * everyone — those get a per-user dismissal instead, the same mechanism marking one
   * as read already uses.
   */
  async clear(userId) {
    const own = await db('notifications')
      .where('user_id', userId)
      .whereNull('archived_at')
      .update({ archived_at: new Date(), is_read: true });

    const globals = await db('notifications')
      .whereNull('user_id')
      .whereNull('archived_at')
      .whereNotIn('id', db('notification_dismissals').where('user_id', userId).select('notification_id'))
      .pluck('id');

    if (globals.length) {
      await db('notification_dismissals')
        .insert(globals.map((id) => ({ notification_id: id, user_id: userId })))
        .onConflict(['notification_id', 'user_id'])
        .ignore()
        .catch(() => { /* table may predate this feature */ });
    }

    return { archived: own + globals.length };
  }

  /**
   * Delete permanently, over a date range.
   *
   * The only path here that loses anything, which is why it is separate from Clear and
   * why the UI confirms it. Scoped to this user's own notifications: a global one
   * belongs to everybody, and one person tidying up must not erase it for the rest.
   */
  async deleteRange({ from, to }, userId) {
    if (!from && !to) throw new AppError('Choose a date range to delete', 400);
    const q = db('notifications').where('user_id', userId);
    if (from) q.where('created_at', '>=', businessDayBoundary(from));
    if (to) q.where('created_at', '<', businessDayBoundary(addDays(to, 1)));
    const deleted = await q.del();
    return { deleted };
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
