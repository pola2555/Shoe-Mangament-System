const { Router } = require('express');
const reportsService = require('./reports.service');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');

const router = Router();
router.use(auth);

// Enforce store scoping for non-admin users on all report endpoints
function enforceStoreScope(req, res, next) {
  if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
    if (req.user.assigned_stores?.length > 0) {
      req.query.store_ids = req.user.assigned_stores;
    } else {
      req.query.store_id = req.user.store_id;
    }
  }
  next();
}

router.get('/dashboard', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const stats = await reportsService.getDashboardStats(req.query);
    res.json({ success: true, data: stats });
  } catch (error) { next(error); }
});

router.get('/sales-analytics', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getSalesAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/product-analytics', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getProductAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/inventory-analytics', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getInventoryAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/financial', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getFinancialReport(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/customer-analytics', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getCustomerAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/employee-analytics', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getEmployeeAnalytics(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Dashboard home — today's snapshot (all authenticated users)
router.get('/dashboard-home', permission('dashboard', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getDashboardHome(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Dashboard admin sections — pending tasks, recent sales, recent activity
router.get('/dashboard-admin', permission('dashboard_admin', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getDashboardAdmin(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

module.exports = router;
