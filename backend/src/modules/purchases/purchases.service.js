const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');

/**
 * Purchases service — Purchase invoices, boxes, box items, supplier payments.
 * 
 * Key flows:
 * 1. Create invoice → add boxes (details can be deferred)
 * 2. Fill in box details later → set items → mark complete → auto-create inventory
 * 3. Pay supplier → FIFO auto-allocation across outstanding invoices
 */
class PurchasesService {

  // ================================================================
  //  PURCHASE INVOICES
  // ================================================================

  async listInvoices({ supplier_id, status } = {}) {
    let query = db('purchase_invoices')
      .leftJoin('suppliers', 'purchase_invoices.supplier_id', 'suppliers.id')
      .leftJoin('users', 'purchase_invoices.created_by', 'users.id')
      .select(
        'purchase_invoices.*',
        'suppliers.name as supplier_name',
        'users.full_name as created_by_name'
      )
      .orderBy('invoice_date', 'desc');

    if (supplier_id) query = query.where('purchase_invoices.supplier_id', supplier_id);
    if (status) query = query.where('purchase_invoices.status', status);

    return query;
  }

  async getInvoiceById(id) {
    const invoice = await db('purchase_invoices')
      .leftJoin('suppliers', 'purchase_invoices.supplier_id', 'suppliers.id')
      .leftJoin('users', 'purchase_invoices.created_by', 'users.id')
      .where('purchase_invoices.id', id)
      .select(
        'purchase_invoices.*',
        'suppliers.name as supplier_name',
        'users.full_name as created_by_name'
      )
      .first();

    if (!invoice) throw new AppError('Invoice not found', 404);

    // Fetch boxes with their items
    invoice.boxes = await db('purchase_invoice_boxes')
      .where('invoice_id', id)
      .leftJoin('products', 'purchase_invoice_boxes.product_id', 'products.id')
      .leftJoin('stores', 'purchase_invoice_boxes.destination_store_id', 'stores.id')
      .select(
        'purchase_invoice_boxes.*',
        'products.model_name as product_name',
        'products.product_code',
        'stores.name as store_name'
      )
      .orderBy('purchase_invoice_boxes.created_at', 'asc');

    for (const box of invoice.boxes) {
      box.items = await db('box_items')
        .where('invoice_box_id', box.id)
        .leftJoin('product_colors', 'box_items.product_color_id', 'product_colors.id')
        .select('box_items.*', 'product_colors.color_name')
        .orderBy('size_eu', 'asc');
    }

    // Fetch payment allocations
    invoice.allocations = await db('supplier_payment_allocations')
      .join('supplier_payments', 'supplier_payment_allocations.payment_id', 'supplier_payments.id')
      .where('invoice_id', id)
      .select(
        'supplier_payment_allocations.*',
        'supplier_payments.payment_method',
        'supplier_payments.payment_date',
        'supplier_payments.reference_no'
      );

    // Fetch attached images
    invoice.images = await db('attached_images')
      .where({ entity_type: 'purchase_invoice', entity_id: id })
      .orderBy('created_at', 'asc');

    return invoice;
  }

