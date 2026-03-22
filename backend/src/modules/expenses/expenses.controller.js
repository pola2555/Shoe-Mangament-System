const expensesService = require('./expenses.service');

class ExpensesController {
  async list(req, res, next) {
    try { res.json({ success: true, data: await expensesService.list(req.query) }); }
    catch (error) { next(error); }
  }
  async getCategories(req, res, next) {
    try { res.json({ success: true, data: await expensesService.getCategories() }); }
    catch (error) { next(error); }
  }
  async create(req, res, next) {
    try { res.status(201).json({ success: true, data: await expensesService.create(req.body, req.user.id) }); }
    catch (error) { next(error); }
  }
  async update(req, res, next) {
    try { res.json({ success: true, data: await expensesService.update(req.params.id, req.body) }); }
    catch (error) { next(error); }
  }
  async delete(req, res, next) {
    try { await expensesService.delete(req.params.id); res.json({ success: true, message: 'Deleted' }); }
    catch (error) { next(error); }
  }
  async summary(req, res, next) {
    try { res.json({ success: true, data: await expensesService.summary(req.query) }); }
    catch (error) { next(error); }
  }
}

module.exports = new ExpensesController();
