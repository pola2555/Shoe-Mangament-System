const { Router } = require('express');
const controller = require('./loans.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createLoanSchema, updateLoanSchema, loanPaymentSchema } = require('./loans.validation');

const router = Router();
router.use(auth);

router.get('/', permission('loans', 'read'), controller.list);
router.get('/:id', permission('loans', 'read'), controller.getById);
router.post('/', permission('loans', 'write'), validate(createLoanSchema), controller.create);
router.put('/:id', permission('loans', 'write'), validate(updateLoanSchema), controller.update);
router.delete('/:id', permission('loans', 'write'), controller.delete);
router.post('/:id/payments', permission('loans', 'write'), validate(loanPaymentSchema), controller.addPayment);
router.delete('/:id/payments/:paymentId', permission('loans', 'write'), controller.deletePayment);

module.exports = router;
