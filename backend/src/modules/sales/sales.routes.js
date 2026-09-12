const { Router } = require('express');
const controller = require('./sales.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const { createSaleSchema, addPaymentSchema, voidSaleSchema, updateSaleSchema } = require('./sales.validation');

const router = Router();
const upload = createUpload('payments');
router.use(auth);

router.get('/', permission('sales', 'read'), controller.list);
router.get('/export-excel', permission('sales', 'read'), controller.exportExcel);
// Literal paths before '/:id', or they are read as a sale id.
router.get('/customer-balance/:customerId', permission('sales', 'read'), controller.customerBalance);
router.get('/:id', permission('sales', 'read'), controller.getById);
// Voiding returns stock and removes the sale from every report, so it has its own
// permission rather than riding on 'sales:write'.
router.post('/:id/void', permission('sale_void', 'write'), validate(voidSaleSchema), controller.voidSale);
router.patch('/:id', permission('sales', 'write'), validate(updateSaleSchema), controller.updateSale);
router.post('/', permission('pos', 'write'), validate(createSaleSchema), controller.create);
router.post('/:id/payments', permission('sale_payments', 'write'), validate(addPaymentSchema), controller.addPayment);
router.post('/:id/payments/:paymentId/images', permission('sale_payments', 'write'), upload.single('image'), controller.uploadPaymentImage);

module.exports = router;
