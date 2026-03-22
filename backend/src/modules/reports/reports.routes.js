const { Router } = require('express');
const reportsService = require('./reports.service');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');

const router = Router();
router.use(auth);

router.get('/dashboard', permission('reports', 'read'), async (req, res, next) => {
  try {
    const stats = await reportsService.getDashboardStats(req.query);
    res.json({ success: true, data: stats });
  } catch (error) { next(error); }
});

module.exports = router;
