const { Router } = require('express');
const notificationsController = require('./notifications.controller');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');

const router = Router();
router.use(auth);

/**
 * Everything here is scoped to req.user.id, which is why the routes carry no
 * permission: a person's own notifications are their own. The exception is the
 * /users/:userId pair, which decides what SOMEBODY ELSE is told about.
 */
const canSetForOthers = permission('notification_topics', 'write');
const canSeeForOthers = permission('notification_topics', 'read');

router.get('/', notificationsController.getUnread);
// Literal paths before '/:id/...', or 'history' is read as a notification id.
router.get('/history', notificationsController.history);

// My own topics.
router.get('/preferences', notificationsController.getMyPreferences);
router.put('/preferences', notificationsController.setMyPreferences);

// Somebody else's.
router.get('/preferences/users/:userId', canSeeForOthers, notificationsController.getUserPreferences);
router.put('/preferences/users/:userId', canSetForOthers, notificationsController.setUserPreferences);
router.post('/clear', notificationsController.clear);
router.delete('/', notificationsController.deleteRange);
router.put('/:id/read', notificationsController.markAsRead);

module.exports = router;
