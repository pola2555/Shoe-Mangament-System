const salesService = require('./sales.service');
const db = require('../../config/database');
const { generateUUID } = require('../../utils/generateCodes');
const { getFileUrl } = require('../../middleware/upload');

class SalesController {
  async list(req, res, next) {
    try {
      const sales = await salesService.list(req.query);
      res.json({ success: true, data: sales });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const sale = await salesService.getById(req.params.id);
      res.json({ success: true, data: sale });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const sale = await salesService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: sale });
    } catch (error) { next(error); }
  }

  async addPayment(req, res, next) {
    try {
      const payment = await salesService.addPayment(req.params.id, req.body);
      res.status(201).json({ success: true, data: payment });
    } catch (error) { next(error); }
  }

  async uploadPaymentImage(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
      const imageUrl = getFileUrl('payments', req.file.filename);
      const [image] = await db('attached_images').insert({
        id: generateUUID(),
        entity_type: 'sale_payment',
        entity_id: req.params.paymentId,
        image_url: imageUrl,
        original_name: req.file.originalname,
      }).returning('*');
      res.status(201).json({ success: true, data: image });
    } catch (error) { next(error); }
  }
}

module.exports = new SalesController();
