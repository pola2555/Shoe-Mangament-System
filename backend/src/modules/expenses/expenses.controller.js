const expensesService = require('./expenses.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');
const { getUploadedUrl, deleteFile } = require('../../middleware/upload');
const { generateThumbnail } = require('../../utils/thumbnails');

/**
 * Fetch an expense and confirm the caller may touch its store.
 *
 * The same three lines appeared in update() and delete(); a third caller (receipts)
 * made it worth naming, because the version that gets forgotten is the one that leaks.
 */
async function loadExpenseForUser(user, id) {
  const expense = await db('expenses').where('id', id).first();
  if (!expense) throw new AppError('Expense not found', 404);
  const unrestricted = user.role_name === 'admin' || user.permissions?.all_stores;
  if (!unrestricted && !userHasStoreAccess(user, expense.store_id)) {
    throw new AppError('Access denied', 403);
  }
  return expense;
}

class ExpensesController {
  // ---------------------------------------------------------------- expenses
  async list(req, res, next) {
    try {
      const result = await expensesService.list(req.query, req.user);
      res.json({ success: true, ...result });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      await loadExpenseForUser(req.user, req.params.id);
      res.json({ success: true, data: await expensesService.getById(req.params.id) });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot create expense for another store', 403);
      }
      res.status(201).json({ success: true, data: await expensesService.create(req.body, req.user.id) });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      await loadExpenseForUser(req.user, req.params.id);
      // Moving an expense to a store the caller cannot see would put it out of their
      // own reach and into someone else's books.
      if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot move an expense to another store', 403);
      }
      res.json({ success: true, data: await expensesService.update(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await loadExpenseForUser(req.user, req.params.id);
      await expensesService.delete(req.params.id);
      res.json({ success: true, message: 'Deleted' });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      res.json({ success: true, data: await expensesService.summary(filters) });
    } catch (error) { next(error); }
  }

  async monthlyTrend(req, res, next) {
    try {
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      res.json({ success: true, data: await expensesService.monthlyTrend(filters) });
    } catch (error) { next(error); }
  }

  // ---------------------------------------------------------------- categories
  async getCategories(req, res, next) {
    try {
      res.json({ success: true, data: await expensesService.listCategories(req.query) });
    } catch (error) { next(error); }
  }

  async createCategory(req, res, next) {
    try {
      res.status(201).json({ success: true, data: await expensesService.createCategory(req.body) });
    } catch (error) { next(error); }
  }

  async updateCategory(req, res, next) {
    try {
      res.json({ success: true, data: await expensesService.updateCategory(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async toggleCategoryActive(req, res, next) {
    try {
      res.json({ success: true, data: await expensesService.toggleCategoryActive(req.params.id) });
    } catch (error) { next(error); }
  }

  async deleteCategory(req, res, next) {
    try {
      await expensesService.deleteCategory(req.params.id);
      res.json({ success: true, message: 'Category deleted' });
    } catch (error) { next(error); }
  }

  // ---------------------------------------------------------------- receipts
  async listReceipts(req, res, next) {
    try {
      await loadExpenseForUser(req.user, req.params.id);
      res.json({ success: true, data: await expensesService.listReceipts(req.params.id) });
    } catch (error) { next(error); }
  }

  async uploadReceipt(req, res, next) {
    try {
      if (!req.file) throw new AppError('No file provided', 400);
      await loadExpenseForUser(req.user, req.params.id);
      const imageUrl = getUploadedUrl('expenses', req.file);
      // Best effort: a thumbnail failure must not lose the receipt itself.
      const thumbUrl = await generateThumbnail('expenses', req.file);
      const row = await expensesService.addReceipt(req.params.id, {
        image_url: imageUrl,
        thumb_url: thumbUrl,
        original_name: req.file.originalname,
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) { next(error); }
  }

  async deleteReceipt(req, res, next) {
    try {
      await loadExpenseForUser(req.user, req.params.id);
      const row = await db('attached_images')
        .where({ id: req.params.imageId, entity_type: 'expense', entity_id: req.params.id })
        .first();
      if (!row) throw new AppError('Receipt not found', 404);
      await expensesService.deleteReceipt(req.params.imageId);
      try { await deleteFile(row.image_url); } catch { /* best effort */ }
      try { if (row.thumb_url) await deleteFile(row.thumb_url); } catch { /* best effort */ }
      res.json({ success: true, message: 'Receipt deleted' });
    } catch (error) { next(error); }
  }

  // ---------------------------------------------------------------- recurring
  async listRecurring(req, res, next) {
    try {
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      res.json({ success: true, data: await expensesService.listRecurring(filters) });
    } catch (error) { next(error); }
  }

  async createRecurring(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot create for another store', 403);
      }
      res.status(201).json({ success: true, data: await expensesService.createRecurring(req.body, req.user.id) });
    } catch (error) { next(error); }
  }

  async updateRecurring(req, res, next) {
    try {
      if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot move it to another store', 403);
      }
      res.json({ success: true, data: await expensesService.updateRecurring(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async deleteRecurring(req, res, next) {
    try {
      await expensesService.deleteRecurring(req.params.id);
      res.json({ success: true, message: 'Deleted' });
    } catch (error) { next(error); }
  }

  async postRecurring(req, res, next) {
    try {
      const tpl = await db('expense_recurring').where('id', req.params.id).first();
      if (!tpl) throw new AppError('Recurring expense not found', 404);
      if (!userHasStoreAccess(req.user, tpl.store_id)) throw new AppError('Access denied', 403);
      const expense = await expensesService.postRecurring(req.params.id, req.body, req.user.id);
      res.status(201).json({ success: true, data: expense });
    } catch (error) { next(error); }
  }

  // ---------------------------------------------------------------- budgets
  async budgets(req, res, next) {
    try {
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      res.json({ success: true, data: await expensesService.budgets(filters) });
    } catch (error) { next(error); }
  }

  async setBudget(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot budget for another store', 403);
      }
      res.json({ success: true, data: await expensesService.setBudget(req.body) });
    } catch (error) { next(error); }
  }
}

module.exports = new ExpensesController();
