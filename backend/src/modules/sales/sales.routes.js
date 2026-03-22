const { Router } = require('express');
const controller = require('./sales.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const { createSaleSchema, addPaymentSchema } = require('./sales.validation');

const router = Router();
const upload = createUpload('payments');
router.use(auth);

router.get('/', permission('sales', 'read'), controller.list);
router.get('/:id', permission('sales', 'read'), controller.getById);
router.post('/', permission('sales', 'write'), validate(createSaleSchema), controller.create);
router.post('/:id/payments', permission('sales', 'write'), validate(addPaymentSchema), controller.addPayment);
router.post('/:id/payments/:paymentId/images', permission('sales', 'write'), upload.single('image'), controller.uploadPaymentImage);

module.exports = router;
