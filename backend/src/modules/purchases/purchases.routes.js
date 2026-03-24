const { Router } = require('express');
const controller = require('./purchases.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const {
  createPurchaseInvoiceSchema, updatePurchaseInvoiceSchema,
  addBoxSchema, updateBoxSchema, setBoxItemsSchema,
  createSupplierPaymentSchema,
} = require('./purchases.validation');

const router = Router();
const invoiceUpload = createUpload('invoices');
const paymentUpload = createUpload('payments');

router.use(auth);

// --- Purchase Invoices ---
router.get('/invoices', permission('purchases', 'read'), controller.listInvoices);
router.get('/invoices/:id', permission('purchases', 'read'), controller.getInvoice);
router.post('/invoices', permission('purchases', 'write'), validate(createPurchaseInvoiceSchema), controller.createInvoice);
router.put('/invoices/:id', permission('purchases', 'write'), validate(updatePurchaseInvoiceSchema), controller.updateInvoice);
router.delete('/invoices/:id', permission('purchases', 'write'), controller.deleteInvoice);
router.post('/invoices/:id/primary-image', permission('purchase_images', 'write'), invoiceUpload.single('image'), controller.uploadPrimaryImage);
router.post('/invoices/:id/images', permission('purchase_images', 'write'), invoiceUpload.single('image'), controller.uploadInvoiceImage);
router.delete('/invoices/:id/images/:imageId', permission('purchase_images', 'write'), controller.deleteInvoiceImage);

// --- Boxes (nested under invoice) ---
router.post('/invoices/:id/boxes', permission('purchase_boxes', 'write'), validate(addBoxSchema), controller.addBox);
router.put('/boxes/:boxId', permission('purchase_boxes', 'write'), validate(updateBoxSchema), controller.updateBox);
router.delete('/boxes/:boxId', permission('purchase_boxes', 'write'), controller.deleteBox);
router.put('/boxes/:boxId/items', permission('purchase_boxes', 'write'), validate(setBoxItemsSchema), controller.setBoxItems);
router.post('/boxes/:boxId/complete', permission('purchase_boxes', 'write'), controller.completeBox);

// --- Supplier Payments ---
router.get('/payments', permission('supplier_payments', 'read'), controller.listPayments);
router.get('/payments/:id', permission('supplier_payments', 'read'), controller.getPayment);
router.post('/payments', permission('supplier_payments', 'write'), validate(createSupplierPaymentSchema), controller.createPayment);
router.post('/payments/:id/images', permission('supplier_payments', 'write'), paymentUpload.single('image'), controller.uploadPaymentImage);

module.exports = router;