  async createInvoice(data, userId) {
    const invoiceNumber = await generateDocumentNumber('PI', db, 'purchase_invoices', 'invoice_number');
    const { boxes, ...invoiceData } = data;
    const invoiceId = generateUUID();

    await db.transaction(async (trx) => {
      await trx('purchase_invoices').insert({
        id: invoiceId,
        invoice_number: invoiceNumber,
        ...invoiceData,
        paid_amount: 0,
        status: 'pending',
        created_by: userId,
      });

      if (boxes && boxes.length > 0) {
        for (const box of boxes) {
          await trx('purchase_invoice_boxes').insert({
            id: generateUUID(),
            invoice_id: invoiceId,
            ...box,
            detail_status: box.product_id ? 'partial' : 'pending',
          });
        }
      }

      // ── Auto-allocate unallocated advance payments to this new invoice ──
      // Calculate how much the supplier has paid vs how much has been allocated
      const paidResult = await trx('supplier_payments')
        .where('supplier_id', invoiceData.supplier_id)
        .sum('total_amount as total')
        .first();
      const allocatedResult = await trx('supplier_payment_allocations as spa')
        .join('supplier_payments as sp', 'spa.payment_id', 'sp.id')
        .where('sp.supplier_id', invoiceData.supplier_id)
        .sum('spa.allocated_amount as total')
        .first();

      const totalPaid = parseFloat(paidResult?.total) || 0;
      const totalAllocated = parseFloat(allocatedResult?.total) || 0;
      const unallocated = totalPaid - totalAllocated;

      if (unallocated > 0) {
        const invoiceTotal = parseFloat(invoiceData.total_amount) - (parseFloat(invoiceData.discount_amount) || 0);
        const toApply = Math.min(unallocated, invoiceTotal);

        if (toApply > 0) {
          // Find payments with unallocated balance (FIFO by payment_date)
          const payments = await trx('supplier_payments')
            .where('supplier_id', invoiceData.supplier_id)
            .orderBy('payment_date', 'asc')
            .orderBy('created_at', 'asc');

          let remaining = toApply;

          for (const payment of payments) {
            if (remaining <= 0) break;

            // How much of this payment is already allocated?
            const allocSum = await trx('supplier_payment_allocations')
              .where('payment_id', payment.id)
              .sum('allocated_amount as total')
              .first();
            const paymentAllocated = parseFloat(allocSum?.total) || 0;
            const paymentUnallocated = parseFloat(payment.total_amount) - paymentAllocated;

            if (paymentUnallocated <= 0) continue;

            const allocAmount = Math.min(remaining, paymentUnallocated);

            await trx('supplier_payment_allocations').insert({
              id: generateUUID(),
              payment_id: payment.id,
              invoice_id: invoiceId,
              allocated_amount: allocAmount,
            });

            remaining -= allocAmount;
          }

          // Update the invoice's paid_amount and status
          const actualApplied = toApply - remaining;
          if (actualApplied > 0) {
            const newStatus = actualApplied >= invoiceTotal ? 'paid' : 'partial';
            await trx('purchase_invoices')
              .where('id', invoiceId)
              .update({
                paid_amount: actualApplied,
                status: newStatus,
                updated_at: new Date(),
              });
          }
        }
      }
    });

    return this.getInvoiceById(invoiceId);
  }

  async updateInvoice(id, data) {
    data.updated_at = new Date();
    
    await db.transaction(async (trx) => {
      const existing = await trx('purchase_invoices').where('id', id).first();
      if (!existing) throw new AppError('Invoice not found', 404);
      
      const newTotal = data.total_amount !== undefined ? parseFloat(data.total_amount) : parseFloat(existing.total_amount);
      const newDiscount = data.discount_amount !== undefined ? parseFloat(data.discount_amount) : parseFloat(existing.discount_amount || 0);
      const netTotal = newTotal - newDiscount;
      const paid = parseFloat(existing.paid_amount) || 0;
      
      if (paid >= netTotal && netTotal > 0) {
        data.status = 'paid';
      } else if (paid > 0 && paid < netTotal) {
        data.status = 'partial';
      } else {
        data.status = 'pending';
      }
      
      await trx('purchase_invoices').where('id', id).update(data);
    });

    return this.getInvoiceById(id);
  }

  async uploadPrimaryImage(id, filePath) {
    const [invoice] = await db('purchase_invoices')
      .where('id', id)
      .update({ invoice_image_url: filePath, updated_at: new Date() })
      .returning('*');
    if (!invoice) throw new AppError('Invoice not found', 404);
    return this.getInvoiceById(id);
  }

