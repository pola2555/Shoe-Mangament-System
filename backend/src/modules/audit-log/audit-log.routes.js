const { Router } = require('express');
const controller = require('./audit-log.controller');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const validate = require('../../middleware/validate');
const Joi = require('joi');

const logAccessSchema = Joi.object({
  action: Joi.string().max(50).required(),
  module: Joi.string().max(50).required(),
  details: Joi.object().allow(null),
});

const router = Router();
router.use(auth);

router.get('/', permission('audit_log', 'read'), controller.list);
// Restrict log clearing to admin only — forensic-critical operation
router.delete('/clear', permission('audit_log', 'write'), (req, res, next) => {
  if (req.user.role_name !== 'admin') {
    return res.status(403).json({ success: false, message: 'Only admins can clear audit logs' });
  }
  next();
}, controller.clearAll);
router.post('/log', permission('audit_log', 'write'), validate(logAccessSchema), controller.logAccess);

module.exports = router;
