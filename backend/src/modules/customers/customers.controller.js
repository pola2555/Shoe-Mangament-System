const customersService = require('./customers.service');

class CustomersController {
  async list(req, res, next) {
    try {
      const customers = await customersService.list(req.query);
      res.json({ success: true, data: customers });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const customer = await customersService.getById(req.params.id);
      res.json({ success: true, data: customer });
    } catch (error) { next(error); }
  }

  async search(req, res, next) {
    try {
      if (!req.query.phone) {
        return res.status(400).json({ success: false, message: 'Phone parameter is required' });
      }
      const customers = await customersService.searchByPhone(req.query.phone);
      res.json({ success: true, data: customers });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const customer = await customersService.create(req.body);
      res.status(201).json({ success: true, data: customer });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const customer = await customersService.update(req.params.id, req.body);
      res.json({ success: true, data: customer });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await customersService.delete(req.params.id);
      res.json({ success: true, message: 'Customer deleted' });
    } catch (error) { next(error); }
  }
}

module.exports = new CustomersController();
