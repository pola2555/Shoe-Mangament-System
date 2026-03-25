const { Router } = require('express');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const backupController = require('./backup.controller');

const router = Router();
router.use(auth);

// Backup is admin-only
router.get('/download', (req, res, next) => {
  if (req.user.role_name !== 'admin') {
    return res.status(403).json({ success: false, message: 'Only admins can download backups' });
  }
  next();
}, backupController.download);

module.exports = router;
