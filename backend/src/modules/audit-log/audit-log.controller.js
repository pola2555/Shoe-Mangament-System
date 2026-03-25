const auditLogService = require('./audit-log.service');
const logActivity = require('../../utils/logActivity');

class AuditLogController {
  async list(req, res, next) {
    try {
      const result = await auditLogService.list(req.query);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async clearAll(req, res, next) {
    try {
      const result = await auditLogService.clearAll();
      res.json({ success: true, message: `Cleared ${result.deleted} log entries` });
    } catch (error) {
      next(error);
    }
  }

  async logAccess(req, res, next) {
    try {
      const { action, module: mod, details } = req.body;
      // Validate input sizes to prevent log pollution
      const safeAction = typeof action === 'string' ? action.slice(0, 50) : 'unauthorized_access';
      const safeMod = typeof mod === 'string' ? mod.slice(0, 50) : 'auth';
      const safeDetails = (details && typeof details === 'object') ? details : null;
      await logActivity({
        userId: req.user.id,
        action: safeAction,
        module: safeMod,
        entityId: null,
        entityType: 'page',
        details: safeDetails,
        storeId: req.user.store_id || null,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuditLogController();
