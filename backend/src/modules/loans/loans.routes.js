const { Router } = require('express');
const controller = require('./loans.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const {
  createLoanSchema,
  updateLoanSchema,
  listLoansSchema,
  loanPaymentSchema,
  installmentsSchema,
} = require('./loans.validation');

const router = Router();
router.use(auth);

const upload = createUpload('loans');
const canRead = permission('loans', 'read');
const canWrite = permission('loans', 'write');

// Specific paths first, so /outstanding is not read as an id.
router.get('/outstanding', canRead, controller.outstanding);

router.get('/', canRead, validate(listLoansSchema, 'query'), controller.list);
router.post('/', canWrite, validate(createLoanSchema), controller.create);
router.get('/:id', canRead, controller.getById);
router.get('/:id/statement', canRead, controller.statement);
router.put('/:id', canWrite, validate(updateLoanSchema), controller.update);
router.delete('/:id', canWrite, controller.delete);

router.put('/:id/installments', canWrite, validate(installmentsSchema), controller.setInstallments);

router.post('/:id/payments', canWrite, validate(loanPaymentSchema), controller.addPayment);
router.delete('/:id/payments/:paymentId', canWrite, controller.deletePayment);

router.get('/:id/payments/:paymentId/images', canRead, controller.listPaymentProof);
router.post('/:id/payments/:paymentId/images', canWrite, upload.single('image'), controller.uploadPaymentProof);
router.delete('/:id/payments/:paymentId/images/:imageId', canWrite, controller.deletePaymentProof);

module.exports = router;
