const { Router } = require('express');
const controller = require('./dealers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createDealerSchema, updateDealerSchema, createWholesaleInvoiceSchema, createDealerPaymentSchema } = require('./dealers.validation');

const router = Router();
router.use(auth);

router.get('/', permission('dealers', 'read'), controller.list);
// POST routes MUST come before GET /:id to avoid route parameter capture
router.post('/', permission('dealers', 'write'), validate(createDealerSchema), controller.create);
router.post('/invoices', permission('dealer_invoices', 'write'), validate(createWholesaleInvoiceSchema), controller.createInvoice);
router.post('/payments', permission('dealer_payments', 'write'), validate(createDealerPaymentSchema), controller.createPayment);
router.get('/invoices/:invoiceId', permission('dealer_invoices', 'read'), controller.getInvoice);
router.get('/:id', permission('dealers', 'read'), controller.getById);
router.put('/:id', permission('dealers', 'write'), validate(updateDealerSchema), controller.update);
router.delete('/:id', permission('dealers', 'write'), controller.delete);

module.exports = router;
