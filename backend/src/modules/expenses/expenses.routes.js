const { Router } = require('express');
const controller = require('./expenses.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createExpenseSchema, updateExpenseSchema } = require('./expenses.validation');

const router = Router();
router.use(auth);

router.get('/categories', permission('expenses', 'read'), controller.getCategories);
router.get('/summary', permission('expenses', 'read'), controller.summary);
router.get('/', permission('expenses', 'read'), controller.list);
router.post('/', permission('expenses', 'write'), validate(createExpenseSchema), controller.create);
router.put('/:id', permission('expenses', 'write'), validate(updateExpenseSchema), controller.update);
router.delete('/:id', permission('expenses', 'write'), controller.delete);

module.exports = router;
