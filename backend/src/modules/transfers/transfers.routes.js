const { Router } = require('express');
const controller = require('./transfers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createTransferSchema } = require('./transfers.validation');

const router = Router();
router.use(auth);

router.get('/', permission('transfers', 'read'), controller.list);
router.get('/:id', permission('transfers', 'read'), controller.getById);
router.post('/', permission('transfers', 'write'), validate(createTransferSchema), controller.create);
router.post('/:id/ship', permission('transfers', 'write'), controller.ship);
router.post('/:id/receive', permission('transfers', 'write'), controller.receive);
router.post('/:id/cancel', permission('transfers', 'write'), controller.cancel);

module.exports = router;
