const { Router } = require('express');
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const { loginSchema, refreshSchema } = require('./auth.validation');

const router = Router();

// Public routes (no auth required)
router.post('/login', validate(loginSchema), controller.login);
router.post('/refresh', validate(refreshSchema), controller.refresh);

// Protected routes
router.post('/logout', auth, controller.logout);
router.get('/me', auth, controller.me);

module.exports = router;
