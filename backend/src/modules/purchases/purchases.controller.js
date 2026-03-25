const purchasesService = require('./purchases.service');
const { getFileUrl } = require('../../middleware/upload');
const db = require('../../config/database');
const { generateUUID } = require('../../utils/generateCodes');

class PurchasesController {
  // --- Invoices ---
  async listInvoices(req, res, next) {
    try {
      const invoices = await purchasesService.listInvoices(req.query);
      res.json({ success: true, data: invoices });
    } catch (error) { next(error); }
  }

  async getInvoice(req, res, next) {
    try {
      const invoice = await purchasesService.getInvoiceById(req.params.id);
      res.json({ success: true, data: invoice });
    } catch (error) { next(error); }
  }

  async createInvoice(req, res, next) {
    try {
      const invoice = await purchasesService.createInvoice(req.body, req.user.id);
      res.status(201).json({ success: true, data: invoice });
    } catch (error) { next(error); }
  }

  async updateInvoice(req, res, next) {
    try {
      const invoice = await purchasesService.updateInvoice(req.params.id, req.body);
      res.json({ success: true, data: invoice });
    } catch (error) { next(error); }
  }

  async uploadPrimaryImage(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file provided' });
      }
      const fileUrl = getFileUrl('invoices', req.file.filename);
      const invoice = await purchasesService.uploadPrimaryImage(req.params.id, fileUrl);
      res.json({ success: true, data: invoice });
    } catch (error) { next(error); }
  }

  async deleteInvoice(req, res, next) {
    try {
      await purchasesService.deleteInvoice(req.params.id);
      res.json({ success: true, message: 'Invoice deleted successfully' });
    } catch (error) { next(error); }
  }

  // --- Boxes ---
  async addBox(req, res, next) {
    try {
      const box = await purchasesService.addBox(req.params.id, req.body);
      res.status(201).json({ success: true, data: box });
    } catch (error) { next(error); }
  }

  async updateBox(req, res, next) {
    try {
      const box = await purchasesService.updateBox(req.params.boxId, req.body);
      res.json({ success: true, data: box });
    } catch (error) { next(error); }
  }

  async deleteBox(req, res, next) {
    try {
      await purchasesService.deleteBox(req.params.boxId);
      res.json({ success: true, message: 'Box deleted' });
    } catch (error) { next(error); }
  }

  async setBoxItems(req, res, next) {
    try {
      const items = await purchasesService.setBoxItems(req.params.boxId, req.body.items);
      res.json({ success: true, data: items });
    } catch (error) { next(error); }
  }

  async completeBox(req, res, next) {
    try {
      const box = await purchasesService.completeBox(req.params.boxId);
      res.json({ success: true, data: box, message: 'Box completed — inventory items created' });
    } catch (error) { next(error); }
  }

  // --- Invoice Images ---
  async uploadInvoiceImage(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
      // Verify invoice exists
      const invoice = await db('purchase_invoices').where('id', req.params.id).first();
      if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
      const imageUrl = getFileUrl('invoices', req.file.filename);
      const [image] = await db('attached_images').insert({
        id: generateUUID(),
        entity_type: 'purchase_invoice',
        entity_id: req.params.id,
        image_url: imageUrl,
        original_name: req.file.originalname,
      }).returning('*');
      res.status(201).json({ success: true, data: image });
    } catch (error) { next(error); }
  }

  async deleteInvoiceImage(req, res, next) {
    try {
      // Verify image belongs to the specified invoice
      const image = await db('attached_images').where({
        id: req.params.imageId,
        entity_type: 'purchase_invoice',
        entity_id: req.params.id,
      }).first();
      if (!image) return res.status(404).json({ success: false, message: 'Image not found' });
      await db('attached_images').where('id', req.params.imageId).del();
      res.json({ success: true, message: 'Image deleted' });
    } catch (error) { next(error); }
  }

  // --- Supplier Payments ---
  async listPayments(req, res, next) {
    try {
      const payments = await purchasesService.listPayments(req.query);
      res.json({ success: true, data: payments });
    } catch (error) { next(error); }
  }

  async getPayment(req, res, next) {
    try {
      const payment = await purchasesService.getPaymentById(req.params.id);
      res.json({ success: true, data: payment });
    } catch (error) { next(error); }
  }

  async createPayment(req, res, next) {
    try {
      const payment = await purchasesService.createPayment(req.body, req.user.id);
      res.status(201).json({ success: true, data: payment });
    } catch (error) { next(error); }
  }

  // --- Payment Images (proof of transfer) ---
  async uploadPaymentImage(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
      // Verify payment exists
      const payment = await db('supplier_payments').where('id', req.params.id).first();
      if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
      const imageUrl = getFileUrl('payments', req.file.filename);
      // Note: supplier payments are global (not store-scoped) — permission middleware controls access
      const [image] = await db('attached_images').insert({
        id: generateUUID(),
        entity_type: 'supplier_payment',
        entity_id: req.params.id,
        image_url: imageUrl,
        original_name: req.file.originalname,
      }).returning('*');
      res.status(201).json({ success: true, data: image });
    } catch (error) { next(error); }
  }
}

module.exports = new PurchasesController();
