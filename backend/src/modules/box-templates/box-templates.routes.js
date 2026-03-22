const { Router } = require('express');
const controller = require('./box-templates.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createBoxTemplateSchema, updateBoxTemplateSchema } = require('./box-templates.validation');

const router = Router();

router.use(auth);

router.get('/', permission('products', 'read'), controller.list);
router.get('/:id', permission('products', 'read'), controller.getById);
router.post('/', permission('products', 'write'), validate(createBoxTemplateSchema), controller.create);
router.put('/:id', permission('products', 'write'), validate(updateBoxTemplateSchema), controller.update);
router.delete('/:id', permission('products', 'write'), controller.delete);

module.exports = router;
