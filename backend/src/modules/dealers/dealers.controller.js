const dealersService = require('./dealers.service');

class DealersController {
  async list(req, res, next) {
    try { res.json({ success: true, data: await dealersService.list() }); }
    catch (error) { next(error); }
  }
  async getById(req, res, next) {
    try { res.json({ success: true, data: await dealersService.getById(req.params.id) }); }
    catch (error) { next(error); }
  }
  async create(req, res, next) {
    try { res.status(201).json({ success: true, data: await dealersService.create(req.body) }); }
    catch (error) { next(error); }
  }
  async update(req, res, next) {
    try { res.json({ success: true, data: await dealersService.update(req.params.id, req.body) }); }
    catch (error) { next(error); }
  }
  async delete(req, res, next) {
    try { await dealersService.delete(req.params.id); res.json({ success: true, message: 'Dealer deleted' }); }
    catch (error) { next(error); }
  }
  async createInvoice(req, res, next) {
    try { res.status(201).json({ success: true, data: await dealersService.createInvoice(req.body, req.user.id) }); }
    catch (error) { next(error); }
  }
  async getInvoice(req, res, next) {
    try { res.json({ success: true, data: await dealersService.getInvoiceById(req.params.invoiceId) }); }
    catch (error) { next(error); }
  }
  async createPayment(req, res, next) {
    try { res.status(201).json({ success: true, data: await dealersService.createPayment(req.body, req.user.id) }); }
    catch (error) { next(error); }
  }
}

module.exports = new DealersController();
