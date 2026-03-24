const { Router } = require('express');
const controller = require('./customers.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createCustomerSchema, updateCustomerSchema } = require('./customers.validation');

const router = Router();
router.use(auth);

router.get('/search', permission('customers', 'read'), controller.search);
router.get('/', permission('customers', 'read'), controller.list);
router.get('/:id', permission('customers', 'read'), controller.getById);
router.post('/', permission('customers', 'write'), validate(createCustomerSchema), controller.create);
router.put('/:id', permission('customers', 'write'), validate(updateCustomerSchema), controller.update);
router.delete('/:id', permission('customers', 'write'), controller.delete);

module.exports = router;
