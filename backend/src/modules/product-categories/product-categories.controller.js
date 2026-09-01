const service = require('./product-categories.service');

class ProductCategoriesController {
  // ---- categories ----
  async listCategories(req, res, next) {
    try {
      res.json({ success: true, data: await service.listCategories(req.query) });
    } catch (error) { next(error); }
  }

  async getCategory(req, res, next) {
    try {
      res.json({ success: true, data: await service.getCategory(req.params.id) });
    } catch (error) { next(error); }
  }

  async createCategory(req, res, next) {
    try {
      res.status(201).json({ success: true, data: await service.createCategory(req.body) });
    } catch (error) { next(error); }
  }

  async updateCategory(req, res, next) {
    try {
      res.json({ success: true, data: await service.updateCategory(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async toggleCategoryActive(req, res, next) {
    try {
      res.json({ success: true, data: await service.toggleCategoryActive(req.params.id) });
    } catch (error) { next(error); }
  }

  // ---- size scales ----
  async listScales(req, res, next) {
    try {
      res.json({ success: true, data: await service.listScales(req.query) });
    } catch (error) { next(error); }
  }

  async getScale(req, res, next) {
    try {
      res.json({ success: true, data: await service.getScale(req.params.id) });
    } catch (error) { next(error); }
  }

  async createScale(req, res, next) {
    try {
      res.status(201).json({ success: true, data: await service.createScale(req.body) });
    } catch (error) { next(error); }
  }

  async updateScale(req, res, next) {
    try {
      res.json({ success: true, data: await service.updateScale(req.params.id, req.body) });
    } catch (error) { next(error); }
  }

  async replaceScaleValues(req, res, next) {
    try {
      const values = await service.replaceScaleValues(req.params.id, req.body.values);
      res.json({ success: true, data: values });
    } catch (error) { next(error); }
  }

  // ---- colour presets ----
  async listColorPresets(req, res, next) {
    try {
      res.json({ success: true, data: await service.listColorPresets(req.query) });
    } catch (error) { next(error); }
  }

  async createColorPreset(req, res, next) {
    try {
      res.status(201).json({ success: true, data: await service.createColorPreset(req.body) });
    } catch (error) { next(error); }
  }

  async updateColorPreset(req, res, next) {
    try {
      res.json({ success: true, data: await service.updateColorPreset(req.params.id, req.body) });
    } catch (error) { next(error); }
  }
}

module.exports = new ProductCategoriesController();
