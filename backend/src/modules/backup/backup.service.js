const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const env = require('../../config/env');

class BackupService {
  constructor() {
    this.backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Creates a pg_dump backup and returns the file path.
   */
  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `shoe_erp_backup_${timestamp}.sql`;
    const filePath = path.join(this.backupDir, filename);

    const { host, port, name, user, password } = env.db;

    const pgEnv = { ...process.env, PGPASSWORD: password };

    const args = [
      '-h', host,
      '-p', String(port),
      '-U', user,
      '-F', 'p',        // plain SQL format
      '--no-owner',
      '--no-acl',
      '-f', filePath,
      name,
    ];

    return new Promise((resolve, reject) => {
      execFile('pg_dump', args, { env: pgEnv, timeout: 120000 }, (error, _stdout, stderr) => {
        if (error) {
          // Cleanup partial file
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return reject(new Error(`pg_dump failed: ${stderr || error.message}`));
        }
        resolve({ filePath, filename });
      });
    });
  }

  /**
   * Auto-cleanup: keep only the latest N backups.
   */
  cleanupOldBackups(keepCount = 5) {
    const files = fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('shoe_erp_backup_') && f.endsWith('.sql'))
      .sort()
      .reverse();

    files.slice(keepCount).forEach(f => {
      fs.unlinkSync(path.join(this.backupDir, f));
    });
  }
}

module.exports = new BackupService();
