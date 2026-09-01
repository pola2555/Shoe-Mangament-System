const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const { formatSize, formatColor } = require('../../utils/variantDisplay');
const { applyDateRange } = require('../../utils/dateRange');
const { userHasStoreAccess } = require('../../middleware/auth');

/**
 * Sales service — POS checkout.
 * 
 * Flow: employee scans/selects items → creates a sale → items marked 'sold'
 * Sale prices come from store-specific or default product prices.
 */
class SalesService {
  async list({ store_id, store_ids, customer_id, search, days } = {}) {
    let query = db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .leftJoin('users', 'sales.created_by', 'users.id')
      .select(
        'sales.*',
        'stores.name as store_name',
        'customers.name as customer_name',
        'customers.phone as customer_phone',
        'users.full_name as created_by_name'
      )
      .orderBy('sales.created_at', 'desc');

    applyStoreScope(query, 'sales.store_id', { store_id, store_ids });
    if (customer_id) query = query.where('sales.customer_id', customer_id);
    
    if (days) {
      const parsedDays = parseInt(days, 10);
      if (!isNaN(parsedDays)) {
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - parsedDays);
        query = query.where('sales.created_at', '>=', dateFrom);
      }
    }

    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function() {
        this.where('sales.sale_number', 'ilike', `%${safeSearch}%`)
            .orWhere('customers.phone', 'ilike', `%${safeSearch}%`)
            .orWhere('customers.name', 'ilike', `%${safeSearch}%`);
      });
    }

    return query.limit(200);
  }

  async getById(id) {
    const sale = await db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .leftJoin('users', 'sales.created_by', 'users.id')
      .where('sales.id', id)
      .select(
        'sales.*',
        'stores.name as store_name',
        'customers.name as customer_name',
        'customers.phone as customer_phone',
        'users.full_name as created_by_name'
      )
      .first();

    if (!sale) throw new AppError('Sale not found', 404);

    sale.items = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      // Left join to see if this exact sale item exists in customer_return_items
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .where('sale_items.sale_id', id)
      .select(
        // How this category writes a size, and whether the colour is the "no colour"
        // placeholder. Without them variantFormat assumes a shoe and prints "EU KIDS".
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes',
        'product_colors.is_placeholder as color_is_placeholder',
        'sale_items.*',
        'inventory_items.cost',
        'product_variants.sku',
        'product_variants.size_eu',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'product_colors.color_name',
        'product_colors.hex_code',
        db.raw('CASE WHEN customer_return_items.id IS NOT NULL THEN true ELSE false END as is_returned')
      );

    sale.payments = await db('sale_payments').where('sale_id', id).orderBy('created_at');

    // Surface the outstanding balance so a partially-paid sale is visible in the UI.
    const paid = sale.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    sale.amount_paid = Math.round(paid * 100) / 100;
    sale.amount_due = Math.round((parseFloat(sale.final_amount) - paid) * 100) / 100;

    return sale;
  }

  async create(data, user) {
    // Store access check. This used to read `user.role`, but the users table has
    // `role_id` — so the comparison was always `undefined !== 'admin'` and any admin
    // not explicitly listed in user_stores was refused. userHasStoreAccess already
    // handles admin, all_stores, assigned_stores and the legacy store_id fallback.
    if (!userHasStoreAccess(user, data.store_id)) {
      throw new AppError('You are not assigned to this store', 403);
    }

    const userId = user.id;
    const saleId = generateUUID();

    await db.transaction(async (trx) => {
      // Inside the transaction: the advisory lock it takes must be held until commit.
      const saleNumber = await generateDocumentNumber('S', trx, 'sales', 'sale_number');
      let totalAmount = 0;

      // Validate items and compute prices
      const saleItems = [];
      for (const reqItem of data.items) {
        const itemId = reqItem.id;
        const item = await trx('inventory_items')
          .where('id', itemId).forUpdate().first();

        if (!item) throw new AppError(`Item ${itemId} not found`, 404);
        if (item.status !== 'in_stock') throw new AppError(`Item ${itemId} is not available (status: ${item.status})`, 400);
        if (item.store_id !== data.store_id) throw new AppError(`Item ${itemId} is not at this store`, 400);

        // Get the product to determine selling price boundaries
        const variant = await trx('product_variants').where('id', item.variant_id).first();
        const product = await trx('products').where('id', variant.product_id).first();

        // Check for store-specific price
        const storePrice = await trx('store_product_prices')
          .where({ product_id: product.id, store_id: data.store_id }).first();

        const defaultPrice = storePrice
          ? parseFloat(storePrice.selling_price)
          : parseFloat(product.default_selling_price) || 0;

        let sellingPrice = defaultPrice;

        if (reqItem.sale_price !== undefined && reqItem.sale_price !== null && reqItem.sale_price !== '') {
          sellingPrice = parseFloat(reqItem.sale_price);
          if (isNaN(sellingPrice) || sellingPrice < 0) {
            throw new AppError(`Invalid sale price for ${product.model_name}`, 400);
          }
          
          // Validate against min/max bounds if they exist
          if (product.min_selling_price && sellingPrice < parseFloat(product.min_selling_price)) {
            throw new AppError(`Price for ${product.model_name} cannot be less than the minimum allowed (${product.min_selling_price} EGP)`, 400);
          }
          if (product.max_selling_price && sellingPrice > parseFloat(product.max_selling_price)) {
            throw new AppError(`Price for ${product.model_name} cannot be more than the maximum allowed (${product.max_selling_price} EGP)`, 400);
          }
        }

        saleItems.push({
          id: generateUUID(),
          sale_id: saleId,
          inventory_item_id: itemId,
          sale_price: sellingPrice,
          cost_at_sale: parseFloat(item.cost),
        });

        totalAmount = Math.round((totalAmount + sellingPrice) * 100) / 100;

        // Mark item as sold
        await trx('inventory_items')
          .where('id', itemId)
          .update({ status: 'sold', sold_at: new Date(), updated_at: new Date() });
      }

      const discountAmount = Math.round((parseFloat(data.discount_amount) || 0) * 100) / 100;
      if (discountAmount < 0) throw new AppError('Discount amount cannot be negative', 400);
      if (discountAmount > totalAmount) throw new AppError('Discount cannot exceed the total amount', 400);
      const finalAmount = Math.round((totalAmount - discountAmount) * 100) / 100;

      // Create sale
      await trx('sales').insert({
        id: saleId,
        sale_number: saleNumber,
        store_id: data.store_id,
        customer_id: data.customer_id || null,
        total_amount: totalAmount,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        notes: data.notes || null,
        created_by: userId,
      });

      // Insert sale items
      await trx('sale_items').insert(saleItems);

      // Reconcile payments against the sale total. Nothing checked this before, so a
      // sale could be recorded as paid for less (or more) than it was worth.
      // Overpayment is rejected; underpayment is allowed but surfaced as amount_due,
      // so a partially-paid sale is visible rather than silently lost.
      const paymentsTotal = Math.round(
        data.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100
      ) / 100;

      // One-cent tolerance: the client sums its own cart to produce the payment
      // amount while the server re-derives the total from per-item prices, so the two
      // can differ in the last cent purely from rounding. Rejecting that would fail a
      // legitimate checkout and roll the whole sale back.
      if (paymentsTotal > finalAmount + 0.01) {
        throw new AppError(
          `Payments (${paymentsTotal.toFixed(2)}) exceed the sale total (${finalAmount.toFixed(2)})`,
          400
        );
      }

      // Single batch insert instead of one round-trip per payment method.
      await trx('sale_payments').insert(
        data.payments.map((payment) => ({
          id: generateUUID(),
          sale_id: saleId,
          amount: payment.amount,
          payment_method: payment.payment_method,
          reference_no: payment.reference_no || null,
        }))
      );
    });

    return this.getById(saleId);
  }

  async addPayment(saleId, paymentData) {
    // Validate payment amount
    const amount = parseFloat(paymentData.amount);
    if (isNaN(amount) || amount <= 0) throw new AppError('Payment amount must be positive', 400);

    // The read-then-insert used to run outside any transaction, so two concurrent
    // payments could each see the same total, both pass the overpayment check, and
    // together overpay the sale. forUpdate serialises them on the sale row.
    return db.transaction(async (trx) => {
      const sale = await trx('sales').where('id', saleId).forUpdate().first();
      if (!sale) throw new AppError('Sale not found', 404);

      const existingPayments = await trx('sale_payments').where('sale_id', saleId).sum('amount as total').first();
      const totalPaid = Math.round((parseFloat(existingPayments.total || 0)) * 100) / 100;
      const saleTotal = Math.round(parseFloat(sale.final_amount) * 100) / 100;
      if (Math.round((totalPaid + amount) * 100) / 100 > saleTotal) {
        throw new AppError(`Payment would exceed sale total. Remaining: ${(saleTotal - totalPaid).toFixed(2)}`, 400);
      }

      const [payment] = await trx('sale_payments').insert({
        id: generateUUID(),
        sale_id: saleId,
        amount: amount,
        payment_method: paymentData.payment_method,
        reference_no: paymentData.reference_no || null,
      }).returning('*');

      return payment;
    });
  }

  async exportExcel({ store_id, store_ids, startDate, endDate } = {}) {
    let query = db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .select(
        'sales.id', 'sales.sale_number', 'sales.final_amount',
        'sales.refunded_amount', 'sales.created_at',
        'stores.name as store_name',
        'customers.name as customer_name'
      )
      .orderBy('sales.created_at', 'desc')
      .limit(5000);

    applyStoreScope(query, 'sales.store_id', { store_id, store_ids });
    applyDateRange(query, 'sales.created_at', { startDate, endDate });

    const sales = await query;
    if (!sales.length) return [];

    const saleIds = sales.map(s => s.id);

    const items = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .whereIn('sale_items.sale_id', saleIds)
      .whereNull('customer_return_items.id')
      .select(
        'sale_items.sale_id', 'sale_items.sale_price',
        'products.product_code', 'products.model_name',
        'product_colors.color_name', 'product_variants.size_eu',
        // How this category writes a size, and whether the colour is the "no colour"
        // placeholder. Without them variantFormat assumes a shoe and prints "EU KIDS".
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes',
        'product_colors.is_placeholder as color_is_placeholder'
      );

    const payments = await db('sale_payments')
      .whereIn('sale_id', saleIds)
      .select('sale_id', 'amount', 'payment_method');

    // Index by sale_id
    const itemsBySale = {};
    for (const it of items) {
      if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
      itemsBySale[it.sale_id].push(it);
    }
    const paymentsBySale = {};
    for (const p of payments) {
      if (!paymentsBySale[p.sale_id]) paymentsBySale[p.sale_id] = [];
      paymentsBySale[p.sale_id].push(p);
    }

    // Build rows: one row per sale item
    const rows = [];
    for (const sale of sales) {
      const saleItems = itemsBySale[sale.id] || [];
      const salePayments = paymentsBySale[sale.id] || [];
      const cashTotal = salePayments.filter(p => p.payment_method === 'cash').reduce((s, p) => s + parseFloat(p.amount), 0);
      const otherTotal = salePayments.filter(p => p.payment_method !== 'cash').reduce((s, p) => s + parseFloat(p.amount), 0);
      const otherMethods = [...new Set(salePayments.filter(p => p.payment_method !== 'cash').map(p => p.payment_method))].join(', ');

      for (let i = 0; i < saleItems.length; i++) {
        const item = saleItems[i];
        rows.push({
          sale_number: sale.sale_number,
          date: new Date(sale.created_at).toLocaleDateString(),
          store: sale.store_name,
          customer: sale.customer_name || 'Walk-in',
          product: `${item.product_code} - ${item.model_name}`,
          // Written the way the app writes a size and a colour anywhere else: a sock
          // exports as "Kids", not "KIDS", and a knife's stand-in colour as blank
          // rather than the word "Standard".
          color: formatColor(item),
          size: formatSize(item),
          price: parseFloat(item.sale_price),
          cash: i === 0 ? cashTotal : '',
          other: i === 0 ? otherTotal : '',
          other_methods: i === 0 ? otherMethods : '',
        });
      }
    }

    return rows;
  }
}

module.exports = new SalesService();
