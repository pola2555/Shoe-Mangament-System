const { Router } = require('express');
const controller = require('./inventory.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { inventoryQuerySchema, manualEntrySchema, markDamagedSchema } = require('./inventory.validation');

const router = Router();
router.use(auth);

router.get('/', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.list);
router.get('/summary', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.summary);
router.get('/export-image', permission('inventory', 'read'), controller.exportImageProxy);
router.post('/manual', permission('inventory', 'write'), validate(manualEntrySchema), controller.manualEntry);
router.put('/:id/damaged', permission('inventory', 'write'), validate(markDamagedSchema), controller.markDamaged);

module.exports = router;
