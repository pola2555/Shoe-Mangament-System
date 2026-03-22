const boxTemplatesService = require('./box-templates.service');

class BoxTemplatesController {
  async list(req, res, next) {
    try {
      const templates = await boxTemplatesService.list(req.query);
      res.json({ success: true, data: templates });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const template = await boxTemplatesService.getById(req.params.id);
      res.json({ success: true, data: template });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const template = await boxTemplatesService.create(req.body);
      res.status(201).json({ success: true, data: template });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const template = await boxTemplatesService.update(req.params.id, req.body);
      res.json({ success: true, data: template });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await boxTemplatesService.delete(req.params.id);
      res.json({ success: true, message: 'Template deleted' });
    } catch (error) { next(error); }
  }
}

module.exports = new BoxTemplatesController();
