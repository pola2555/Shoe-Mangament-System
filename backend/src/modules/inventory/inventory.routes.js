const { Router } = require('express');
const controller = require('./inventory.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  inventoryQuerySchema, manualEntrySchema, markDamagedSchema, reassignSchema,
  removeStockSchema, setQuantitySchema,
} = require('./inventory.validation');

const router = Router();
router.use(auth);

router.get('/', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.list);
router.get('/summary', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.summary);
router.get('/product-grid', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.productGrid);
router.get('/facets', permission('inventory', 'read'), validate(inventoryQuerySchema, 'query'), controller.facets);
router.get('/export-image', permission('inventory', 'read'), controller.exportImageProxy);
router.post('/manual', permission('inventory', 'write'), validate(manualEntrySchema), controller.manualEntry);
router.post('/reassign', permission('inventory', 'write'), validate(reassignSchema), controller.reassign);
// A POST rather than a DELETE because it removes a COUNT of interchangeable pairs at
// one branch, not one addressable row — the same shape as /print-queue/clear.
router.post('/remove', permission('inventory', 'write'), validate(removeStockSchema), controller.removeStock);
// Correcting a miscount: the quantity sent is what there should BE. Same write
// permission as the other two — it both creates and destroys pairs.
router.post('/quantity', permission('inventory', 'write'), validate(setQuantitySchema), controller.setQuantity);
router.put('/:id/damaged', permission('inventory', 'write'), validate(markDamagedSchema), controller.markDamaged);

module.exports = router;
