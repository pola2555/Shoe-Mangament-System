const loansService = require('./loans.service');

class LoansController {
  async list(req, res, next) {
    try {
      const loans = await loansService.list(req.query);
      res.json({ success: true, data: loans });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const loan = await loansService.getById(req.params.id);
      res.json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const loan = await loansService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const loan = await loansService.update(req.params.id, req.body);
      res.json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await loansService.delete(req.params.id);
      res.json({ success: true, message: 'Loan deleted' });
    } catch (error) { next(error); }
  }

  async addPayment(req, res, next) {
    try {
      const loan = await loansService.addPayment(req.params.id, req.body, req.user.id);
      res.status(201).json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async deletePayment(req, res, next) {
    try {
      const loan = await loansService.deletePayment(req.params.id, req.params.paymentId);
      res.json({ success: true, data: loan });
    } catch (error) { next(error); }
  }
}

module.exports = new LoansController();