  async deleteInvoice(id) {
    const invoice = await db('purchase_invoices').where('id', id).first();
    if (!invoice) throw new AppError('Invoice not found', 404);

    // Check if there are any completed boxes
    const completedBoxes = await db('purchase_invoice_boxes')
      .where('invoice_id', id)
      .andWhere('detail_status', 'complete')
      .count('id as count').first();
      
    if (parseInt(completedBoxes.count) > 0) {
      throw new AppError('Cannot delete an invoice that has completed boxes with generated inventory.', 400);
    }

    // Check if there are any payments
    const payments = await db('supplier_payment_allocations')
      .where('invoice_id', id)
      .count('id as count').first();

    if (parseInt(payments.count) > 0) {
      throw new AppError('Cannot delete an invoice that has supplier payments allocated to it.', 400);
    }

    // Delete in transaction
    await db.transaction(async (trx) => {
      // Get all boxes to delete their items
      const boxes = await trx('purchase_invoice_boxes').where('invoice_id', id).select('id');
      const boxIds = boxes.map(b => b.id);
      
      if (boxIds.length > 0) {
        await trx('box_items').whereIn('invoice_box_id', boxIds).del();
      }
      await trx('purchase_invoice_boxes').where('invoice_id', id).del();
      await trx('attached_images').where({ entity_type: 'purchase_invoice', entity_id: id }).del();
      await trx('purchase_invoices').where('id', id).del();
    });
  }

  // ================================================================
  //  BOXES
  // ================================================================

  async addBox(invoiceId, data) {
    // Verify invoice exists
    const invoice = await db('purchase_invoices').where('id', invoiceId).first();
    if (!invoice) throw new AppError('Invoice not found', 404);

    // Validate box total doesn't exceed invoice limit
    const newBoxCost = (Number(data.total_items) || 0) * (Number(data.cost_per_item) || 0);
    const existingBoxes = await db('purchase_invoice_boxes').where('invoice_id', invoiceId).select('total_items', 'cost_per_item');
    const existingTotal = existingBoxes.reduce((sum, b) => sum + ((Number(b.total_items) || 0) * (Number(b.cost_per_item) || 0)), 0);

    if (existingTotal + newBoxCost > Number(invoice.total_amount)) {
      throw new AppError(`Cannot add box. Accumulated box cost (${existingTotal + newBoxCost}) would exceed the invoice's total limit (${invoice.total_amount}).`, 400);
    }

    const [box] = await db('purchase_invoice_boxes')
      .insert({
        id: generateUUID(),
        invoice_id: invoiceId,
        ...data,
        detail_status: data.product_id ? 'partial' : 'pending',
      })
      .returning('*');

    return box;
  }

  async updateBox(boxId, data) {
    const existing = await db('purchase_invoice_boxes').where('id', boxId).first();
    if (!existing) throw new AppError('Box not found', 404);
    if (existing.detail_status === 'complete') {
      throw new AppError('Cannot edit a completed box. Inventory items have already been created.', 400);
    }

    // Validate box total doesn't exceed invoice limit
    if (data.total_items !== undefined || data.cost_per_item !== undefined) {
      const invoice = await db('purchase_invoices').where('id', existing.invoice_id).first();
      
      const newTotalItems = data.total_items !== undefined ? Number(data.total_items) || 0 : Number(existing.total_items) || 0;
      const newCostPerItem = data.cost_per_item !== undefined ? Number(data.cost_per_item) || 0 : Number(existing.cost_per_item) || 0;
      const newBoxCost = newTotalItems * newCostPerItem;
      const oldBoxCost = (Number(existing.total_items) || 0) * (Number(existing.cost_per_item) || 0);

      if (newBoxCost > oldBoxCost) {
        const allBoxes = await db('purchase_invoice_boxes').where('invoice_id', existing.invoice_id).select('id', 'total_items', 'cost_per_item');
        let existingTotal = 0;
        for (const b of allBoxes) {
          if (b.id !== boxId) {
            existingTotal += (Number(b.total_items) || 0) * (Number(b.cost_per_item) || 0);
          }
        }
        if (existingTotal + newBoxCost > Number(invoice.total_amount)) {
          throw new AppError(`Cannot update box. Accumulated box cost (${existingTotal + newBoxCost}) would exceed the invoice's total limit (${invoice.total_amount}).`, 400);
        }
      }
    }

    data.updated_at = new Date();
    // Re-evaluate detail_status
    const merged = { ...existing, ...data };
    if (merged.product_id) {
      data.detail_status = 'partial';
    }

    const [box] = await db('purchase_invoice_boxes')
      .where('id', boxId).update(data).returning('*');
    return box;
  }

