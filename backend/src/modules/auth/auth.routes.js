const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const { loginSchema, refreshSchema } = require('./auth.validation');

const router = Router();

// Strict limiter for login — this is the brute-force surface.
//
// The ceiling is per-IP, and a shop behind one NAT address shares it across every
// till. LOGIN_RATE_MAX raises it for that case (and for automated test runs) without
// touching the default, which stays deliberately tight.
const LOGIN_MAX = Number(process.env.LOGIN_RATE_MAX) || 10;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: LOGIN_MAX,
  message: { success: false, message: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Refresh needs its own, much higher budget. It previously shared the 10/15min login
// limiter, but refresh is driven by a 15-minute access token expiring — a user with a
// few tabs open exhausts 10 refreshes in normal use and gets bounced to the login page.
// A refresh still requires a valid, unrevoked token, so it is not a brute-force target.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many refresh attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public routes (no auth required)
router.post('/login', loginLimiter, validate(loginSchema), controller.login);
router.post('/refresh', refreshLimiter, validate(refreshSchema), controller.refresh);

// Protected routes
router.post('/logout', auth, controller.logout);
router.get('/me', auth, controller.me);
router.put('/preferences', auth, controller.updatePreferences);

module.exports = router;
