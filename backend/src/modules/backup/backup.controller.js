const backupService = require('./backup.service');
const AppError = require('../../utils/AppError');

class BackupController {
  async download(req, res, next) {
    try {
      const { filePath, filename } = await backupService.createBackup();

      res.download(filePath, filename, (err) => {
        if (err && !res.headersSent) {
          next(new AppError('Failed to send backup file', 500));
        }
        // Cleanup: remove the file after download
        try { require('fs').unlinkSync(filePath); } catch (_) { /* ignore */ }
      });

      // Keep only recent auto-backups
      backupService.cleanupOldBackups(5);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new BackupController();