  async deleteBox(boxId) {
    const box = await db('purchase_invoice_boxes').where('id', boxId).first();
    if (!box) throw new AppError('Box not found', 404);
    if (box.detail_status === 'complete') {
      throw new AppError('Cannot delete a completed box. Inventory items have already been created.', 400);
    }

    await db('box_items').where('invoice_box_id', boxId).del();
    await db('purchase_invoice_boxes').where('id', boxId).del();
  }

  // ================================================================
  //  BOX ITEMS (size distribution) + MARK COMPLETE
  // ================================================================

  async setBoxItems(boxId, items) {
    const box = await db('purchase_invoice_boxes').where('id', boxId).first();
    if (!box) throw new AppError('Box not found', 404);
    if (box.detail_status === 'complete') {
      throw new AppError('Box is already complete', 400);
    }
    if (!box.product_id) {
      throw new AppError('Product must be set on the box before adding item details', 400);
    }

    // Validate total quantity matches
    const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
    if (totalQty !== box.total_items) {
      throw new AppError(
        `Item quantities sum to ${totalQty}, but box has ${box.total_items} total items`,
        400
      );
    }

    // Replace all items in a transaction
    await db.transaction(async (trx) => {
      await trx('box_items').where('invoice_box_id', boxId).del();
      const rows = items.map((item) => ({
        invoice_box_id: boxId,
        product_color_id: item.product_color_id || null,
        size_eu: item.size_eu,
        size_us: item.size_us || null,
        size_uk: item.size_uk || null,
        size_cm: item.size_cm || null,
        quantity: item.quantity,
      }));
      await trx('box_items').insert(rows);
    });

    return db('box_items').where('invoice_box_id', boxId).orderBy('size_eu', 'asc');
  }

  async completeBox(boxId) {
    const box = await db('purchase_invoice_boxes').where('id', boxId).first();
    if (!box) throw new AppError('Box not found', 404);
    if (box.detail_status === 'complete') {
      throw new AppError('Box is already complete', 400);
    }
    if (!box.product_id || !box.destination_store_id) {
      throw new AppError('Product and destination store must be set before completing', 400);
    }

    const items = await db('box_items').where('invoice_box_id', boxId);
    if (items.length === 0) {
      throw new AppError('Box has no item details. Add sizes/quantities first.', 400);
    }

    // Verify totals match
    const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
    if (totalQty !== box.total_items) {
      throw new AppError(
        `Item quantities sum to ${totalQty}, but box expects ${box.total_items}`,
        400
      );
    }

    await db.transaction(async (trx) => {
      // Create inventory items — one row per physical shoe
      for (const item of items) {
        if (!item.product_color_id) {
          throw new AppError(`Item EU ${item.size_eu} is missing a color assignment`, 400);
        }

        // Find or create the product variant
        let variant = await trx('product_variants')
          .where({
            product_id: box.product_id,
            product_color_id: item.product_color_id,
            size_eu: item.size_eu,
          })
          .first();

        if (!variant) {
          // Auto-create variant
          const product = await trx('products').where('id', box.product_id).first();
          const color = await trx('product_colors').where('id', item.product_color_id).first();
          const colorAbbr = color.color_name.substring(0, 3).toUpperCase();
          const sku = `${product.product_code}-${colorAbbr}-${item.size_eu}`;

          [variant] = await trx('product_variants').insert({
            id: generateUUID(),
            product_id: box.product_id,
            product_color_id: item.product_color_id,
            size_eu: item.size_eu,
            size_us: item.size_us || null,
            size_uk: item.size_uk || null,
            size_cm: item.size_cm || null,
            sku,
          }).returning('*');
        }

        // Create N inventory items for this size
        for (let i = 0; i < item.quantity; i++) {
          await trx('inventory_items').insert({
            id: generateUUID(),
            variant_id: variant.id,
            store_id: box.destination_store_id,
            cost: box.cost_per_item,
            invoice_box_id: box.id,
            source: 'purchase',
            status: 'in_stock',
          });
        }
      }

      // Mark box as complete
      await trx('purchase_invoice_boxes')
        .where('id', boxId)
        .update({ detail_status: 'complete', updated_at: new Date() });
    });

    return db('purchase_invoice_boxes').where('id', boxId).first();
  }

