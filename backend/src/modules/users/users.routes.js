const { Router } = require('express');
const controller = require('./users.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  setPermissionsSchema,
} = require('./users.validation');

const router = Router();

// All routes require authentication
router.use(auth);

// Password change (own password — any authenticated user, must be before /:id routes)
router.put('/change-password', validate(changePasswordSchema), controller.changePassword);

// User CRUD
router.get('/', permission('users', 'read'), controller.list);
router.get('/:id', permission('users', 'read'), controller.getById);
router.post('/', permission('users', 'write'), validate(createUserSchema), controller.create);
router.put('/:id', permission('users', 'write'), validate(updateUserSchema), controller.update);
router.delete('/:id', permission('users', 'write'), controller.deactivate);

// Permission management
router.put('/:id/permissions', permission('users', 'write'), validate(setPermissionsSchema), controller.setPermissions);

module.exports = router;
