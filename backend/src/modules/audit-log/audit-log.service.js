const db = require('../../config/database');

class AuditLogService {
  async list({ page = 1, limit = 50, user_id, module, action, entity_type, store_id, date_from, date_to, search }) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    let query = db('activity_log')
      .leftJoin('users', 'activity_log.user_id', 'users.id')
      .leftJoin('stores', 'activity_log.store_id', 'stores.id')
      .select(
        'activity_log.id',
        'activity_log.user_id',
        'activity_log.action',
        'activity_log.module',
        'activity_log.entity_id',
        'activity_log.entity_type',
        'activity_log.details',
        'activity_log.store_id',
        'activity_log.ip_address',
        'activity_log.created_at',
        'users.username',
        'users.full_name as user_name',
        'stores.name as store_name'
      )
      .orderBy('activity_log.created_at', 'desc');

    if (user_id) query = query.where('activity_log.user_id', user_id);
    if (module) query = query.where('activity_log.module', module);
    if (action) query = query.where('activity_log.action', action);
    if (entity_type) query = query.where('activity_log.entity_type', entity_type);
    if (store_id) query = query.where('activity_log.store_id', store_id);
    if (date_from) query = query.where('activity_log.created_at', '>=', date_from);
    if (date_to) query = query.where('activity_log.created_at', '<=', date_to + ' 23:59:59');
    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.whereRaw("activity_log.details::text ILIKE ?", [`%${safeSearch}%`]);
    }

    const offset = (safePage - 1) * safeLimit;

    const [countResult] = await query.clone().clearSelect().clearOrder().count('activity_log.id as total');
    const total = parseInt(countResult.total, 10);

    const data = await query.limit(safeLimit).offset(offset);

    return {
      data,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async clearAll() {
    const deleted = await db('activity_log').del();
    return { deleted };
  }
}

module.exports = new AuditLogService();
