const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');

/**
 * Sales service — POS checkout.
 * 
 * Flow: employee scans/selects items → creates a sale → items marked 'sold'
 * Sale prices come from store-specific or default product prices.
 */
class SalesService {
  async list({ store_id, customer_id, search, days } = {}) {
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

    if (store_id) query = query.where('sales.store_id', store_id);
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
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .where('sale_items.sale_id', id)
      .select(
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

    return sale;
  }

  async create(data, userId) {
    // Store access check: verify user is assigned to this store
    const userStore = await db('user_stores')
      .where({ user_id: userId, store_id: data.store_id })
      .first();
    if (!userStore) {
      // Check if user is admin (admins bypass store restriction)
      const user = await db('users').where('id', userId).first();
      if (user.role !== 'admin') {
        throw new AppError('You are not assigned to this store', 403);
      }
    }

    const saleNumber = await generateDocumentNumber('S', db, 'sales', 'sale_number');
    const saleId = generateUUID();

    await db.transaction(async (trx) => {
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

      // Insert payments
      for (const payment of data.payments) {
        await trx('sale_payments').insert({
          id: generateUUID(),
          sale_id: saleId,
          amount: payment.amount,
          payment_method: payment.payment_method,
          reference_no: payment.reference_no || null,
        });
      }
    });

    return this.getById(saleId);
  }

  async addPayment(saleId, paymentData) {
    const sale = await db('sales').where('id', saleId).first();
    if (!sale) throw new AppError('Sale not found', 404);

    // Validate payment amount
    const amount = parseFloat(paymentData.amount);
    if (isNaN(amount) || amount <= 0) throw new AppError('Payment amount must be positive', 400);

    // Prevent overpayment
    const existingPayments = await db('sale_payments').where('sale_id', saleId).sum('amount as total').first();
    const totalPaid = Math.round((parseFloat(existingPayments.total || 0)) * 100) / 100;
    const saleTotal = Math.round(parseFloat(sale.final_amount) * 100) / 100;
    if (Math.round((totalPaid + amount) * 100) / 100 > saleTotal) {
      throw new AppError(`Payment would exceed sale total. Remaining: ${(saleTotal - totalPaid).toFixed(2)}`, 400);
    }

    const [payment] = await db('sale_payments').insert({
      id: generateUUID(),
      sale_id: saleId,
      amount: amount,
      payment_method: paymentData.payment_method,
      reference_no: paymentData.reference_no || null,
    }).returning('*');

    return payment;
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

    if (store_id) query = query.where('sales.store_id', store_id);
    else if (store_ids?.length) query = query.whereIn('sales.store_id', store_ids);
    if (startDate) query = query.where('sales.created_at', '>=', startDate);
    if (endDate) query = query.where('sales.created_at', '<=', endDate + 'T23:59:59');

    const sales = await query;
    if (!sales.length) return [];

    const saleIds = sales.map(s => s.id);

    const items = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .whereIn('sale_items.sale_id', saleIds)
      .select(
        'sale_items.sale_id', 'sale_items.sale_price',
        'products.product_code', 'products.model_name',
        'product_colors.color_name', 'product_variants.size_eu'
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

      for (const item of saleItems) {
        rows.push({
          sale_number: sale.sale_number,
          date: new Date(sale.created_at).toLocaleDateString(),
          store: sale.store_name,
          customer: sale.customer_name || 'Walk-in',
          product: `${item.product_code} - ${item.model_name}`,
          color: item.color_name,
          size: item.size_eu,
          price: parseFloat(item.sale_price),
          cash: cashTotal,
          other: otherTotal,
          other_methods: otherMethods,
        });
      }
    }

    return rows;
  }
}

module.exports = new SalesService();
