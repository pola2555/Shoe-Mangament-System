const { Router } = require('express');
const controller = require('./box-templates.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createBoxTemplateSchema, updateBoxTemplateSchema } = require('./box-templates.validation');

const router = Router();

router.use(auth);

router.get('/', permission('box_templates', 'read'), controller.list);
router.get('/:id', permission('box_templates', 'read'), controller.getById);
router.post('/', permission('box_templates', 'write'), validate(createBoxTemplateSchema), controller.create);
router.put('/:id', permission('box_templates', 'write'), validate(updateBoxTemplateSchema), controller.update);
router.delete('/:id', permission('box_templates', 'write'), controller.delete);

module.exports = router;
