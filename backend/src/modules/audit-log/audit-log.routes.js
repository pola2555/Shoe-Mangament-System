const { Router } = require('express');
const controller = require('./audit-log.controller');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');

const router = Router();
router.use(auth);

router.get('/', permission('audit_log', 'read'), controller.list);
router.delete('/clear', permission('audit_log', 'write'), controller.clearAll);
router.post('/log', controller.logAccess);

module.exports = router;
