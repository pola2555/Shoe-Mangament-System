const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');

/**
 * Store Transfers service.
 * 
 * Workflow: pending → shipped → received  (or pending → cancelled)
 * 
 * When created: selected inventory items change status to 'in_transfer'
 * When received: items' store_id changes to destination, status → 'in_stock'
 * When cancelled: items revert to 'in_stock' at original store
 */
class TransfersService {
  async list({ from_store_id, to_store_id, status, store_id, store_ids } = {}) {
    let query = db('store_transfers')
      .join('stores as from_s', 'store_transfers.from_store_id', 'from_s.id')
      .join('stores as to_s', 'store_transfers.to_store_id', 'to_s.id')
      .leftJoin('users', 'store_transfers.created_by', 'users.id')
      .select(
        'store_transfers.*',
        'from_s.name as from_store_name',
        'to_s.name as to_store_name',
        'users.full_name as created_by_name'
      )
      .orderBy('store_transfers.created_at', 'desc');

    if (from_store_id) query = query.where('store_transfers.from_store_id', from_store_id);
    if (to_store_id) query = query.where('store_transfers.to_store_id', to_store_id);
    if (status) query = query.where('store_transfers.status', status);
    // Store scoping: a transfer is visible if EITHER endpoint is in scope.
    // Note this is deliberately not applyStoreScope — that helper targets a single column.
    const scoped = store_id ? [store_id] : (Array.isArray(store_ids) ? store_ids : null);
    if (scoped) {
      query = query.where(function () {
        this.whereIn('store_transfers.from_store_id', scoped)
          .orWhereIn('store_transfers.to_store_id', scoped);
      });
    }

    const transfers = await query.limit(500);
    if (transfers.length === 0) return transfers;

    // Item counts in one grouped query instead of one query per transfer.
    const counts = await db('transfer_items')
      .whereIn('transfer_id', transfers.map((t) => t.id))
      .groupBy('transfer_id')
      .select('transfer_id')
      .count('id as count');

    const countByTransfer = new Map(counts.map((c) => [c.transfer_id, parseInt(c.count, 10)]));
    for (const t of transfers) {
      t.item_count = countByTransfer.get(t.id) || 0;
    }
    return transfers;
  }

  async getById(id) {
    const transfer = await db('store_transfers')
      .join('stores as from_s', 'store_transfers.from_store_id', 'from_s.id')
      .join('stores as to_s', 'store_transfers.to_store_id', 'to_s.id')
      .leftJoin('users', 'store_transfers.created_by', 'users.id')
      .where('store_transfers.id', id)
      .select(
        'store_transfers.*',
        'from_s.name as from_store_name',
        'to_s.name as to_store_name',
        'users.full_name as created_by_name'
      )
      .first();

    if (!transfer) throw new AppError('Transfer not found', 404);

    // Fetch items with variant details
    transfer.items = await db('transfer_items')
      .join('inventory_items', 'transfer_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .where('transfer_items.transfer_id', id)
      .select(
        // How this category writes a size, and whether the colour is the "no colour"
        // placeholder. Without them variantFormat assumes a shoe and prints "EU KIDS".
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes',
        'product_colors.is_placeholder as color_is_placeholder',
        'transfer_items.id',
        'transfer_items.inventory_item_id',
        'inventory_items.status as item_status',
        'product_variants.sku',
        'product_variants.size_eu',
        'products.product_code',
        'products.model_name as product_name',
        'product_colors.color_name',
        'product_colors.hex_code'
      );

    return transfer;
  }

  async create(data, userId) {
    if (data.from_store_id === data.to_store_id) {
      throw new AppError('Source and destination stores must be different', 400);
    }

    const transferId = generateUUID();

    await db.transaction(async (trx) => {
      const transferNumber = await generateDocumentNumber('TR', trx, 'store_transfers', 'transfer_number');
      await trx('store_transfers').insert({
        id: transferId,
        transfer_number: transferNumber,
        from_store_id: data.from_store_id,
        to_store_id: data.to_store_id,
        status: 'pending',
        notes: data.notes || null,
        created_by: userId,
      });

      // Validate and lock items (deduplicate to prevent double-counting)
      const uniqueItemIds = [...new Set(data.item_ids)];
      for (const itemId of uniqueItemIds) {
        const item = await trx('inventory_items').where('id', itemId).forUpdate().first();
        if (!item) throw new AppError(`Inventory item ${itemId} not found`, 404);
        if (item.status !== 'in_stock') throw new AppError(`Item ${itemId} is not in stock (status: ${item.status})`, 400);
        if (item.store_id !== data.from_store_id) throw new AppError(`Item ${itemId} is not at the source store`, 400);

        await trx('transfer_items').insert({
          id: generateUUID(),
          transfer_id: transferId,
          inventory_item_id: itemId,
        });

        await trx('inventory_items')
          .where('id', itemId)
          .update({ status: 'in_transfer', updated_at: new Date() });
      }
    });

    return this.getById(transferId);
  }

  async ship(id) {
    await db.transaction(async (trx) => {
      const transfer = await trx('store_transfers').where('id', id).forUpdate().first();
      if (!transfer) throw new AppError('Transfer not found', 404);
      if (transfer.status !== 'pending') throw new AppError('Can only ship a pending transfer', 400);

      await trx('store_transfers')
        .where('id', id)
        .update({ status: 'shipped', shipped_at: new Date(), updated_at: new Date() });
    });

    return this.getById(id);
  }

  async receive(id) {
    await db.transaction(async (trx) => {
      const transfer = await trx('store_transfers').where('id', id).forUpdate().first();
      if (!transfer) throw new AppError('Transfer not found', 404);
      if (transfer.status !== 'shipped' && transfer.status !== 'pending') {
        throw new AppError('Can only receive a pending or shipped transfer', 400);
      }

      const items = await trx('transfer_items').where('transfer_id', id);

      for (const ti of items) {
        await trx('inventory_items')
          .where('id', ti.inventory_item_id)
          .forUpdate()
          .update({
            store_id: transfer.to_store_id,
            status: 'in_stock',
            updated_at: new Date(),
          });
      }

      await trx('store_transfers')
        .where('id', id)
        .update({ status: 'received', received_at: new Date(), updated_at: new Date() });
    });

    return this.getById(id);
  }

  async cancel(id) {
    await db.transaction(async (trx) => {
      const transfer = await trx('store_transfers').where('id', id).forUpdate().first();
      if (!transfer) throw new AppError('Transfer not found', 404);
      if (transfer.status === 'received') throw new AppError('Cannot cancel a received transfer', 400);
      if (transfer.status === 'cancelled') throw new AppError('Already cancelled', 400);

      const items = await trx('transfer_items').where('transfer_id', id);

      for (const ti of items) {
        await trx('inventory_items')
          .where('id', ti.inventory_item_id)
          .forUpdate()
          .update({ status: 'in_stock', updated_at: new Date() });
      }

      await trx('store_transfers')
        .where('id', id)
        .update({ status: 'cancelled', updated_at: new Date() });
    });

    return this.getById(id);
  }
}

module.exports = new TransfersService();
