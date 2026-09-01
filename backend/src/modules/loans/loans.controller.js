const loansService = require('./loans.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');
const { getUploadedUrl, deleteFile } = require('../../middleware/upload');
const { generateThumbnail } = require('../../utils/thumbnails');

/**
 * Fetch a loan and confirm the caller may touch it.
 *
 * A loan with no store belongs to the business rather than to a branch, so it is
 * reachable by anyone who can read loans — the same rule the list query applies.
 */
async function loadLoanForUser(user, id) {
  const loan = await db('loans').where('id', id).first();
  if (!loan) throw new AppError('Loan not found', 404);
  const unrestricted = user.role_name === 'admin' || user.permissions?.all_stores;
  if (!unrestricted && loan.store_id && !userHasStoreAccess(user, loan.store_id)) {
    throw new AppError('Access denied', 403);
  }
  return loan;
}

class LoansController {
  async list(req, res, next) {
    try {
      // Drop any client-supplied store filter, then re-derive it from the user. This
      // route previously passed req.query straight through, so every user saw every
      // store's loans and could target one by hand.
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      const loans = await loansService.list(filters);
      res.json({ success: true, data: loans });
    } catch (error) { next(error); }
  }

  async outstanding(req, res, next) {
    try {
      const { store_id: _s, store_ids: _si, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      res.json({ success: true, data: await loansService.outstanding(filters) });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      res.json({ success: true, data: await loansService.getById(req.params.id) });
    } catch (error) { next(error); }
  }

  async statement(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      res.json({ success: true, data: await loansService.statement(req.params.id) });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot create a loan for another store', 403);
      }
      const loan = await loansService.create(req.body, req.user.id);
      res.status(201).json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      if (req.body.store_id && !userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: cannot move a loan to another store', 403);
      }
      const loan = await loansService.update(req.params.id, req.body);
      res.json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async delete(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      await loansService.delete(req.params.id);
      res.json({ success: true, message: 'Loan deleted' });
    } catch (error) { next(error); }
  }

  async addPayment(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      const { loan, payment_id } = await loansService.addPayment(req.params.id, req.body, req.user.id);
      // payment_id comes back so the client can attach proof without a second lookup.
      res.status(201).json({ success: true, data: loan, payment_id });
    } catch (error) { next(error); }
  }

  async deletePayment(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      const loan = await loansService.deletePayment(req.params.id, req.params.paymentId);
      res.json({ success: true, data: loan });
    } catch (error) { next(error); }
  }

  async setInstallments(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      const rows = await loansService.setInstallments(req.params.id, req.body);
      res.json({ success: true, data: rows });
    } catch (error) { next(error); }
  }

  // --- payment proof ---
  async listPaymentProof(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      res.json({ success: true, data: await loansService.listPaymentProof(req.params.paymentId) });
    } catch (error) { next(error); }
  }

  async uploadPaymentProof(req, res, next) {
    try {
      if (!req.file) throw new AppError('No file provided', 400);
      await loadLoanForUser(req.user, req.params.id);
      const imageUrl = getUploadedUrl('loans', req.file);
      const thumbUrl = await generateThumbnail('loans', req.file);
      const row = await loansService.addPaymentProof(req.params.id, req.params.paymentId, {
        image_url: imageUrl,
        thumb_url: thumbUrl,
        original_name: req.file.originalname,
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) { next(error); }
  }

  async deletePaymentProof(req, res, next) {
    try {
      await loadLoanForUser(req.user, req.params.id);
      const row = await db('attached_images')
        .where({ id: req.params.imageId, entity_type: 'loan_payment', entity_id: req.params.paymentId })
        .first();
      if (!row) throw new AppError('Image not found', 404);
      await db('attached_images').where('id', row.id).del();
      try { await deleteFile(row.image_url); } catch { /* best effort */ }
      try { if (row.thumb_url) await deleteFile(row.thumb_url); } catch { /* best effort */ }
      res.json({ success: true, message: 'Image deleted' });
    } catch (error) { next(error); }
  }
}

module.exports = new LoansController();
