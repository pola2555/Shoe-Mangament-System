const inventoryService = require('./inventory.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const env = require('../../config/env');

function isAllowedExportImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const bucket = env.storage?.s3?.bucket;
    if (!bucket) return true;

    // Path-style S3 URL: s3.region.amazonaws.com/bucket/key
    const pathStyle = parsed.hostname.includes('amazonaws.com') && parsed.pathname.startsWith(`/${bucket}/`);
    // Virtual-hosted S3 URL: bucket.s3.region.amazonaws.com/key
    const virtualHosted = parsed.hostname === `${bucket}.s3.${env.storage.s3.region}.amazonaws.com`;

    return pathStyle || virtualHosted;
  } catch {
    return false;
  }
}

class InventoryController {
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
      const items = await inventoryService.list(filters);
      res.json({ success: true, data: items });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const filters = { ...req.query };
      if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
        if (req.user.assigned_stores?.length > 0) {
          filters.store_ids = req.user.assigned_stores;
        } else {
          filters.store_id = req.user.store_id;
        }
      }
      const data = await inventoryService.summary(filters);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async manualEntry(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      const result = await inventoryService.manualEntry(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async exportImageProxy(req, res, next) {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'Missing image url' });
      }

      if (!isAllowedExportImageUrl(url)) {
        throw new AppError('Image URL is not allowed for export', 400);
      }

      const response = await fetch(url);
      if (!response.ok) {
        return res.status(404).json({ success: false, message: 'Image not found' });
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('image/')) {
        return res.status(400).json({ success: false, message: 'Invalid image content' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(buffer);
    } catch (error) {
      return next(error);
    }
  }

  async markDamaged(req, res, next) {
    try {
      // Verify item is in user's store
      const item = await db('inventory_items').where('id', req.params.id).first();
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
      if (!userHasStoreAccess(req.user, item.store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const result = await inventoryService.markDamaged(req.params.id, req.body.notes);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }
}

module.exports = new InventoryController();
