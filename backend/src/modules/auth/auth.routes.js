const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const { loginSchema, refreshSchema } = require('./auth.validation');

const router = Router();

// Rate limiting for auth endpoints — prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { success: false, message: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public routes (no auth required)
router.post('/login', authLimiter, validate(loginSchema), controller.login);
router.post('/refresh', authLimiter, validate(refreshSchema), controller.refresh);

// Protected routes
router.post('/logout', auth, controller.logout);
router.get('/me', auth, controller.me);

module.exports = router;
