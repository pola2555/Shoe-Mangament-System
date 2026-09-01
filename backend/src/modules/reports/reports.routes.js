const { Router } = require('express');
const reportsService = require('./reports.service');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { scopeStoreQuery } = require('../../utils/storeScope');

const router = Router();
router.use(auth);

// Enforce store scoping for non-admin users on all report endpoints.
// scopeStoreQuery strips any client-supplied store filter before re-deriving it,
// so `?store_id=<other store>` can no longer be smuggled through.
const enforceStoreScope = scopeStoreQuery;

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

// Dashboard home — today's snapshot.
// Gated on 'reports', not 'dashboard': no seed or migration ever created a 'dashboard'
// permission row, and permission_code is a FK to permissions.code, so it could not even
// be granted by hand — every non-admin was permanently locked out of the landing page.
router.get('/dashboard-home', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
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
