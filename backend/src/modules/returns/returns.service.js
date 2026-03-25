const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');

class ReturnsService {
  async createCustomerReturn(data) {
    return await db.transaction(async (trx) => {
      // 1. Verify Sale (lock row to prevent race conditions)
      const sale = await trx('sales').where('id', data.sale_id).forUpdate().first();
      if (!sale) throw new AppError('Original sale not found', 404);

      // 2. Compute Total Refund (with precision rounding)
      const totalRefund = Math.round(
        data.items.reduce((sum, item) => sum + parseFloat(item.refund_amount), 0) * 100
      ) / 100;
      if (totalRefund <= 0) throw new AppError('Refund amount must be positive', 400);

      // Ensure refund doesn't exceed remaining refundable amount
      const alreadyRefunded = Math.round(parseFloat(sale.refunded_amount || 0) * 100) / 100;
      const maxRefundable = Math.round((parseFloat(sale.final_amount) - alreadyRefunded) * 100) / 100;
      if (totalRefund > maxRefundable) {
        throw new AppError(`Refund amount (${totalRefund}) exceeds remaining refundable amount (${maxRefundable})`, 400);
      }

      // 3. Create Return Record
      const returnId = generateUUID();
      const returnNum = await generateDocumentNumber('CR', trx, 'customer_returns', 'return_number');
      
      const returnData = {
        id: returnId,
        return_number: returnNum,
        sale_id: data.sale_id,
        store_id: data.store_id,
        reason: data.reason,
        notes: data.notes,
        refund_method: data.refund_method,
        total_refund_amount: totalRefund,
        created_by: data.created_by
      };

      await trx('customer_returns').insert(returnData);

      // Increment refunded_amount on the original sale
      await trx('sales').where('id', data.sale_id).increment('refunded_amount', totalRefund);

      // 4. Resolve Items & Update Inventory
      const returnItemsToInsert = [];
      for (const reqItem of data.items) {
        const saleItem = await trx('sale_items').where('id', reqItem.sale_item_id).first();
        if (!saleItem) throw new AppError(`Sale item ${reqItem.sale_item_id} not found`, 404);

        // Verify sale item belongs to the referenced sale
        if (saleItem.sale_id !== data.sale_id) {
          throw new AppError('Sale item does not belong to the referenced sale', 400);
        }

        // Validate refund amount doesn't exceed original sale price
        const itemRefund = Math.round(parseFloat(reqItem.refund_amount) * 100) / 100;
        if (itemRefund > parseFloat(saleItem.sale_price)) {
          throw new AppError(`Refund amount (${itemRefund}) exceeds original sale price (${saleItem.sale_price})`, 400);
        }

        // Check if already returned
        const existing = await trx('customer_return_items').where('sale_item_id', reqItem.sale_item_id).first();
        if (existing) throw new AppError(`Sale item already returned`, 400);

        returnItemsToInsert.push({
          return_id: returnId,
          sale_item_id: reqItem.sale_item_id,
          refund_amount: reqItem.refund_amount
        });

        // Put inventory item back in stock, assign to the currently reporting store
        await trx('inventory_items')
          .where('id', saleItem.inventory_item_id)
          .update({
            status: 'in_stock',
            store_id: data.store_id, // It might be returned at a different branch!
            sold_at: null,
            updated_at: new Date()
          });
      }

      await trx('customer_return_items').insert(returnItemsToInsert);

      return { ...returnData, items: returnItemsToInsert };
    });
  }

  async createSupplierReturn(data) {
    return await db.transaction(async (trx) => {
      // 1. Create Return Record
      const returnId = generateUUID();
      const returnNum = await generateDocumentNumber('SR', trx, 'supplier_returns', 'return_number');

      const returnData = {
        id: returnId,
        return_number: returnNum,
        supplier_id: data.supplier_id,
        reason: data.reason,
        notes: data.notes,
        created_by: data.created_by,
        total_amount: 0 // Will compute now
      };

      await trx('supplier_returns').insert(returnData);

      let totalAmount = 0;
      const returnItemsToInsert = [];

      for (const invId of data.items) {
        const item = await trx('inventory_items').where('id', invId).forUpdate().first();
        if (!item) throw new AppError(`Inventory item ${invId} not found`, 404);
        if (item.status !== 'in_stock') throw new AppError(`Inventory item ${invId} is not in stock (status: ${item.status})`, 400);

        totalAmount = Math.round((totalAmount + (parseFloat(item.cost) || 0)) * 100) / 100;

        returnItemsToInsert.push({
          id: generateUUID(),
          return_id: returnId,
          inventory_item_id: invId
        });

        // Remove from stock
        await trx('inventory_items')
          .where('id', invId)
          .update({
            status: 'returned',
            updated_at: new Date()
          });
      }

      // Update total
      await trx('supplier_returns').where('id', returnId).update({ total_amount: totalAmount });
      returnData.total_amount = totalAmount;

      await trx('supplier_return_items').insert(returnItemsToInsert);

      return { ...returnData, items: returnItemsToInsert };
    });
  }
}

module.exports = new ReturnsService();