  // ================================================================
  //  SUPPLIER PAYMENTS (FIFO auto-allocation)
  // ================================================================

  async createPayment(data, userId) {
    const paymentId = generateUUID();
    let remaining = data.total_amount;

    await db.transaction(async (trx) => {
      // 1. Create payment record
      await trx('supplier_payments').insert({
        id: paymentId,
        ...data,
        created_by: userId,
      });

      // 2. FIFO: Fetch unpaid/partial invoices oldest first
      const invoices = await trx('purchase_invoices')
        .where('supplier_id', data.supplier_id)
        .whereIn('status', ['pending', 'partial'])
        .orderBy('invoice_date', 'asc');

      // 3. Allocate payment across invoices
      for (const invoice of invoices) {
        if (remaining <= 0) break;

        const owed = parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount);
        if (owed <= 0) continue;

        const allocAmount = Math.min(remaining, owed);

        await trx('supplier_payment_allocations').insert({
          id: generateUUID(),
          payment_id: paymentId,
          invoice_id: invoice.id,
          allocated_amount: allocAmount,
        });

        const newPaidAmount = parseFloat(invoice.paid_amount) + allocAmount;
        const newStatus = newPaidAmount >= parseFloat(invoice.total_amount) ? 'paid' : 'partial';

        await trx('purchase_invoices')
          .where('id', invoice.id)
          .update({
            paid_amount: newPaidAmount,
            status: newStatus,
            updated_at: new Date(),
          });

        remaining -= allocAmount;
      }
    });

    return this.getPaymentById(paymentId);
  }

  async getPaymentById(id) {
    const payment = await db('supplier_payments')
      .join('suppliers', 'supplier_payments.supplier_id', 'suppliers.id')
      .where('supplier_payments.id', id)
      .select('supplier_payments.*', 'suppliers.name as supplier_name')
      .first();

    if (!payment) throw new AppError('Payment not found', 404);

    payment.allocations = await db('supplier_payment_allocations')
      .join('purchase_invoices', 'supplier_payment_allocations.invoice_id', 'purchase_invoices.id')
      .where('payment_id', id)
      .select(
        'supplier_payment_allocations.*',
        'purchase_invoices.invoice_number'
      );

    payment.images = await db('attached_images')
      .where({ entity_type: 'supplier_payment', entity_id: id });

    return payment;
  }

  async listPayments({ supplier_id } = {}) {
    let query = db('supplier_payments')
      .join('suppliers', 'supplier_payments.supplier_id', 'suppliers.id')
      .select('supplier_payments.*', 'suppliers.name as supplier_name')
      .orderBy('payment_date', 'desc');

    if (supplier_id) query = query.where('supplier_payments.supplier_id', supplier_id);
    return query;
  }
}

module.exports = new PurchasesService();
