const { Router } = require('express');
const notificationsController = require('./notifications.controller');
const auth = require('../../middleware/auth');

const router = Router();
router.use(auth);

router.get('/', notificationsController.getUnread);
router.put('/:id/read', notificationsController.markAsRead);

module.exports = router;
