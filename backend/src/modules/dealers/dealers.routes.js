const { Router } = require('express');
const controller = require('./dealers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createDealerSchema, updateDealerSchema, createWholesaleInvoiceSchema, createDealerPaymentSchema } = require('./dealers.validation');

const router = Router();
router.use(auth);

router.get('/', permission('dealers', 'read'), controller.list);
router.get('/:id', permission('dealers', 'read'), controller.getById);
router.post('/', permission('dealers', 'write'), validate(createDealerSchema), controller.create);
router.put('/:id', permission('dealers', 'write'), validate(updateDealerSchema), controller.update);
router.delete('/:id', permission('dealers', 'write'), controller.delete);
router.post('/invoices', permission('dealers', 'write'), validate(createWholesaleInvoiceSchema), controller.createInvoice);
router.get('/invoices/:invoiceId', permission('dealers', 'read'), controller.getInvoice);
router.post('/payments', permission('dealers', 'write'), validate(createDealerPaymentSchema), controller.createPayment);

module.exports = router;
