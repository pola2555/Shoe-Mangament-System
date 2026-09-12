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

// This period against the one before it. Same length, immediately before — never
// "last calendar month", which would compare 12 days against 31.
router.get('/comparison', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getPeriodComparison(req.query);
    res.json({ success: true, data });
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

// What to buy, and what to stop buying. Days of cover, not a bare low-stock number.
router.get('/reorder', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getReorderSignals(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// The findings a person would reach by reading every other tab carefully, ranked by
// how much money is attached.
router.get('/insights', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getInsights(req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// How much of this period's profit is still resting on guessed costs, and whether it
// has been restated since. Read by every screen that headlines a profit figure.
router.get('/cost-basis', permission('reports', 'read'), enforceStoreScope, async (req, res, next) => {
  try {
    const data = await reportsService.getCostBasis(req.query);
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
