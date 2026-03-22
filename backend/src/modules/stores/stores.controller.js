const storesService = require('./stores.service');

class StoresController {
  async list(req, res, next) {
    try {
      const stores = await storesService.list();
      res.json({ success: true, data: stores });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const store = await storesService.getById(req.params.id);
      res.json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const store = await storesService.create(req.body);
      res.status(201).json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const store = await storesService.update(req.params.id, req.body);
      res.json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new StoresController();
