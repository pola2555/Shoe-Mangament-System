const { Router } = require('express');
const controller = require('./suppliers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createSupplierSchema, updateSupplierSchema } = require('./suppliers.validation');

const router = Router();
router.use(auth);

router.get('/', permission('purchases', 'read'), controller.list);
router.get('/:id', permission('purchases', 'read'), controller.getById);
router.post('/', permission('purchases', 'write'), validate(createSupplierSchema), controller.create);
router.put('/:id', permission('purchases', 'write'), validate(updateSupplierSchema), controller.update);
router.delete('/:id', permission('purchases', 'write'), controller.delete);

module.exports = router;
