const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const barcodesService = require('../barcodes/barcodes.service');
const { generateUUID } = require('../../utils/generateCodes');
const { deleteFile } = require('../../middleware/upload');
const { thumbUrlFor, deleteThumbnail } = require('../../utils/thumbnails');
const { capabilities } = require('../../utils/schemaCapabilities');
const {
  categoryOfProduct, ensurePlaceholderColor, resolveVariantTarget, generateSku,
} = require('../../utils/variantIdentity');

/**
 * Index rows by a key column, for stitching grouped query results back onto parents.
 */
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

/**
 * Attach images to a list of colors using one query for all of them,
 * instead of one query per color. Mutates `colors` in place.
 */
async function attachColorImages(colors) {
  if (colors.length === 0) return colors;

  const images = await db('product_color_images')
    .whereIn('product_color_id', colors.map((c) => c.id))
    .orderBy('sort_order', 'asc');

  const byColor = groupBy(images, 'product_color_id');
  for (const color of colors) {
    color.images = byColor.get(color.id) || [];
  }
  return colors;
}

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
// 'category' used to appear in the update whitelist but no such column exists — it was
// silently unreachable because Joi strips unknown keys before the service sees them.
const CREATABLE_FIELDS = [
  'product_code', 'brand', 'model_name', 'description', 'category_id',
  'net_price', 'default_selling_price', 'min_selling_price', 'max_selling_price',
];
const UPDATABLE_FIELDS = [...CREATABLE_FIELDS, 'is_active'];

class ProductsService {
  /** Copy only the named keys that were actually supplied. */
  _pick(data, fields) {
    const out = {};
    for (const key of fields) {
      if (data[key] !== undefined) out[key] = data[key];
    }
    return out;
  }


  // ================================================================
  //  PRODUCTS
  // ================================================================

