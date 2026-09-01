const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const barcodesService = require('../barcodes/barcodes.service');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { getSupplierBalance } = require('../../utils/supplierBalance');
const {
  categoryOfProduct, ensurePlaceholderColor, resolveVariantTarget, generateSku,
} = require('../../utils/variantIdentity');

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

    return query.limit(500);
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

    const [boxes, allocations, images] = await Promise.all([
      db('purchase_invoice_boxes')
        .where('invoice_id', id)
        .leftJoin('products', 'purchase_invoice_boxes.product_id', 'products.id')
        .leftJoin('stores', 'purchase_invoice_boxes.destination_store_id', 'stores.id')
        .select(
          'purchase_invoice_boxes.*',
          'products.model_name as product_name',
          'products.product_code',
          'stores.name as store_name'
        )
        .orderBy('purchase_invoice_boxes.created_at', 'asc'),

      db('supplier_payment_allocations')
        .join('supplier_payments', 'supplier_payment_allocations.payment_id', 'supplier_payments.id')
        .where('invoice_id', id)
        .select(
          'supplier_payment_allocations.*',
          'supplier_payments.payment_method',
          'supplier_payments.payment_date',
          'supplier_payments.reference_no'
        ),

      db('attached_images')
        .where({ entity_type: 'purchase_invoice', entity_id: id })
        .orderBy('created_at', 'asc'),
    ]);

    // All box items in one query rather than one query per box.
    if (boxes.length > 0) {
      const allItems = await db('box_items')
        .whereIn('invoice_box_id', boxes.map((b) => b.id))
        .leftJoin('product_colors', 'box_items.product_color_id', 'product_colors.id')
        .select('box_items.*', 'product_colors.color_name')
        // Numeric ordering: size_eu is a varchar, so a plain sort puts '10' before '9'.
        // Extracts the first number; stripping non-digits instead would make
        // '36.5-37.5' into the un-castable '36.537.5' and 500 this endpoint.
        .orderByRaw("NULLIF(substring(box_items.size_eu from '[0-9]+[.]{0,1}[0-9]*'), '')::numeric ASC NULLS LAST");

      const itemsByBox = new Map();
      for (const item of allItems) {
        if (!itemsByBox.has(item.invoice_box_id)) itemsByBox.set(item.invoice_box_id, []);
        itemsByBox.get(item.invoice_box_id).push(item);
      }
      for (const box of boxes) {
        box.items = itemsByBox.get(box.id) || [];
      }
    }

    invoice.boxes = boxes;
    invoice.allocations = allocations;
    invoice.images = images;

    return invoice;
  }

  async createInvoice(data, userId) {
    const { boxes, ...invoiceData } = data;
    const invoiceId = generateUUID();

    await db.transaction(async (trx) => {
      const invoiceNumber = await generateDocumentNumber('PI', trx, 'purchase_invoices', 'invoice_number');
      await trx('purchase_invoices').insert({
        id: invoiceId,
        invoice_number: invoiceNumber,
        supplier_id: invoiceData.supplier_id,
        total_amount: invoiceData.total_amount,
        discount_amount: invoiceData.discount_amount || 0,
        invoice_date: invoiceData.invoice_date,
        notes: invoiceData.notes || null,
        paid_amount: 0,
        status: 'pending',
        created_by: userId,
      });

      if (boxes && boxes.length > 0) {
        for (const box of boxes) {
          await trx('purchase_invoice_boxes').insert({
            id: generateUUID(),
            invoice_id: invoiceId,
            product_id: box.product_id || null,
            box_template_id: box.box_template_id || null,
            cost_per_item: box.cost_per_item,
            total_items: box.total_items,
            destination_store_id: box.destination_store_id || null,
            notes: box.notes || null,
            detail_status: box.product_id ? 'partial' : 'pending',
          });
        }
      }

      // ── Auto-apply supplier credit (overpayments + returns) to this new invoice ──
      // Balance BEFORE this invoice: it has already been inserted above, so exclude it.
      // Shared formula, so this cannot drift from the suppliers page or the reports.
      const prior = await getSupplierBalance(trx, invoiceData.supplier_id, {
        excludeInvoiceId: invoiceId,
      });
      const totalPayments = prior.total_paid;
      const priorBalance = prior.balance;

      // If priorBalance < 0, supplier has credit we can apply to this invoice
      if (priorBalance < 0) {
        const invoiceTotal = parseFloat(invoiceData.total_amount) - (parseFloat(invoiceData.discount_amount) || 0);
        const supplierCredit = Math.abs(priorBalance);
        const toApply = Math.round(Math.min(supplierCredit, invoiceTotal) * 100) / 100;

        if (toApply > 0) {
          // Allocate from actual unallocated payment funds (FIFO) where possible
          const allocatedResult = await trx('supplier_payment_allocations as spa')
            .join('supplier_payments as sp', 'spa.payment_id', 'sp.id')
            .where('sp.supplier_id', invoiceData.supplier_id)
            .sum('spa.allocated_amount as total')
            .first();
          const totalAllocated = parseFloat(allocatedResult?.total) || 0;
          const unallocatedPayments = Math.round((totalPayments - totalAllocated) * 100) / 100;

          if (unallocatedPayments > 0) {
            const paymentToAllocate = Math.min(unallocatedPayments, toApply);
            const payments = await trx('supplier_payments')
              .where('supplier_id', invoiceData.supplier_id)
              .where('type', 'payment')
              .orderBy('payment_date', 'asc')
              .orderBy('created_at', 'asc')
              .forUpdate();

            let remaining = paymentToAllocate;
            for (const payment of payments) {
              if (remaining <= 0) break;
              const allocSum = await trx('supplier_payment_allocations')
                .where('payment_id', payment.id)
                .sum('allocated_amount as total')
                .first();
              const paymentAllocated = parseFloat(allocSum?.total) || 0;
              const paymentUnallocated = parseFloat(payment.total_amount) - paymentAllocated;
              if (paymentUnallocated <= 0) continue;
              const allocAmount = Math.round(Math.min(remaining, paymentUnallocated) * 100) / 100;
              await trx('supplier_payment_allocations').insert({
                id: generateUUID(),
                payment_id: payment.id,
                invoice_id: invoiceId,
                allocated_amount: allocAmount,
              });
              remaining = Math.round((remaining - allocAmount) * 100) / 100;
            }
          }

          // Update invoice paid_amount with the full credit (payments + return credit)
          const newStatus = toApply >= invoiceTotal ? 'paid' : 'partial';
          await trx('purchase_invoices')
            .where('id', invoiceId)
            .update({
              paid_amount: toApply,
              status: newStatus,
              updated_at: new Date(),
            });
        }
      }
    });

    return this.getInvoiceById(invoiceId);
  }

  async updateInvoice(id, data) {
    await db.transaction(async (trx) => {
      const existing = await trx('purchase_invoices').where('id', id).first();
      if (!existing) throw new AppError('Invoice not found', 404);
      
      const newTotal = data.total_amount !== undefined ? parseFloat(data.total_amount) : parseFloat(existing.total_amount);
      const newDiscount = data.discount_amount !== undefined ? parseFloat(data.discount_amount) : parseFloat(existing.discount_amount || 0);
      const netTotal = Math.round((newTotal - newDiscount) * 100) / 100;
      const paid = Math.round((parseFloat(existing.paid_amount) || 0) * 100) / 100;
      
      if (netTotal <= 0 || paid >= netTotal) {
        data.status = 'paid';
      } else if (paid > 0 && paid < netTotal) {
        data.status = 'partial';
      } else {
        data.status = 'pending';
      }
      
      const safeData = { updated_at: new Date() };
      if (data.total_amount !== undefined) safeData.total_amount = data.total_amount;
      if (data.discount_amount !== undefined) safeData.discount_amount = data.discount_amount;
      if (data.invoice_number !== undefined) safeData.invoice_number = data.invoice_number;
      if (data.invoice_date !== undefined) safeData.invoice_date = data.invoice_date;
      if (data.notes !== undefined) safeData.notes = data.notes;
      if (data.supplier_id !== undefined) safeData.supplier_id = data.supplier_id;
      safeData.status = data.status;
      
      await trx('purchase_invoices').where('id', id).update(safeData);
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

    // Validate box total doesn't exceed invoice net limit
    const newBoxCost = (Number(data.total_items) || 0) * (Number(data.cost_per_item) || 0);
    const existingBoxes = await db('purchase_invoice_boxes').where('invoice_id', invoiceId).select('total_items', 'cost_per_item');
    const existingTotal = existingBoxes.reduce((sum, b) => sum + ((Number(b.total_items) || 0) * (Number(b.cost_per_item) || 0)), 0);

    const invoiceGross = Number(invoice.total_amount);
    if (existingTotal + newBoxCost > invoiceGross) {
      throw new AppError(`Cannot add box. Accumulated box cost (${existingTotal + newBoxCost}) would exceed the invoice total (${invoiceGross}).`, 400);
    }

    const [box] = await db('purchase_invoice_boxes')
      .insert({
        id: generateUUID(),
        invoice_id: invoiceId,
        product_id: data.product_id || null,
        box_template_id: data.box_template_id || null,
        cost_per_item: data.cost_per_item,
        total_items: data.total_items,
        destination_store_id: data.destination_store_id || null,
        notes: data.notes || null,
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
        const invoiceGross = Number(invoice.total_amount);
        if (existingTotal + newBoxCost > invoiceGross) {
          throw new AppError(`Cannot update box. Accumulated box cost (${existingTotal + newBoxCost}) would exceed the invoice total (${invoiceGross}).`, 400);
        }
      }
    }

    const safeBoxData = { updated_at: new Date() };
    if (data.product_id !== undefined) safeBoxData.product_id = data.product_id;
    if (data.destination_store_id !== undefined) safeBoxData.destination_store_id = data.destination_store_id;
    if (data.total_items !== undefined) safeBoxData.total_items = data.total_items;
    if (data.cost_per_item !== undefined) safeBoxData.cost_per_item = data.cost_per_item;
    if (data.color_id !== undefined) safeBoxData.color_id = data.color_id;
    if (data.label !== undefined) safeBoxData.label = data.label;
    if (data.detail_status !== undefined) safeBoxData.detail_status = data.detail_status;
    // Re-evaluate detail_status
    const merged = { ...existing, ...safeBoxData };
    if (merged.product_id) {
      safeBoxData.detail_status = 'partial';
    }

    const [box] = await db('purchase_invoice_boxes')
      .where('id', boxId).update(safeBoxData).returning('*');
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
    await db.transaction(async (trx) => {
      // Read and lock the box INSIDE the transaction. Previously the status check ran
      // against a read taken before the transaction opened, so two concurrent calls
      // both saw detail_status !== 'complete' and each created the full set of
      // inventory rows — silently doubling physical stock.
      const box = await trx('purchase_invoice_boxes').where('id', boxId).forUpdate().first();
      if (!box) throw new AppError('Box not found', 404);
      if (box.detail_status === 'complete') {
        throw new AppError('Box is already complete', 400);
      }
      if (!box.product_id || !box.destination_store_id) {
        throw new AppError('Product and destination store must be set before completing', 400);
      }

      const items = await trx('box_items').where('invoice_box_id', boxId);
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

      // Collected across all sizes and inserted in one batch at the end, rather than
      // one INSERT round-trip per physical shoe (a 100-item box meant 100 round-trips).
      const inventoryRows = [];

      const product = await trx('products').where('id', box.product_id).first();
      const category = await categoryOfProduct(trx, box.product_id);

      for (const item of items) {
        // A colourless category has no colour to assign — resolve its placeholder
        // instead of refusing the receipt. Only categories that DO use colours still
        // require one to have been picked.
        let colorId = item.product_color_id;
        if (!colorId) {
          if (category.has_colors) {
            throw new AppError(`Item ${item.size_eu} is missing a color assignment`, 400);
          }
          colorId = (await ensurePlaceholderColor(trx, box.product_id, category)).id;
        }

        // Same resolution the catalogue uses, so a variant born from a purchase is
        // indistinguishable from one created by hand — including its sort key and its
        // link to the category's size list.
        const target = await resolveVariantTarget(
          trx, product, { product_color_id: colorId, size_eu: item.size_eu }, category,
          { allowOffScale: true }
        );

        // Find or create the product variant
        let variant = await trx('product_variants')
          .where({
            product_id: box.product_id,
            product_color_id: target.color.id,
            size_eu: target.size_eu,
          })
          .first();

        if (!variant) {
          const sku = await generateSku(trx, product, target.color, target.size_eu);
          [variant] = await trx('product_variants').insert({
            id: generateUUID(),
            product_id: box.product_id,
            product_color_id: target.color.id,
            size_eu: target.size_eu,
            size_sort: target.size_sort,
            size_scale_value_id: target.size_scale_value_id,
            size_us: item.size_us || null,
            size_uk: item.size_uk || null,
            size_cm: item.size_cm || null,
            sku,
          }).returning('*');
        }

        // Mint the barcode here, not only for freshly created variants: receiving
        // stock is exactly when labels get printed, so an older variant that predates
        // barcodes must pick one up too. assignForVariant is idempotent.
        await barcodesService.assignForVariant(variant.id, trx);

        // Queue N inventory rows for this size — one row per physical shoe.
        for (let i = 0; i < item.quantity; i++) {
          inventoryRows.push({
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

      // Batched insert. Chunked because Postgres caps bind parameters at 65535 and
      // each row here carries 8 of them.
      if (inventoryRows.length > 0) {
        await trx.batchInsert('inventory_items', inventoryRows, 500);
      }

      // Phase 18: Dynamic Cost Updates & Notifications
      const productRecord = await trx('products').where('id', box.product_id).first();
      const unitCost = Number(box.cost_per_item) || 0;
      const currentNetPrice = Number(productRecord.net_price) || 0;

      if (unitCost > 0 && unitCost !== currentNetPrice) {
        // 1. Update product net_price
        await trx('products')
          .where('id', productRecord.id)
          .update({ net_price: unitCost, updated_at: new Date() });

        // 2. Generate Notification with reference_id
        await trx('notifications').insert({
          id: generateUUID(),
          type: 'price_update',
          title: `Cost Price Changed: ${productRecord.product_code}`,
          message: `The net purchase cost for ${productRecord.product_code} was officially updated from ${currentNetPrice} EGP to ${unitCost} EGP based on a newly completed purchase invoice box. Please review its selling boundaries to maintain margins.`,
          title_key: 'notifications.price_update_title',
          message_key: 'notifications.price_update_message',
          params: JSON.stringify({ product_code: productRecord.product_code, old_price: currentNetPrice, new_price: unitCost }),
          reference_id: productRecord.id,
          created_at: new Date()
        });
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
    let remaining = parseFloat(data.total_amount);
    let unallocated = 0;

    await db.transaction(async (trx) => {
      // 1. Create payment record
      await trx('supplier_payments').insert({
        id: paymentId,
        supplier_id: data.supplier_id,
        total_amount: data.total_amount,
        payment_method: data.payment_method,
        payment_date: data.payment_date,
        reference_no: data.reference_no || null,
        notes: data.notes || null,
        type: 'payment',
        created_by: userId,
      });

      // 2. FIFO: Fetch unpaid/partial invoices oldest first (with row lock)
      const invoices = await trx('purchase_invoices')
        .where('supplier_id', data.supplier_id)
        .whereIn('status', ['pending', 'partial'])
        .orderBy('invoice_date', 'asc')
        .forUpdate();

      // 3. Allocate payment across invoices
      for (const invoice of invoices) {
        if (remaining <= 0) break;

        const netTotal = parseFloat(invoice.total_amount) - (parseFloat(invoice.discount_amount) || 0);
        const owed = netTotal - parseFloat(invoice.paid_amount);
        if (owed <= 0) continue;

        const allocAmount = Math.round(Math.min(remaining, owed) * 100) / 100;

        await trx('supplier_payment_allocations').insert({
          id: generateUUID(),
          payment_id: paymentId,
          invoice_id: invoice.id,
          allocated_amount: allocAmount,
        });

        const newPaidAmount = Math.round((parseFloat(invoice.paid_amount) + allocAmount) * 100) / 100;
        const newStatus = newPaidAmount >= netTotal ? 'paid' : 'partial';

        await trx('purchase_invoices')
          .where('id', invoice.id)
          .update({
            paid_amount: newPaidAmount,
            status: newStatus,
            updated_at: new Date(),
          });

        remaining = Math.round((remaining - allocAmount) * 100) / 100;
      }

      // Anything FIFO could not place stays as supplier credit and is picked up by
      // the balance formula / auto-applied to the next invoice. Reported so the caller
      // can tell the user, rather than disappearing silently.
      unallocated = Math.max(0, remaining);
    });

    const payment = await this.getPaymentById(paymentId);
    return { ...payment, unallocated_credit: unallocated };
  }

  /**
   * Create a withdrawal from a supplier (when they owe you money).
   * No FIFO allocation — just records the withdrawal.
   */
  async createWithdrawal(data, userId) {
    const paymentId = generateUUID();

    // Wrapped in a transaction so the balance check and the insert are atomic —
    // otherwise two concurrent withdrawals could each pass a check against the same
    // pre-withdrawal balance and together overdraw the supplier's credit.
    await db.transaction(async (trx) => {
      // Lock the supplier row to serialise concurrent withdrawals for this supplier.
      await trx('suppliers').where('id', data.supplier_id).forUpdate().first();

      // Reads only the balance, not the supplier's entire invoice/payment/return history.
      const { balance } = await getSupplierBalance(trx, data.supplier_id);

      if (balance >= 0) {
        throw new AppError('Supplier does not owe you money. Withdrawal not allowed.', 400);
      }

      const maxWithdrawal = Math.abs(balance);
      if (parseFloat(data.total_amount) > maxWithdrawal) {
        throw new AppError(`Withdrawal amount exceeds supplier debt. Maximum: ${maxWithdrawal.toFixed(2)}`, 400);
      }

      await trx('supplier_payments').insert({
        id: paymentId,
        supplier_id: data.supplier_id,
        total_amount: data.total_amount,
        payment_method: data.payment_method,
        payment_date: data.payment_date,
        reference_no: data.reference_no || null,
        notes: data.notes || null,
        type: 'withdrawal',
        created_by: userId,
      });
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
    return query.limit(500);
  }
}

module.exports = new PurchasesService();
