const productsService = require('./products.service');
const { getFileUrl } = require('../../middleware/upload');

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
      const color = await productsService.updateColor(req.params.colorId, req.body);
      res.json({ success: true, data: color });
    } catch (error) { next(error); }
  }

  async deleteColor(req, res, next) {
    try {
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
      const imageUrl = getFileUrl('products', req.file.filename);
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
      const image = await productsService.setPrimaryImage(req.params.imageId);
      res.json({ success: true, data: image });
    } catch (error) { next(error); }
  }

  async deleteImage(req, res, next) {
    try {
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
      const variant = await productsService.updateVariant(req.params.variantId, req.body);
      res.json({ success: true, data: variant });
    } catch (error) { next(error); }
  }

  async deleteVariant(req, res, next) {
    try {
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
      await productsService.deleteStorePrice(req.params.id, req.params.storeId);
      res.json({ success: true, message: 'Store price removed' });
    } catch (error) { next(error); }
  }
}

module.exports = new ProductsController();
