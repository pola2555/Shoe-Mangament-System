const expensesService = require('./expenses.service');
const db = require('../../config/database');

class ExpensesController {
  async list(req, res, next) {
    try { res.json({ success: true, data: await expensesService.list(req.query, req.user) }); }
    catch (error) { next(error); }
  }
  async getCategories(req, res, next) {
    try { res.json({ success: true, data: await expensesService.getCategories() }); }
    catch (error) { next(error); }
  }
  async create(req, res, next) {
    try {
      // Verify user has access to the target store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores && req.body.store_id !== req.user.store_id) {
        return res.status(403).json({ success: false, message: 'Access denied: cannot create expense for another store' });
      }
      res.status(201).json({ success: true, data: await expensesService.create(req.body, req.user.id) });
    }
    catch (error) { next(error); }
  }
  async update(req, res, next) {
    try {
      // Verify user has access to this expense's store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        const expense = await db('expenses').where('id', req.params.id).first();
        if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
        if (expense.store_id !== req.user.store_id) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      }
      res.json({ success: true, data: await expensesService.update(req.params.id, req.body) });
    }
    catch (error) { next(error); }
  }
  async delete(req, res, next) {
    try {
      // Verify user has access to this expense's store
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        const expense = await db('expenses').where('id', req.params.id).first();
        if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
        if (expense.store_id !== req.user.store_id) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      }
      await expensesService.delete(req.params.id); res.json({ success: true, message: 'Deleted' });
    }
    catch (error) { next(error); }
  }
  async summary(req, res, next) {
    try {
      const filters = { ...req.query };
      // Enforce store scoping for non-admin users
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        filters.store_id = req.user.store_id;
      }
      res.json({ success: true, data: await expensesService.summary(filters) });
    }
    catch (error) { next(error); }
  }
}

module.exports = new ExpensesController();
