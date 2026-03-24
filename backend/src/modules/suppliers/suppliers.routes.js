const { Router } = require('express');
const controller = require('./suppliers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createSupplierSchema, updateSupplierSchema } = require('./suppliers.validation');

const router = Router();
router.use(auth);

router.get('/', permission('suppliers', 'read'), controller.list);
router.get('/:id', permission('suppliers', 'read'), controller.getById);
router.post('/', permission('suppliers', 'write'), validate(createSupplierSchema), controller.create);
router.put('/:id', permission('suppliers', 'write'), validate(updateSupplierSchema), controller.update);
router.delete('/:id', permission('suppliers', 'write'), controller.delete);

module.exports = router;
