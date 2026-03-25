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
  setStoresSchema,
} = require('./users.validation');

const router = Router();

// All routes require authentication
router.use(auth);

// Password change (own password — any authenticated user, must be before /:id routes)
router.put('/change-password', validate(changePasswordSchema), controller.changePassword);

// Roles & permissions lookup
router.get('/roles', permission('users', 'read'), controller.listRoles);
router.get('/permissions', permission('user_permissions', 'read'), controller.listPermissions);

// User CRUD
router.get('/', permission('users', 'read'), controller.list);
router.get('/:id', permission('users', 'read'), controller.getById);
router.post('/', permission('users', 'write'), validate(createUserSchema), controller.create);
router.put('/:id', permission('users', 'write'), validate(updateUserSchema), controller.update);
router.delete('/:id', permission('users', 'write'), controller.deactivate);

// Permission management
router.put('/:id/permissions', permission('user_permissions', 'write'), validate(setPermissionsSchema), controller.setPermissions);

// Store assignment
router.get('/:id/stores', permission('users', 'read'), controller.getStores);
router.put('/:id/stores', permission('users', 'write'), validate(setStoresSchema), controller.setStores);

module.exports = router;
