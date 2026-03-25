const { Router } = require('express');
const controller = require('./inventory.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { manualEntrySchema, markDamagedSchema } = require('./inventory.validation');

const router = Router();
router.use(auth);

router.get('/', permission('inventory', 'read'), controller.list);
router.get('/summary', permission('inventory', 'read'), controller.summary);
router.post('/manual', permission('inventory', 'write'), validate(manualEntrySchema), controller.manualEntry);
router.put('/:id/damaged', permission('inventory', 'write'), validate(markDamagedSchema), controller.markDamaged);

module.exports = router;
