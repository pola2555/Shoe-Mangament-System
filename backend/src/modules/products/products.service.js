const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Products service — CRUD for products, colors, images, variants, and store pricing.
 * 
 * Product hierarchy:
 *   Product → Colors (each with images) → Variants (each with sizes + SKU)
 * 
 * SKU auto-generation:
 *   product_code + color abbreviation (first 3 letters) + EU size
 *   e.g., "NAM90-BLK-42"
 */
class ProductsService {

  // ================================================================
  //  PRODUCTS
  // ================================================================

  async list({ search, brand, is_active } = {}) {
    let query = db('products').orderBy('created_at', 'desc').limit(500);

    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('product_code', 'ilike', `%${safeSearch}%`)
          .orWhere('model_name', 'ilike', `%${safeSearch}%`)
          .orWhere('brand', 'ilike', `%${safeSearch}%`);
      });
    }
    if (brand) {
      const safeBrand = brand.replace(/[%_\\]/g, '\\$&');
      query = query.where('brand', 'ilike', `%${safeBrand}%`);
    }
    if (is_active !== undefined) query = query.where('is_active', is_active);

    const products = await query;

    // Enrich each product with primary image, color swatches, and variant count
    for (const product of products) {
      // Get colors with their primary image
      const colors = await db('product_colors')
        .where('product_id', product.id)
        .select('id', 'color_name', 'hex_code');

      product.colors = colors;
      product.color_count = colors.length;

      // Get the primary image across all colors (first primary image found)
      const primaryImage = await db('product_color_images')
        .whereIn('product_color_id', colors.map(c => c.id))
        .where('is_primary', true)
        .first();

      product.primary_image_url = primaryImage ? primaryImage.image_url : null;

      // If no primary, get any first image
      if (!product.primary_image_url && colors.length > 0) {
        const anyImage = await db('product_color_images')
          .whereIn('product_color_id', colors.map(c => c.id))
          .orderBy('sort_order', 'asc')
          .first();
        product.primary_image_url = anyImage ? anyImage.image_url : null;
      }

      // Variant count
      const vc = await db('product_variants')
        .where('product_id', product.id)
        .count('id as count')
        .first();
      product.variant_count = parseInt(vc.count) || 0;

      // In-stock count
      const sc = await db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .where('product_variants.product_id', product.id)
        .where('inventory_items.status', 'in_stock')
        .count('inventory_items.id as count')
        .first();
      product.in_stock_count = parseInt(sc.count) || 0;
    }

    return products;
  }

  async getById(id) {
    const product = await db('products').where('id', id).first();
    if (!product) throw new AppError('Product not found', 404);

    // Fetch colors with their images
    const colors = await db('product_colors')
      .where('product_id', id)
      .orderBy('created_at', 'asc');

    for (const color of colors) {
      color.images = await db('product_color_images')
        .where('product_color_id', color.id)
        .orderBy('sort_order', 'asc');
    }

    // Fetch variants grouped by color
    const variants = await db('product_variants')
      .where('product_id', id)
      .orderBy('size_eu', 'asc');

    // Fetch store prices
    const storePrices = await db('store_product_prices')
      .join('stores', 'store_product_prices.store_id', 'stores.id')
      .where('product_id', id)
      .select(
        'store_product_prices.*',
        'stores.name as store_name'
      );

    return { ...product, colors, variants, store_prices: storePrices };
  }

  async create(data) {
    const [product] = await db('products')
      .insert({ id: generateUUID(), ...data })
      .returning('*');
    return product;
  }

  async update(id, data) {
    // Whitelist allowed fields to prevent mass assignment
    const allowed = ['model_name', 'product_code', 'brand', 'category', 'description',
      'default_selling_price', 'min_selling_price', 'max_selling_price', 'net_price', 'is_active'];
    const safeData = {};
    for (const key of allowed) {
      if (data[key] !== undefined) safeData[key] = data[key];
    }
    safeData.updated_at = new Date();
    const [product] = await db('products')
      .where('id', id)
      .update(safeData)
      .returning('*');
    if (!product) throw new AppError('Product not found', 404);
    return product;
  }

  // ================================================================
  //  COLORS
  // ================================================================

  async listColors(productId) {
    await this._ensureProductExists(productId);
    const colors = await db('product_colors')
      .where('product_id', productId)
      .orderBy('created_at', 'asc');

    for (const color of colors) {
      color.images = await db('product_color_images')
        .where('product_color_id', color.id)
        .orderBy('sort_order', 'asc');
    }
    return colors;
  }

  async createColor(productId, data) {
    await this._ensureProductExists(productId);
    const [color] = await db('product_colors')
      .insert({
        id: generateUUID(),
        product_id: productId,
        color_name: data.color_name,
        hex_code: data.hex_code || null,
      })
      .returning('*');
    return color;
  }

  async updateColor(colorId, data) {
    const safeData = {};
    if (data.color_name !== undefined) safeData.color_name = data.color_name;
    if (data.hex_code !== undefined) safeData.hex_code = data.hex_code;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;
    safeData.updated_at = new Date();
    const [color] = await db('product_colors')
      .where('id', colorId)
      .update(safeData)
      .returning('*');
    if (!color) throw new AppError('Color not found', 404);
    return color;
  }

  async deleteColor(colorId) {
    // Check if variants exist for this color
    const variantCount = await db('product_variants')
      .where('product_color_id', colorId)
      .count('id as count')
      .first();

    if (parseInt(variantCount.count) > 0) {
      throw new AppError('Cannot delete color with existing variants. Deactivate it instead.', 400);
    }

    await db('product_color_images').where('product_color_id', colorId).del();
    const deleted = await db('product_colors').where('id', colorId).del();
    if (!deleted) throw new AppError('Color not found', 404);
  }

  // ================================================================
  //  IMAGES
  // ================================================================

  async addImage(colorId, imageUrl, originalName) {
    // Check if color exists
    const color = await db('product_colors').where('id', colorId).first();
    if (!color) throw new AppError('Color not found', 404);

    // Check if this is the first image → make it primary
    const existingCount = await db('product_color_images')
      .where('product_color_id', colorId)
      .count('id as count')
      .first();

    const isPrimary = parseInt(existingCount.count) === 0;

    const [image] = await db('product_color_images')
      .insert({
        id: generateUUID(),
        product_color_id: colorId,
        image_url: imageUrl,
        is_primary: isPrimary,
        sort_order: parseInt(existingCount.count),
      })
      .returning('*');

    return image;
  }

  async setPrimaryImage(imageId) {
    const image = await db('product_color_images').where('id', imageId).first();
    if (!image) throw new AppError('Image not found', 404);

    // Unset all other primaries for this color
    await db('product_color_images')
      .where('product_color_id', image.product_color_id)
      .update({ is_primary: false });

    // Set this one as primary
    const [updated] = await db('product_color_images')
      .where('id', imageId)
      .update({ is_primary: true })
      .returning('*');

    return updated;
  }

  async deleteImage(imageId) {
    const image = await db('product_color_images').where('id', imageId).first();
    if (!image) throw new AppError('Image not found', 404);

    await db('product_color_images').where('id', imageId).del();

    // If deleted image was primary, make the first remaining image primary
    if (image.is_primary) {
      const firstRemaining = await db('product_color_images')
        .where('product_color_id', image.product_color_id)
        .orderBy('sort_order', 'asc')
        .first();
      if (firstRemaining) {
        await db('product_color_images')
          .where('id', firstRemaining.id)
          .update({ is_primary: true });
      }
    }

    return image;
  }

  // ================================================================
  //  VARIANTS
  // ================================================================

  async listVariants(productId) {
    await this._ensureProductExists(productId);
    return db('product_variants')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .where('product_variants.product_id', productId)
      .select(
        'product_variants.*',
        'product_colors.color_name'
      )
      .orderBy(['product_colors.color_name', 'product_variants.size_eu']);
  }

  async createVariant(productId, data) {
    const product = await this._ensureProductExists(productId);
    const color = await db('product_colors').where('id', data.product_color_id).first();
    if (!color) throw new AppError('Color not found', 404);

    // Auto-generate SKU: PRODUCT_CODE-COLOR_ABBR-SIZE
    const colorAbbr = color.color_name.substring(0, 3).toUpperCase();
    const sku = `${product.product_code}-${colorAbbr}-${data.size_eu}`;

    const [variant] = await db('product_variants')
      .insert({
        id: generateUUID(),
        product_id: productId,
        product_color_id: data.product_color_id,
        size_eu: data.size_eu,
        size_us: data.size_us || null,
        size_uk: data.size_uk || null,
        size_cm: data.size_cm || null,
        sku,
      })
      .returning('*');

    return variant;
  }

  async bulkCreateVariants(productId, colorId, variants) {
    const product = await this._ensureProductExists(productId);
    const color = await db('product_colors').where('id', colorId).first();
    if (!color) throw new AppError('Color not found', 404);

    const colorAbbr = color.color_name.substring(0, 3).toUpperCase();

    const rows = variants.map((v) => ({
      id: generateUUID(),
      product_id: productId,
      product_color_id: colorId,
      size_eu: v.size_eu,
      size_us: v.size_us || null,
      size_uk: v.size_uk || null,
      size_cm: v.size_cm || null,
      sku: `${product.product_code}-${colorAbbr}-${v.size_eu}`,
    }));

    const created = await db('product_variants').insert(rows).returning('*');
    return created;
  }

  async updateVariant(variantId, data) {
    const safeData = {};
    if (data.size_us !== undefined) safeData.size_us = data.size_us;
    if (data.size_uk !== undefined) safeData.size_uk = data.size_uk;
    if (data.size_cm !== undefined) safeData.size_cm = data.size_cm;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;
    safeData.updated_at = new Date();
    const [variant] = await db('product_variants')
      .where('id', variantId)
      .update(safeData)
      .returning('*');
    if (!variant) throw new AppError('Variant not found', 404);
    return variant;
  }

  // ================================================================
  //  STORE PRICES
  // ================================================================

  async getStorePrices(productId) {
    await this._ensureProductExists(productId);
    return db('store_product_prices')
      .join('stores', 'store_product_prices.store_id', 'stores.id')
      .where('product_id', productId)
      .select(
        'store_product_prices.*',
        'stores.name as store_name'
      );
  }

  async setStorePrice(productId, storeId, data) {
    await this._ensureProductExists(productId);

    // Check if store exists
    const store = await db('stores').where('id', storeId).first();
    if (!store) throw new AppError('Store not found', 404);

    const safeData = {};
    if (data.selling_price !== undefined) safeData.selling_price = data.selling_price;
    if (data.min_selling_price !== undefined) safeData.min_selling_price = data.min_selling_price;
    if (data.max_selling_price !== undefined) safeData.max_selling_price = data.max_selling_price;

    // Upsert: insert or update
    const existing = await db('store_product_prices')
      .where({ product_id: productId, store_id: storeId })
      .first();

    if (existing) {
      const [price] = await db('store_product_prices')
        .where('id', existing.id)
        .update({ ...safeData, updated_at: new Date() })
        .returning('*');
      return price;
    }

    const [price] = await db('store_product_prices')
      .insert({
        id: generateUUID(),
        product_id: productId,
        store_id: storeId,
        ...safeData,
      })
      .returning('*');
    return price;
  }

  async toggleActive(id) {
    const product = await db('products').where('id', id).first();
    if (!product) throw new AppError('Product not found', 404);
    const [updated] = await db('products').where('id', id)
      .update({ is_active: !product.is_active, updated_at: new Date() }).returning('*');
    return updated;
  }

  async deleteVariant(variantId) {
    // Check if any inventory items reference this variant
    const invCount = await db('inventory_items').where('variant_id', variantId).count('id as count').first();
    if (parseInt(invCount.count) > 0) {
      throw new AppError('Cannot delete variant with existing inventory items. Deactivate it instead.', 400);
    }
    const count = await db('product_variants').where('id', variantId).del();
    if (!count) throw new AppError('Variant not found', 404);
  }

  async deleteStorePrice(productId, storeId) {
    const deleted = await db('store_product_prices')
      .where({ product_id: productId, store_id: storeId })
      .del();
    if (!deleted) throw new AppError('Store price not found', 404);
  }

  // ================================================================
  //  HELPERS
  // ================================================================

  async _ensureProductExists(productId) {
    const product = await db('products').where('id', productId).first();
    if (!product) throw new AppError('Product not found', 404);
    return product;
  }
}

module.exports = new ProductsService();
