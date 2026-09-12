const { Router } = require('express');
const controller = require('./stock-intakes.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  createSchema,
  updateSchema,
  listSchema,
  reverseSchema,
  recostSchema,
  costHintSchema,
} = require('./stock-intakes.validation');

const router = Router();
router.use(auth);

/**
 * `stock_intake` is its own permission, separate from `inventory:write`, precisely so
 * it can be switched off. Entering stock without an invoice is the right thing to do
 * while a shop is adopting the system and the wrong thing to do afterwards — revoking
 * it closes the door without removing the feature, which is still wanted for stock
 * counts and write-offs.
 */
const canWrite = permission('stock_intake', 'write');
// Reading uses inventory:read, so nobody is locked out of seeing what was entered
// after the write permission is taken away.
const canRead = permission('inventory', 'read');

// Fixed paths before /:id, or 'corrections' is read as an intake id.
router.get('/corrections', canRead, controller.listCorrections);
router.post('/corrections/:batchId/revert', canWrite, controller.revertCorrection);
router.get('/cost-hint', canRead, validate(costHintSchema, 'query'), controller.costHint);
router.get('/estimated', canRead, controller.estimatedSummary);
router.put('/estimated/:productId/recost', canWrite, validate(recostSchema), controller.recost);

router.get('/', canRead, validate(listSchema, 'query'), controller.list);
router.post('/', canWrite, validate(createSchema), controller.create);
router.get('/:id', canRead, controller.getById);
router.put('/:id', canWrite, validate(updateSchema), controller.update);
router.delete('/:id', canWrite, controller.delete);
router.post('/:id/post', canWrite, controller.post);
router.post('/:id/reverse', canWrite, validate(reverseSchema), controller.reverse);

module.exports = router;
