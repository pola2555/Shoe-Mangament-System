const transfersService = require('./transfers.service');

class TransfersController {
  async list(req, res, next) {
    try {
      const transfers = await transfersService.list(req.query);
      res.json({ success: true, data: transfers });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const transfer = await transfersService.getById(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const transfer = await transfersService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async ship(req, res, next) {
    try {
      const transfer = await transfersService.ship(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async receive(req, res, next) {
    try {
      const transfer = await transfersService.receive(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }

  async cancel(req, res, next) {
    try {
      const transfer = await transfersService.cancel(req.params.id);
      res.json({ success: true, data: transfer });
    } catch (error) { next(error); }
  }
}

module.exports = new TransfersController();
