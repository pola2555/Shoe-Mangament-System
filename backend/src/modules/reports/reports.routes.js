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

router.get('/sales-analytics', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getSalesAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/product-analytics', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getProductAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/inventory-analytics', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getInventoryAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/financial', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getFinancialReport(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/customer-analytics', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getCustomerAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/employee-analytics', permission('reports', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getEmployeeAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Dashboard home — today's snapshot (all authenticated users)
router.get('/dashboard-home', async (req, res, next) => {
  try {
    const data = await reportsService.getDashboardHome(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Dashboard admin sections — pending tasks, recent sales, recent activity
router.get('/dashboard-admin', permission('dashboard_admin', 'read'), async (req, res, next) => {
  try {
    const data = await reportsService.getDashboardAdmin(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

module.exports = router;
