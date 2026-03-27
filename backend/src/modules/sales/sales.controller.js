const salesService = require('./sales.service');
const db = require('../../config/database');
const { generateUUID } = require('../../utils/generateCodes');
const { getUploadedUrl } = require('../../middleware/upload');
const { userHasStoreAccess } = require('../../middleware/auth');

class SalesController {
  async list(req, res, next) {
    try {
      const filters = { ...req.query };
      // Enforce store scoping for non-admin users
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        if (req.user.assigned_stores?.length > 0) {
          filters.store_ids = req.user.assigned_stores;
        } else {
          filters.store_id = req.user.store_id;
        }
      }
      const sales = await salesService.list(filters);
      res.json({ success: true, data: sales });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const sale = await salesService.getById(req.params.id);
      // Enforce store scoping for non-admin users
      if (!userHasStoreAccess(req.user, sale.store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
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
      // Verify store access before allowing payment
      const sale = await db('sales').where('id', req.params.id).first();
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (!userHasStoreAccess(req.user, sale.store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const payment = await salesService.addPayment(req.params.id, req.body);
      res.status(201).json({ success: true, data: payment });
    } catch (error) { next(error); }
  }

  async uploadPaymentImage(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
      // Verify sale and payment exist and are related
      const sale = await db('sales').where('id', req.params.id).first();
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      // Enforce store scoping
      if (!userHasStoreAccess(req.user, sale.store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const payment = await db('sale_payments').where({ id: req.params.paymentId, sale_id: req.params.id }).first();
      if (!payment) return res.status(404).json({ success: false, message: 'Payment not found for this sale' });
      const imageUrl = getUploadedUrl('payments', req.file);
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
