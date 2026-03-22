const { Router } = require('express');
const controller = require('./stores.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createStoreSchema, updateStoreSchema } = require('./stores.validation');

const router = Router();

// All routes require authentication
router.use(auth);

router.get('/', permission('stores', 'read'), controller.list);
router.get('/:id', permission('stores', 'read'), controller.getById);
router.post('/', permission('stores', 'write'), validate(createStoreSchema), controller.create);
router.put('/:id', permission('stores', 'write'), validate(updateStoreSchema), controller.update);

module.exports = router;
