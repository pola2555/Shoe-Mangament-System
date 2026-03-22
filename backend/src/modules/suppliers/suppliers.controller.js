const suppliersService = require('./suppliers.service');

class SuppliersController {
  async list(req, res, next) {
    try {
      const suppliers = await suppliersService.list();
      res.json({ success: true, data: suppliers });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const supplier = await suppliersService.getById(req.params.id);
      res.json({ success: true, data: supplier });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const supplier = await suppliersService.create(req.body);
      res.status(201).json({ success: true, data: supplier });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const supplier = await suppliersService.update(req.params.id, req.body);
      res.json({ success: true, data: supplier });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await suppliersService.delete(req.params.id);
      res.json({ success: true, message: 'Supplier deleted' });
    } catch (error) { next(error); }
  }
}

module.exports = new SuppliersController();