  async list({ search, brand, is_active, category_id } = {}) {
    // leftJoin, never join: a product whose category_id is still null (this feature
    // shipped before the backfill on any given environment) must not vanish from the
    // list. Same reason expenses left-joins its categories.
    let query = db('products')
      .leftJoin('product_categories as pc', 'pc.id', 'products.category_id')
      .leftJoin('size_scales as ss', 'ss.id', 'pc.size_scale_id')
      .select(
        'products.*',
        'pc.code as category_code',
        'pc.name_en as category_name_en',
        'pc.name_ar as category_name_ar',
        'pc.has_colors',
        'pc.has_sizes',
        'ss.display_prefix',
        'ss.display_suffix',
        'ss.is_numeric as scale_is_numeric'
      )
      .orderBy('products.created_at', 'desc')
      .limit(500);

    if (category_id) query = query.where('products.category_id', category_id);

    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('products.product_code', 'ilike', `%${safeSearch}%`)
          .orWhere('products.model_name', 'ilike', `%${safeSearch}%`)
          .orWhere('products.brand', 'ilike', `%${safeSearch}%`);
      });
    }
    if (brand) {
      const safeBrand = brand.replace(/[%_\\]/g, '\\$&');
      query = query.where('products.brand', 'ilike', `%${safeBrand}%`);
    }
    if (is_active !== undefined) query = query.where('products.is_active', is_active);

    const products = await query;
    if (products.length === 0) return products;

    const { productImageThumbs: hasThumbs } = await capabilities();

    // Enrichment used to run four queries per product — 500 products meant 2000
    // round-trips for one page load. Now it is four grouped queries in total,
    // executed in parallel.
    const productIds = products.map((p) => p.id);

    const [colors, images, variantCounts, stockCounts] = await Promise.all([
      db('product_colors')
        .whereIn('product_id', productIds)
        .select('id', 'product_id', 'color_name', 'hex_code'),

      // Exactly one image row per product. DISTINCT ON does the picking in the
      // database — selecting every image and keeping the first in JS meant pulling
      // the entire image table for 500 products just to discard almost all of it.
      // thumb_url is projected only when the column exists, so this still runs on a
      // database where migration 20260814_002 has not been applied.
      db('product_color_images')
        .join('product_colors', 'product_color_images.product_color_id', 'product_colors.id')
        .whereIn('product_colors.product_id', productIds)
        .distinctOn('product_colors.product_id')
        .orderBy('product_colors.product_id')
        .orderBy('product_color_images.is_primary', 'desc')
        .orderBy('product_color_images.sort_order', 'asc')
        .select(
          'product_colors.product_id',
          'product_color_images.image_url',
          ...(hasThumbs ? ['product_color_images.thumb_url'] : [])
        ),

      db('product_variants')
        .whereIn('product_id', productIds)
        .groupBy('product_id')
        .select('product_id')
        .count('id as count'),

      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .whereIn('product_variants.product_id', productIds)
        .where('inventory_items.status', 'in_stock')
        .groupBy('product_variants.product_id')
        .select('product_variants.product_id')
        .count('inventory_items.id as count'),
    ]);

    const colorsByProduct = groupBy(colors, 'product_id');
    // First row per product wins — the ORDER BY above already put the best image first.
    const imageByProduct = new Map();
    for (const img of images) {
      if (!imageByProduct.has(img.product_id)) imageByProduct.set(img.product_id, img);
    }
    const variantCountByProduct = new Map(variantCounts.map((r) => [r.product_id, parseInt(r.count, 10)]));
    const stockCountByProduct = new Map(stockCounts.map((r) => [r.product_id, parseInt(r.count, 10)]));

    for (const product of products) {
      const productColors = colorsByProduct.get(product.id) || [];
      product.colors = productColors.map(({ id, color_name, hex_code }) => ({ id, color_name, hex_code }));
      product.color_count = productColors.length;

      const image = imageByProduct.get(product.id);
      product.primary_image_url = image?.image_url || null;
      // Lists render small thumbnails — send the thumb so the client isn't made to
      // download a multi-megabyte original for a grid cell.
      product.primary_image_thumb_url = image?.thumb_url || image?.image_url || null;

      product.variant_count = variantCountByProduct.get(product.id) || 0;
      product.in_stock_count = stockCountByProduct.get(product.id) || 0;
    }

    return products;
  }

  async getById(id) {
    const product = await db('products').where('id', id).first();
    if (!product) throw new AppError('Product not found', 404);

    // Colors, variants and store prices are independent — fetch in parallel, and
    // pull every color's images in one query rather than one per color.
    const [colors, variants, storePrices, category] = await Promise.all([
      db('product_colors').where('product_id', id).orderBy('created_at', 'asc'),
      // size_sort, not size_eu: the latter is a varchar, so a plain sort puts '10'
      // before '9' and would put L before M before S once alpha sizes exist.
      //
      // The size list's own label comes along so the page can write "Kids" rather than
      // the 'KIDS' it is stored as. LEFT, always: a variant created before categories
      // existed has no scale value, and an inner join would hide it from its product.
      db('product_variants as v')
        .leftJoin('size_scale_values as ssv', 'ssv.id', 'v.size_scale_value_id')
        .where('v.product_id', id)
        .select('v.*', 'ssv.label_en as size_label_en', 'ssv.label_ar as size_label_ar')
        .orderBy(['v.size_sort', 'v.size_eu']),
      db('store_product_prices')
        .join('stores', 'store_product_prices.store_id', 'stores.id')
        .where('product_id', id)
        .select('store_product_prices.*', 'stores.name as store_name'),
      product.category_id
        ? db('product_categories as c')
          .join('size_scales as s', 's.id', 'c.size_scale_id')
          .where('c.id', product.category_id)
          .first(
            'c.id', 'c.code', 'c.name_en', 'c.name_ar', 'c.has_colors', 'c.has_sizes',
            'c.size_scale_id', 'c.placeholder_color_name',
            's.code as scale_code', 's.name_en as scale_name_en', 's.name_ar as scale_name_ar',
            's.display_prefix', 's.display_suffix', 's.is_numeric as scale_is_numeric'
          )
        : null,
    ]);

    await attachColorImages(colors);

    // The size list travels with the product so the variant matrix can render without
    // a second round-trip, and so it always matches the category the product is in.
    if (category) {
      category.size_values = await db('size_scale_values')
        .where({ scale_id: category.size_scale_id, is_active: true })
        .orderBy('sort_order');
    }

    return { ...product, colors, variants, store_prices: storePrices, category: category || null };
  }

  async create(data) {
    // Whitelisted, not spread. Joi strips unknown keys today, so a bare `...data` is
    // safe only for as long as every caller goes through validation — one internal
    // caller, or one schema gaining `.unknown(true)`, turns it into mass assignment.
    return db.transaction(async (trx) => {
      const [product] = await trx('products')
        .insert({ id: generateUUID(), ...this._pick(data, CREATABLE_FIELDS) })
        .returning('*');

      // A colourless category gets its placeholder colour up front, in the same
      // transaction, so no code path can ever observe such a product without one.
      const category = await categoryOfProduct(trx, product.id);
      if (!category.has_colors) {
        await ensurePlaceholderColor(trx, product.id, category);
      }
      return product;
    });
  }

  async update(id, data) {
    if (data.category_id !== undefined) await this._assertCategoryChangeAllowed(id, data.category_id);

    // Whitelist allowed fields to prevent mass assignment
    const allowed = UPDATABLE_FIELDS;
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

    await attachColorImages(colors);
    return colors;
  }

  async createColor(productId, data) {
    await this._ensureProductExists(productId);
    const category = await categoryOfProduct(db, productId);
    if (!category.has_colors) {
      throw new AppError('This product\'s category does not use colours', 400);
    }
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
    // The placeholder stands in for "no colour". Renaming it to something real would
    // put a made-up colour on labels and in reports.
    const current = await db('product_colors').where('id', colorId).first();
    if (current && current.is_placeholder) {
      throw new AppError('This product does not use colours, so its colour cannot be edited', 400);
    }

    const safeData = {};
    if (data.color_name !== undefined) safeData.color_name = data.color_name;
    if (data.hex_code !== undefined) safeData.hex_code = data.hex_code;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;
    const [color] = await db('product_colors')
      .where('id', colorId)
      .update(safeData)
      .returning('*');
    if (!color) throw new AppError('Color not found', 404);
    return color;
  }

  async deleteColor(colorId) {
    const current = await db('product_colors').where('id', colorId).first();
    if (current && current.is_placeholder) {
      // Deleting it would break the next variant create, which needs exactly one.
      throw new AppError('This product does not use colours, so its colour cannot be deleted', 400);
    }

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

  async addImage(colorId, imageUrl, originalName, thumbUrl = null) {
    const { productImageThumbs: hasThumbs } = await capabilities();
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
        // NULL when generation failed. Do not fall back to the derived path — that
        // file does not exist, and callers COALESCE thumb_url over image_url, so a
        // wrong-but-present value yields a broken image instead of the original.
        // Omitted entirely when the column does not exist yet.
        ...(hasThumbs ? { thumb_url: thumbUrl || null } : {}),
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

    // Clean up the actual file from storage, and its thumbnail, so neither orphans.
    try { await deleteFile(image.image_url); } catch { /* best effort */ }
    await deleteThumbnail(image.image_url);

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
      // LEFT: a variant that predates the categories feature has no scale value, and
      // an inner join would drop it from the product's own variant list.
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .where('product_variants.product_id', productId)
      .select(
        'product_variants.*',
        'product_colors.color_name',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar'
      )
      .orderBy(['product_colors.color_name', 'product_variants.size_sort', 'product_variants.size_eu']);
  }

  /**
   * Colour and size may both be omitted: a category with has_colors = false resolves
   * to the product's placeholder colour, and one with has_sizes = false resolves to
   * its scale's sole value. See utils/variantIdentity.js.
   */
  async createVariant(productId, data) {
    const product = await this._ensureProductExists(productId);

    // Mint the barcode in the same transaction as the insert. A variant that exists
    // without one would be invisible to the scanner until someone noticed and
    // backfilled it.
    return db.transaction(async (trx) => {
      const target = await resolveVariantTarget(trx, product, data);
      const sku = await generateSku(trx, product, target.color, target.size_eu);

      const [variant] = await trx('product_variants')
        .insert({
          id: generateUUID(),
          product_id: productId,
          product_color_id: target.color.id,
          size_eu: target.size_eu,
          size_sort: target.size_sort,
          size_scale_value_id: target.size_scale_value_id,
          size_us: data.size_us || null,
          size_uk: data.size_uk || null,
          size_cm: data.size_cm || null,
          sku,
        })
        .returning('*');

      const { barcode } = await barcodesService.assignForVariant(variant.id, trx);
      return { ...variant, barcode };
    });
  }

  /**
   * Create many variants at once.
   *
   * Two shapes are accepted:
   *   { color_id, variants: [{size_eu, ...}] }     one colour, explicit sizes
   *   { color_ids: [...], size_values: [...] }     the colour x size matrix
   *
   * The matrix form is what the product page sends. It is ONE call in ONE transaction:
   * the page used to fire a separate request per colour in parallel, so a failure
   * partway through left half a matrix created with no way to tell which half.
   *
   * Combinations that already exist are skipped rather than failing the batch —
   * re-running a matrix to fill in a newly added size is the normal way to use it.
   */
  async bulkCreateVariants(productId, colorId, variants, options = {}) {
    const product = await this._ensureProductExists(productId);

    return db.transaction(async (trx) => {
      const category = await categoryOfProduct(trx, productId);

      // Normalise both shapes into one list of {product_color_id, size_eu, ...}.
      let requested;
      if (options.color_ids || options.size_values) {
        const colorIds = options.color_ids && options.color_ids.length
          ? options.color_ids
          : [(await this._resolveDefaultColor(trx, product, category)).id];
        // null lets resolveVariantTarget pick the category's sole size.
        const sizes = options.size_values && options.size_values.length
          ? options.size_values
          : [null];
        requested = [];
        for (const cid of colorIds) {
          for (const size of sizes) requested.push({ product_color_id: cid, size_eu: size });
        }
      } else {
        // Each row may name its own colour, which is how the matrix sends an irregular
        // selection (not every colour stocked in every size). Falling back to the
        // top-level colour keeps the older one-colour callers working unchanged.
        requested = (variants || []).map((v) => ({
          ...v,
          product_color_id: v.product_color_id || colorId,
        }));
      }
      if (!requested.length) throw new AppError('Nothing to create', 400);

      const existing = await trx('product_variants')
        .where('product_id', productId)
        .select('product_color_id', 'size_eu');
      const seen = new Set(existing.map((e) => e.product_color_id + '::' + e.size_eu));

      const created = [];
      for (const req of requested) {
        const target = await resolveVariantTarget(trx, product, req, category);
        const key = target.color.id + '::' + target.size_eu;
        if (seen.has(key)) continue;
        seen.add(key);

        const sku = await generateSku(trx, product, target.color, target.size_eu);
        const [variant] = await trx('product_variants')
          .insert({
            id: generateUUID(),
            product_id: productId,
            product_color_id: target.color.id,
            size_eu: target.size_eu,
            size_sort: target.size_sort,
            size_scale_value_id: target.size_scale_value_id,
            size_us: req.size_us || null,
            size_uk: req.size_uk || null,
            size_cm: req.size_cm || null,
            sku,
          })
          .returning('*');

        const { barcode } = await barcodesService.assignForVariant(variant.id, trx);
        created.push({ ...variant, barcode });
      }
      return created;
    });
  }

  /** The colour to use when the caller named none — only valid for colourless categories. */
  async _resolveDefaultColor(trx, product, category) {
    if (category.has_colors) throw new AppError('A colour is required for this product', 400);
    return ensurePlaceholderColor(trx, product.id, category);
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

  /**
   * Moving a product between categories is only safe while it has no variants.
   *
   * An EU 42 variant means nothing under a Kids/Teens/Adults scale, and switching to a
   * colourless category would strand real colours behind a placeholder. Same posture as
   * everywhere else here: the old category can be deactivated, not silently reinterpreted.
   */
  async _assertCategoryChangeAllowed(productId, categoryId) {
    const product = await db('products').where('id', productId).first('category_id');
    if (!product) throw new AppError('Product not found', 404);
    if (product.category_id === categoryId) return;

    const target = await db('product_categories').where('id', categoryId).first();
    if (!target) throw new AppError('Category not found', 404);

    const current = product.category_id
      ? await db('product_categories').where('id', product.category_id).first()
      : null;

    const compatible = current
      && current.size_scale_id === target.size_scale_id
      && current.has_colors === target.has_colors
      && current.has_sizes === target.has_sizes;
    if (compatible) return;

    const { n } = await db('product_variants').where('product_id', productId).count('id as n').first();
    if (Number(n) > 0) {
      throw new AppError(
        `Cannot move this product to ${target.name_en}: it uses different sizes or colours, and `
        + `${n} variant(s) already exist. Products can only move between categories with the same setup.`,
        400
      );
    }
  }

  async _ensureProductExists(productId) {
    const product = await db('products').where('id', productId).first();
    if (!product) throw new AppError('Product not found', 404);
    return product;
  }
}

module.exports = new ProductsService();
