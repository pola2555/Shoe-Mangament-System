const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Inventory service — view, filter, and manually add inventory items.
 * 
 * Every physical shoe is one row in inventory_items.
 * Items are auto-created when boxes are marked complete (see purchases service).
 * This module provides manual entry for legacy/pre-system stock and viewing/filtering.
 */
class InventoryService {
  async list({ store_id, product_id, variant_id, status, source, search, size_min, size_max, supplier_id } = {}) {
    let query = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .join('stores', 'inventory_items.store_id', 'stores.id')
      .leftJoin('store_product_prices', function() {
        this.on('store_product_prices.product_id', '=', 'products.id')
            .andOn('store_product_prices.store_id', '=', 'inventory_items.store_id');
      })
      .select(
        'inventory_items.*',
        'product_variants.sku',
        'product_variants.size_eu',
        'product_variants.size_us',
        'product_variants.size_uk',
        'product_variants.size_cm',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.default_selling_price',
        'products.min_selling_price',
        'products.max_selling_price',
        'store_product_prices.selling_price as store_selling_price',
        'store_product_prices.min_selling_price as store_min_selling_price',
        'store_product_prices.max_selling_price as store_max_selling_price',
        'product_colors.color_name',
        'product_colors.hex_code',
        'stores.name as store_name'
      )
      .orderBy('inventory_items.created_at', 'desc');

    if (store_id) query = query.where('inventory_items.store_id', store_id);
    if (variant_id) query = query.where('inventory_items.variant_id', variant_id);
    if (status) query = query.where('inventory_items.status', status);
    if (source) query = query.where('inventory_items.source', source);
    if (product_id) query = query.where('products.id', product_id);
    if (search) {
      query = query.where(function () {
        this.where('product_variants.sku', 'ilike', `%${search}%`)
          .orWhere('products.model_name', 'ilike', `%${search}%`)
          .orWhere('products.product_code', 'ilike', `%${search}%`)
          .orWhere('products.brand', 'ilike', `%${search}%`);
      });
    }
    if (size_min) query = query.where('product_variants.size_eu', '>=', size_min);
    if (size_max) query = query.where('product_variants.size_eu', '<=', size_max);
    if (supplier_id) {
      query = query
        .join('purchase_invoice_boxes', 'inventory_items.invoice_box_id', 'purchase_invoice_boxes.id')
        .join('purchase_invoices', 'purchase_invoice_boxes.invoice_id', 'purchase_invoices.id')
        .where('purchase_invoices.supplier_id', supplier_id);
    }

    // Limit to 500 to avoid huge queries
    return query.limit(500);
  }

  /**
   * Get a summary of inventory: grouped by product variant + store with counts.
   */
  async summary({ store_id, search, size_min, size_max } = {}) {
    let query = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .join('stores', 'inventory_items.store_id', 'stores.id')
      .leftJoin('store_product_prices', function() {
        this.on('store_product_prices.product_id', '=', 'products.id')
            .andOn('store_product_prices.store_id', '=', 'inventory_items.store_id');
      })
      .where('inventory_items.status', 'in_stock')
      .select(
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.default_selling_price',
        'products.min_selling_price',
        'products.max_selling_price',
        'store_product_prices.selling_price as store_selling_price',
        'store_product_prices.min_selling_price as store_min_selling_price',
        'store_product_prices.max_selling_price as store_max_selling_price',
        'product_colors.color_name',
        'product_colors.hex_code',
        'product_variants.size_eu',
        'product_variants.sku',
        'stores.id as store_id',
        'stores.name as store_name',
        db.raw('COUNT(inventory_items.id) as quantity'),
        db.raw('AVG(inventory_items.cost) as avg_cost'),
        db.raw(`(
          SELECT pci.image_url 
          FROM product_color_images pci
          JOIN product_colors pc ON pci.product_color_id = pc.id
          WHERE pc.product_id = products.id 
          ORDER BY pci.is_primary DESC, pci.created_at ASC 
          LIMIT 1
        ) as product_image`)
      )
      .groupBy(
        'products.id', 'products.product_code', 'products.model_name', 'products.brand',
        'products.default_selling_price', 'products.min_selling_price', 'products.max_selling_price',
        'store_product_prices.selling_price', 'store_product_prices.min_selling_price', 'store_product_prices.max_selling_price',
        'product_colors.color_name', 'product_colors.hex_code',
        'product_variants.size_eu', 'product_variants.sku',
        'stores.id', 'stores.name'
      )
      .orderBy(['products.product_code', 'product_colors.color_name', 'product_variants.size_eu']);

    if (store_id) query = query.where('inventory_items.store_id', store_id);

    if (search) {
      query = query.where(function () {
        this.where('products.model_name', 'ilike', `%${search}%`)
          .orWhere('products.product_code', 'ilike', `%${search}%`)
          .orWhere('products.brand', 'ilike', `%${search}%`)
          .orWhere('product_colors.color_name', 'ilike', `%${search}%`)
          .orWhere('product_variants.sku', 'ilike', `%${search}%`)
          .orWhere(db.raw('CAST(product_variants.size_eu AS TEXT)'), 'ilike', `%${search}%`)
          .orWhere(db.raw('CAST(inventory_items.cost AS TEXT)'), 'ilike', `%${search}%`);
      });
    }

    if (size_min) query = query.where('product_variants.size_eu', '>=', size_min);
    if (size_max) query = query.where('product_variants.size_eu', '<=', size_max);

    return query;
  }

  /**
   * Manually add inventory items (for legacy/pre-system stock).
   * Creates N items with source='manual'.
   */
  async manualEntry({ variant_id, store_id, cost, quantity, notes }) {
    // Validate variant and store exist
    const variant = await db('product_variants').where('id', variant_id).first();
    if (!variant) throw new AppError('Product variant not found', 404);

    const store = await db('stores').where('id', store_id).first();
    if (!store) throw new AppError('Store not found', 404);

    const items = [];
    for (let i = 0; i < quantity; i++) {
      items.push({
        id: generateUUID(),
        variant_id,
        store_id,
        cost,
        source: 'manual',
        status: 'in_stock',
        notes: notes || 'Manual entry — pre-existing stock',
      });
    }

    await db('inventory_items').insert(items);
    return { created: items.length, variant_sku: variant.sku, store_name: store.name };
  }

  /**
   * Mark an inventory item as damaged.
   */
  async markDamaged(itemId, notes) {
    const [item] = await db('inventory_items')
      .where('id', itemId)
      .where('status', 'in_stock')
      .update({ status: 'damaged', notes, updated_at: new Date() })
      .returning('*');

    if (!item) throw new AppError('Item not found or not in stock', 404);
    return item;
  }
}

module.exports = new InventoryService();
