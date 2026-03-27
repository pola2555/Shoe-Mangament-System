const productsService = require('./products.service');
const { getUploadedUrl } = require('../../middleware/upload');

class ProductsController {
  // --- Products ---
  async list(req, res, next) {
    try {
      const products = await productsService.list(req.query);
      res.json({ success: true, data: products });
    } catch (error) { next(error); }
  }

  async getById(req, res, next) {
    try {
      const product = await productsService.getById(req.params.id);
      res.json({ success: true, data: product });
    } catch (error) { next(error); }
  }

  async create(req, res, next) {
    try {
      const product = await productsService.create(req.body);
      res.status(201).json({ success: true, data: product });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const product = await productsService.update(req.params.id, req.body);
      res.json({ success: true, data: product });
    } catch (error) { next(error); }
  }

  async toggleActive(req, res, next) {
    try {
      const product = await productsService.toggleActive(req.params.id);
      res.json({ success: true, data: product, message: product.is_active ? 'Product activated' : 'Product deactivated' });
    } catch (error) { next(error); }
  }

  // --- Colors ---
  async listColors(req, res, next) {
    try {
      const colors = await productsService.listColors(req.params.id);
      res.json({ success: true, data: colors });
    } catch (error) { next(error); }
  }

  async createColor(req, res, next) {
    try {
      const color = await productsService.createColor(req.params.id, req.body);
      res.status(201).json({ success: true, data: color });
    } catch (error) { next(error); }
  }

  async updateColor(req, res, next) {
    try {
      // Verify color belongs to this product
      const color = await require('../../config/database')('product_colors')
        .where({ id: req.params.colorId, product_id: req.params.id })
        .first();
      if (!color) return res.status(404).json({ success: false, message: 'Color not found for this product' });
      const updated = await productsService.updateColor(req.params.colorId, req.body);
      res.json({ success: true, data: updated });
    } catch (error) { next(error); }
  }

  async deleteColor(req, res, next) {
    try {
      // Verify color belongs to this product
      const color = await require('../../config/database')('product_colors')
        .where({ id: req.params.colorId, product_id: req.params.id })
        .first();
      if (!color) return res.status(404).json({ success: false, message: 'Color not found for this product' });
      await productsService.deleteColor(req.params.colorId);
      res.json({ success: true, message: 'Color deleted' });
    } catch (error) { next(error); }
  }

  // --- Images ---
  async uploadImage(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file provided' });
      }
      // Verify color belongs to this product
      const color = await require('../../config/database')('product_colors')
        .where({ id: req.params.colorId, product_id: req.params.id })
        .first();
      if (!color) return res.status(404).json({ success: false, message: 'Color not found for this product' });
      const imageUrl = getUploadedUrl('products', req.file);
      const image = await productsService.addImage(
        req.params.colorId,
        imageUrl,
        req.file.originalname
      );
      res.status(201).json({ success: true, data: image });
    } catch (error) { next(error); }
  }

  async setPrimaryImage(req, res, next) {
    try {
      // Verify image belongs to this product
      const db = require('../../config/database');
      const image = await db('product_color_images')
        .join('product_colors', 'product_color_images.product_color_id', 'product_colors.id')
        .where('product_color_images.id', req.params.imageId)
        .where('product_colors.product_id', req.params.id)
        .first();
      if (!image) return res.status(404).json({ success: false, message: 'Image not found for this product' });
      const result = await productsService.setPrimaryImage(req.params.imageId);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async deleteImage(req, res, next) {
    try {
      // Verify image belongs to this product
      const db = require('../../config/database');
      const image = await db('product_color_images')
        .join('product_colors', 'product_color_images.product_color_id', 'product_colors.id')
        .where('product_color_images.id', req.params.imageId)
        .where('product_colors.product_id', req.params.id)
        .first();
      if (!image) return res.status(404).json({ success: false, message: 'Image not found for this product' });
      await productsService.deleteImage(req.params.imageId);
      res.json({ success: true, message: 'Image deleted' });
    } catch (error) { next(error); }
  }

  // --- Variants ---
  async listVariants(req, res, next) {
    try {
      const variants = await productsService.listVariants(req.params.id);
      res.json({ success: true, data: variants });
    } catch (error) { next(error); }
  }

  async createVariant(req, res, next) {
    try {
      const variant = await productsService.createVariant(req.params.id, req.body);
      res.status(201).json({ success: true, data: variant });
    } catch (error) { next(error); }
  }

  async bulkCreateVariants(req, res, next) {
    try {
      const variants = await productsService.bulkCreateVariants(
        req.params.id,
        req.body.product_color_id,
        req.body.variants
      );
      res.status(201).json({ success: true, data: variants });
    } catch (error) { next(error); }
  }

  async updateVariant(req, res, next) {
    try {
      // Verify variant belongs to this product
      const variant = await require('../../config/database')('product_variants')
        .where({ id: req.params.variantId, product_id: req.params.id })
        .first();
      if (!variant) return res.status(404).json({ success: false, message: 'Variant not found for this product' });
      const updated = await productsService.updateVariant(req.params.variantId, req.body);
      res.json({ success: true, data: updated });
    } catch (error) { next(error); }
  }

  async deleteVariant(req, res, next) {
    try {
      // Verify variant belongs to this product
      const variant = await require('../../config/database')('product_variants')
        .where({ id: req.params.variantId, product_id: req.params.id })
        .first();
      if (!variant) return res.status(404).json({ success: false, message: 'Variant not found for this product' });
      await productsService.deleteVariant(req.params.variantId);
      res.json({ success: true, message: 'Variant deleted' });
    } catch (error) { next(error); }
  }

  // --- Store Prices ---
  async getStorePrices(req, res, next) {
    try {
      const prices = await productsService.getStorePrices(req.params.id);
      res.json({ success: true, data: prices });
    } catch (error) { next(error); }
  }

  async setStorePrice(req, res, next) {
    try {
      // Verify user has access to this store (non-admins must be assigned to it)
      if (req.user.role_name !== 'admin') {
        const userStore = await require('../../config/database')('user_stores')
          .where({ user_id: req.user.id, store_id: req.params.storeId }).first();
        if (!userStore) return res.status(403).json({ success: false, message: 'You do not have access to this store' });
      }
      const price = await productsService.setStorePrice(
        req.params.id,
        req.params.storeId,
        req.body
      );
      res.json({ success: true, data: price });
    } catch (error) { next(error); }
  }

  async deleteStorePrice(req, res, next) {
    try {
      // Verify user has access to this store (non-admins must be assigned to it)
      if (req.user.role_name !== 'admin') {
        const userStore = await require('../../config/database')('user_stores')
          .where({ user_id: req.user.id, store_id: req.params.storeId }).first();
        if (!userStore) return res.status(403).json({ success: false, message: 'You do not have access to this store' });
      }
      await productsService.deleteStorePrice(req.params.id, req.params.storeId);
      res.json({ success: true, message: 'Store price removed' });
    } catch (error) { next(error); }
  }
}

module.exports = new ProductsController();
