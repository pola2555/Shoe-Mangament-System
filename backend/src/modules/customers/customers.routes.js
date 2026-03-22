const { Router } = require('express');
const controller = require('./customers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createCustomerSchema, updateCustomerSchema } = require('./customers.validation');

const router = Router();
router.use(auth);

router.get('/search', permission('sales', 'read'), controller.search);
router.get('/', permission('sales', 'read'), controller.list);
router.get('/:id', permission('sales', 'read'), controller.getById);
router.post('/', permission('sales', 'write'), validate(createCustomerSchema), controller.create);
router.put('/:id', permission('sales', 'write'), validate(updateCustomerSchema), controller.update);
router.delete('/:id', permission('sales', 'write'), controller.delete);

module.exports = router;
