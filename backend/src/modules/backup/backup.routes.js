const { Router } = require('express');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const backupController = require('./backup.controller');

const router = Router();
router.use(auth);

// Only admin-level users with full reports/admin access
router.get('/download', permission('reports', 'full'), backupController.download);

module.exports = router;
