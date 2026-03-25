const db = require('../../config/database');

/**
 * Reports service — aggregated business metrics for the dashboard.
 */
class ReportsService {

  // ============================================================
  // DASHBOARD HOME (lightweight daily snapshot)
  // ============================================================
  async getDashboardHome(filters = {}) {
    const { store_id } = filters;
    const today = new Date().toISOString().split('T')[0];

    const applyStore = (q, col = 'store_id') => { if (store_id) q.where(col, store_id); return q; };

    // Today's snapshot
    const salesToday = await applyStore(
      db('sales').where('created_at', '>=', today)
        .select(db.raw('COUNT(id) as count'), db.raw('COALESCE(SUM(final_amount), 0) as revenue'))
    ).first();

    const itemsSoldToday = await applyStore(
      db('sale_items').join('sales', 'sale_items.sale_id', 'sales.id')
        .where('sales.created_at', '>=', today)
        .count('sale_items.id as count'),
      'sales.store_id'
    ).first();

    const returnsTodayResult = await applyStore(
      db('customer_returns').where('created_at', '>=', today).count('id as count'),
      'store_id'
    ).first();

    return {
      today: {
        sales_count: parseInt(salesToday.count) || 0,
        revenue: parseFloat(salesToday.revenue) || 0,
        items_sold: parseInt(itemsSoldToday.count) || 0,
        returns: parseInt(returnsTodayResult.count) || 0,
      },
    };
  }

  // Admin-only sections (pending tasks, recent sales, recent activity)
  async getDashboardAdmin(filters = {}) {
    const { store_id } = filters;
    const applyStore = (q, col = 'store_id') => { if (store_id) q.where(col, store_id); return q; };

    // Pending transfers
    const pendingTransfers = await db('store_transfers')
      .whereIn('status', ['pending', 'shipped'])
      .join('stores as from_s', 'store_transfers.from_store_id', 'from_s.id')
      .join('stores as to_s', 'store_transfers.to_store_id', 'to_s.id')
      .select('store_transfers.id', 'store_transfers.transfer_number', 'store_transfers.status',
        'from_s.name as from_store', 'to_s.name as to_store', 'store_transfers.created_at')
      .orderBy('store_transfers.created_at', 'desc')
      .limit(5);

    // Unpaid supplier invoices
    const unpaidInvoices = await db('purchase_invoices')
      .join('suppliers', 'purchase_invoices.supplier_id', 'suppliers.id')
      .whereIn('purchase_invoices.status', ['pending', 'partial'])
      .select('purchase_invoices.id', 'purchase_invoices.invoice_number', 'suppliers.name as supplier_name',
        'purchase_invoices.total_amount', 'purchase_invoices.paid_amount', 'purchase_invoices.status')
      .orderByRaw('purchase_invoices.total_amount - purchase_invoices.paid_amount DESC')
      .limit(5);

    // Low stock count
    const lowStockResult = await applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .where('inventory_items.status', 'in_stock')
        .select('products.id')
        .count('inventory_items.id as stock')
        .groupBy('products.id')
        .having(db.raw('COUNT(inventory_items.id)'), '<', 5),
      'inventory_items.store_id'
    );

    // Recent 5 sales
    const recentSales = await applyStore(
      db('sales')
        .leftJoin('customers', 'sales.customer_id', 'customers.id')
        .leftJoin('stores', 'sales.store_id', 'stores.id')
        .leftJoin('users', 'sales.created_by', 'users.id')
        .select('sales.id', 'sales.sale_number', 'sales.final_amount', 'sales.created_at',
          'customers.name as customer_name', 'stores.name as store_name', 'users.full_name as cashier')
        .orderBy('sales.created_at', 'desc')
        .limit(5)
    );

    // Recent 5 activity
    const recentActivity = await applyStore(
      db('activity_log')
        .leftJoin('users', 'activity_log.user_id', 'users.id')
        .select('activity_log.id', 'activity_log.action', 'activity_log.module',
          'activity_log.details', 'activity_log.created_at', 'users.full_name as user_name')
        .orderBy('activity_log.created_at', 'desc')
        .limit(5),
      'activity_log.store_id'
    );

    return {
      pending_transfers: pendingTransfers,
      unpaid_invoices: unpaidInvoices.map(i => ({
        ...i, total_amount: parseFloat(i.total_amount), paid_amount: parseFloat(i.paid_amount),
        balance: parseFloat(i.total_amount) - parseFloat(i.paid_amount),
      })),
      low_stock_count: lowStockResult.length,
      recent_sales: recentSales.map(s => ({ ...s, final_amount: parseFloat(s.final_amount) })),
      recent_activity: recentActivity,
    };
  }

  async getDashboardStats(filters = {}) {
    const { startDate, endDate, store_id, limit = 5 } = filters;
    const lmt = Math.min(50, Math.max(1, parseInt(limit, 10) || 5));

    const applyDateFilter = (query, dateColumn = 'created_at') => {
      if (startDate) query.where(dateColumn, '>=', startDate);
      if (endDate) query.where(dateColumn, '<=', endDate + ' 23:59:59');
      return query;
    };

    const applyStoreFilter = (query, storeColumn = 'store_id') => {
      if (store_id) query.where(storeColumn, store_id);
      return query;
    };

    const applyBoth = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      applyDateFilter(query, dateCol);
      if (storeCol) applyStoreFilter(query, storeCol);
      return query;
    };

    // 1. Basic Counts & Totals (Filtered)
    const inventoryQuery = db('inventory_items').where('status', 'in_stock').count('id as count');
    applyStoreFilter(inventoryQuery, 'store_id');
    const inventoryResult = await inventoryQuery.first();

    const salesQuery = db('sales').count('id as count').sum('total_amount as subtotal').sum('final_amount as total').sum('refunded_amount as refunded');
    applyBoth(salesQuery, 'created_at', 'store_id');
    const salesResult = await salesQuery.first();

    // 2. Profit & Items Sold (Filtered)
    const profitQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .select(
        db.raw('COUNT(sale_items.id) as items_sold'),
        db.raw('SUM(CASE WHEN customer_return_items.id IS NOT NULL THEN 1 ELSE 0 END) as items_returned')
      );
    applyBoth(profitQuery, 'sales.created_at', 'sales.store_id');
    const profitData = await profitQuery.first();

    const actualProfitData = await applyBoth(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select(
          db.raw('SUM(sale_items.sale_price - sale_items.cost_at_sale) as profit')
        ),
      'sales.created_at', 'sales.store_id'
    ).first();

    // 3. Expenses (Filtered)
    const expensesQuery = db('expenses').sum('amount as total');
    applyBoth(expensesQuery, 'expense_date', 'store_id');
    const expensesResult = await expensesQuery.first();

    // 4. Supplier/Dealer Balances (Global typically) + Inventory Valuation
    const valQuery = db('inventory_items').where('status', 'in_stock').sum('cost as total');
    applyStoreFilter(valQuery, 'store_id');
    const valResult = await valQuery.first();

    const pendingTransfersQuery = db('store_transfers').whereIn('status', ['pending', 'shipped']).count('id as count');
    applyStoreFilter(pendingTransfersQuery, 'from_store_id'); // Optional interpretation
    const pendingTransfers = await pendingTransfersQuery.first();

    // 5. Sales Trend (Line Chart grouping by Date)
    const trendQuery = db('sales')
      .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
      .sum('final_amount as revenue')
      .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
      .orderBy('date', 'asc');
    applyBoth(trendQuery, 'created_at', 'store_id');
    const salesTrend = await trendQuery;

    // 6. Profit Trend
    const profitTrendQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .whereNull('customer_return_items.id')
      .select(
        db.raw("TO_CHAR(sales.created_at, 'YYYY-MM-DD') as date"),
        db.raw('SUM(sale_items.sale_price - sale_items.cost_at_sale) as profit')
      )
      .groupByRaw("TO_CHAR(sales.created_at, 'YYYY-MM-DD')")
      .orderBy('date', 'asc');
    applyBoth(profitTrendQuery, 'sales.created_at', 'sales.store_id');
    const profitTrend = await profitTrendQuery;

    const trendMap = {};
    salesTrend.forEach(t => trendMap[t.date] = { date: t.date, revenue: parseFloat(t.revenue) || 0, profit: 0 });
    profitTrend.forEach(t => {
      if (!trendMap[t.date]) trendMap[t.date] = { date: t.date, revenue: 0, profit: 0 };
      trendMap[t.date].profit = parseFloat(t.profit) || 0;
    });
    const finalTrend = Object.values(trendMap).sort((a,b) => a.date.localeCompare(b.date));

    // 7. Store Performance
    const storePerf = await applyDateFilter(
      db('sales')
        .join('stores', 'sales.store_id', 'stores.id')
        .select('stores.name')
        .sum('sales.final_amount as revenue')
        .groupBy('sales.store_id', 'stores.name'),
      'sales.created_at'
    );

    // 8. Payment Methods
    const paymentsQuery = db('sale_payments')
      .join('sales', 'sale_payments.sale_id', 'sales.id')
      .select('sale_payments.payment_method as method')
      .sum('sale_payments.amount as total')
      .groupBy('sale_payments.payment_method');
    applyBoth(paymentsQuery, 'sales.created_at', 'sales.store_id');
    const paymentsPerf = await paymentsQuery;

    // 9. Top Products
    const topProdQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .select('products.product_code as product', 'products.model_name as name')
      .count('sale_items.id as qty')
      .sum('sale_items.sale_price as revenue')
      .whereNull('customer_return_items.id')
      .groupBy('products.id', 'products.product_code', 'products.model_name')
      .orderBy('qty', 'desc')
      .limit(lmt);
    applyBoth(topProdQuery, 'sales.created_at', 'sales.store_id');
    const topProducts = await topProdQuery;

    // 10. Low Stock Alerts
    const lowStockQuery = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .where('inventory_items.status', 'in_stock')
      .select('products.product_code as product', 'products.model_name as name')
      .count('inventory_items.id as current_stock')
      .groupBy('products.id', 'products.product_code', 'products.model_name')
      .orderBy('current_stock', 'asc')
      .limit(lmt);
    applyStoreFilter(lowStockQuery, 'inventory_items.store_id');
    const lowStock = await lowStockQuery;

    // Calculations
    const salesCountVal = parseInt(salesResult.count) || 0;
    const itemsSoldVal = parseInt(profitData.items_sold) || 0;
    const itemsReturnedVal = parseInt(profitData.items_returned) || 0;
    const revenueVal = parseFloat(salesResult.total) || 0;
    const refundedVal = parseFloat(salesResult.refunded) || 0;
    const netSalesVal = revenueVal - refundedVal;
    
    const clearProfitVal = parseFloat(actualProfitData?.profit) || 0;

    const netMargin = netSalesVal > 0 ? (clearProfitVal / netSalesVal) * 100 : 0;
    const aov = salesCountVal > 0 ? netSalesVal / salesCountVal : 0;

    return {
      metrics: {
        inventory_in_stock: parseInt(inventoryResult.count) || 0,
        inventory_valuation: parseFloat(valResult.total) || 0,
        total_sales: salesCountVal,
        items_sold: itemsSoldVal,
        items_returned: itemsReturnedVal,
        total_revenue: revenueVal,
        refunded_amount: refundedVal,
        net_sales: netSalesVal,
        clear_profit: clearProfitVal,
        net_margin_pct: parseFloat(netMargin.toFixed(2)),
        aov: parseFloat(aov.toFixed(2)),
        total_expenses: parseFloat(expensesResult.total) || 0,
      },
      charts: {
        trend: finalTrend,
        store_performance: storePerf.map(s => ({ name: s.name, value: parseFloat(s.revenue) || 0 })),
        payment_methods: paymentsPerf.map(p => ({ name: p.method, value: parseFloat(p.total) || 0 })),
      },
      leaderboards: {
        top_products: topProducts.map(p => ({ product: p.product, name: p.name, qty: p.qty, revenue: p.revenue })),
        low_stock: lowStock.map(p => ({ product: p.product, name: p.name, stock: p.current_stock }))
      }
    };
  }

  // ============================================================
  // SALES ANALYTICS
  // ============================================================
  async getSalesAnalytics(filters = {}) {
    const { startDate, endDate, store_id } = filters;

    const applyFilters = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      if (startDate) query.where(dateCol, '>=', startDate);
      if (endDate) query.where(dateCol, '<=', endDate + ' 23:59:59');
      if (store_id && storeCol) query.where(storeCol, store_id);
      return query;
    };

    // Daily sales trend
    const dailySales = await applyFilters(
      db('sales')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
        .orderBy('date', 'asc')
    );

    // Hourly distribution
    const hourly = await applyFilters(
      db('sales')
        .select(db.raw("EXTRACT(HOUR FROM created_at)::int as hour"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("EXTRACT(HOUR FROM created_at)")
        .orderBy('hour', 'asc')
    );

    // Day-of-week distribution
    const dayOfWeek = await applyFilters(
      db('sales')
        .select(db.raw("EXTRACT(DOW FROM created_at)::int as dow"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("EXTRACT(DOW FROM created_at)")
        .orderBy('dow', 'asc')
    );

    // Payment methods breakdown
    const paymentMethods = await applyFilters(
      db('sale_payments')
        .join('sales', 'sale_payments.sale_id', 'sales.id')
        .select('sale_payments.payment_method as method')
        .count('sale_payments.id as count')
        .sum('sale_payments.amount as total')
        .groupBy('sale_payments.payment_method'),
      'sales.created_at', 'sales.store_id'
    );

    // Average order value trend
    const aovTrend = await applyFilters(
      db('sales')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
        .avg('final_amount as aov')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
        .orderBy('date', 'asc')
    );

    // Discount analysis
    const discountStats = await applyFilters(
      db('sales')
        .select(
          db.raw('COUNT(id) as total_sales'),
          db.raw('SUM(CASE WHEN discount_amount > 0 THEN 1 ELSE 0 END) as discounted_sales'),
          db.raw('SUM(discount_amount) as total_discount'),
          db.raw('AVG(CASE WHEN discount_amount > 0 THEN discount_amount ELSE NULL END) as avg_discount')
        )
    ).first();

    return {
      daily_sales: dailySales.map(r => ({ date: r.date, count: parseInt(r.count), revenue: parseFloat(r.revenue) || 0 })),
      hourly_distribution: hourly.map(r => ({ hour: r.hour, count: parseInt(r.count), revenue: parseFloat(r.revenue) || 0 })),
      day_of_week: dayOfWeek.map(r => ({ dow: r.dow, count: parseInt(r.count), revenue: parseFloat(r.revenue) || 0 })),
      payment_methods: paymentMethods.map(r => ({ method: r.method, count: parseInt(r.count), total: parseFloat(r.total) || 0 })),
      aov_trend: aovTrend.map(r => ({ date: r.date, aov: parseFloat(r.aov) || 0 })),
      discount_stats: {
        total_sales: parseInt(discountStats.total_sales) || 0,
        discounted_sales: parseInt(discountStats.discounted_sales) || 0,
        total_discount: parseFloat(discountStats.total_discount) || 0,
        avg_discount: parseFloat(discountStats.avg_discount) || 0,
      },
    };
  }

  // ============================================================
  // PRODUCT ANALYTICS
  // ============================================================
  async getProductAnalytics(filters = {}) {
    const { startDate, endDate, store_id, limit = 20 } = filters;
    const lmt = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      if (startDate) query.where(dateCol, '>=', startDate);
      if (endDate) query.where(dateCol, '<=', endDate + ' 23:59:59');
      if (store_id && storeCol) query.where(storeCol, store_id);
      return query;
    };

    // Top selling products by quantity
    const topByQty = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.product_code', 'products.model_name', 'products.brand')
        .count('sale_items.id as qty_sold')
        .sum('sale_items.sale_price as revenue')
        .sum(db.raw('sale_items.sale_price - sale_items.cost_at_sale as profit'))
        .groupBy('products.id', 'products.product_code', 'products.model_name', 'products.brand')
        .orderBy('qty_sold', 'desc')
        .limit(lmt)
    );

    // Top selling by revenue
    const topByRevenue = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.product_code', 'products.model_name', 'products.brand')
        .count('sale_items.id as qty_sold')
        .sum('sale_items.sale_price as revenue')
        .sum(db.raw('sale_items.sale_price - sale_items.cost_at_sale as profit'))
        .groupBy('products.id', 'products.product_code', 'products.model_name', 'products.brand')
        .orderBy('revenue', 'desc')
        .limit(lmt)
    );

    // Size distribution
    const sizeDistribution = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('product_variants.size_eu as size')
        .count('sale_items.id as count')
        .groupBy('product_variants.size_eu')
        .orderBy('count', 'desc')
    );

    // Brand performance
    const brandPerformance = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.brand')
        .count('sale_items.id as qty_sold')
        .sum('sale_items.sale_price as revenue')
        .groupBy('products.brand')
        .orderBy('revenue', 'desc')
    );

    return {
      top_by_qty: topByQty.map(r => ({ code: r.product_code, name: r.model_name, brand: r.brand, qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0, profit: parseFloat(r.profit) || 0 })),
      top_by_revenue: topByRevenue.map(r => ({ code: r.product_code, name: r.model_name, brand: r.brand, qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0, profit: parseFloat(r.profit) || 0 })),
      size_distribution: sizeDistribution.map(r => ({ size: r.size, count: parseInt(r.count) })),
      brand_performance: brandPerformance.map(r => ({ brand: r.brand || 'Unknown', qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0 })),
    };
  }

  // ============================================================
  // INVENTORY ANALYTICS
  // ============================================================
  async getInventoryAnalytics(filters = {}) {
    const { store_id } = filters;

    const applyStore = (query, col = 'inventory_items.store_id') => {
      if (store_id) query.where(col, store_id);
      return query;
    };

    // Stock by store
    const stockByStore = await db('inventory_items')
      .join('stores', 'inventory_items.store_id', 'stores.id')
      .where('inventory_items.status', 'in_stock')
      .select('stores.name')
      .count('inventory_items.id as count')
      .sum('inventory_items.cost as value')
      .groupBy('stores.id', 'stores.name')
      .orderBy('count', 'desc');

    // Stock by brand
    const stockByBrand = await applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .where('inventory_items.status', 'in_stock')
        .select('products.brand')
        .count('inventory_items.id as count')
        .groupBy('products.brand')
        .orderBy('count', 'desc')
    );

    // Stock by size
    const stockBySize = await applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .where('inventory_items.status', 'in_stock')
        .select('product_variants.size_eu as size')
        .count('inventory_items.id as count')
        .groupBy('product_variants.size_eu')
        .orderBy('size', 'asc')
    );

    // Stock aging (days since purchase)
    const aging = await applyStore(
      db('inventory_items')
        .where('inventory_items.status', 'in_stock')
        .select(
          db.raw("SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::int as within_30"),
          db.raw("SUM(CASE WHEN created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::int as d30_60"),
          db.raw("SUM(CASE WHEN created_at >= NOW() - INTERVAL '90 days' AND created_at < NOW() - INTERVAL '60 days' THEN 1 ELSE 0 END)::int as d60_90"),
          db.raw("SUM(CASE WHEN created_at < NOW() - INTERVAL '90 days' THEN 1 ELSE 0 END)::int as over_90")
        )
    ).first();

    // Low stock products (< 5 items)
    const lowStock = await applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .where('inventory_items.status', 'in_stock')
        .select('products.product_code', 'products.model_name')
        .count('inventory_items.id as stock')
        .groupBy('products.id', 'products.product_code', 'products.model_name')
        .having(db.raw('COUNT(inventory_items.id)'), '<', 5)
        .orderBy('stock', 'asc')
        .limit(20)
    );

    // Status distribution
    const statusDist = await applyStore(
      db('inventory_items')
        .select('status')
        .count('id as count')
        .groupBy('status')
    );

    return {
      stock_by_store: stockByStore.map(r => ({ name: r.name, count: parseInt(r.count), value: parseFloat(r.value) || 0 })),
      stock_by_brand: stockByBrand.map(r => ({ brand: r.brand || 'Unknown', count: parseInt(r.count) })),
      stock_by_size: stockBySize.map(r => ({ size: r.size, count: parseInt(r.count) })),
      aging: { within_30: aging.within_30 || 0, d30_60: aging.d30_60 || 0, d60_90: aging.d60_90 || 0, over_90: aging.over_90 || 0 },
      low_stock: lowStock.map(r => ({ code: r.product_code, name: r.model_name, stock: parseInt(r.stock) })),
      status_distribution: statusDist.map(r => ({ status: r.status, count: parseInt(r.count) })),
    };
  }

  // ============================================================
  // FINANCIAL REPORT
  // ============================================================
  async getFinancialReport(filters = {}) {
    const { startDate, endDate, store_id } = filters;

    const applyFilters = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      if (startDate) query.where(dateCol, '>=', startDate);
      if (endDate) query.where(dateCol, '<=', endDate + ' 23:59:59');
      if (store_id && storeCol) query.where(storeCol, store_id);
      return query;
    };

    // Revenue
    const revenue = await applyFilters(
      db('sales').select(
        db.raw('SUM(final_amount) as total_revenue'),
        db.raw('SUM(refunded_amount) as total_refunded'),
        db.raw('SUM(discount_amount) as total_discount')
      )
    ).first();

    // COGS (cost of goods sold)
    const cogs = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select(db.raw('SUM(sale_items.cost_at_sale) as total_cogs')),
      'sales.created_at', 'sales.store_id'
    ).first();

    // Expenses by category
    const expensesByCategory = await applyFilters(
      db('expenses')
        .join('expense_categories', 'expenses.category_id', 'expense_categories.id')
        .select('expense_categories.name as category')
        .sum('expenses.amount as total')
        .groupBy('expense_categories.name')
        .orderBy('total', 'desc'),
      'expenses.expense_date', 'expenses.store_id'
    );

    // Monthly P&L trend
    const monthlyPL = await applyFilters(
      db('sales')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM') as month"))
        .sum('final_amount as revenue')
        .sum('refunded_amount as refunds')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM')")
        .orderBy('month', 'asc')
    );

    const monthlyExpenses = await applyFilters(
      db('expenses')
        .select(db.raw("TO_CHAR(expense_date, 'YYYY-MM') as month"))
        .sum('amount as expenses')
        .groupByRaw("TO_CHAR(expense_date, 'YYYY-MM')")
        .orderBy('month', 'asc'),
      'expense_date', 'store_id'
    );

    // Merge monthly data
    const monthMap = {};
    monthlyPL.forEach(r => { monthMap[r.month] = { month: r.month, revenue: parseFloat(r.revenue) || 0, refunds: parseFloat(r.refunds) || 0, expenses: 0 }; });
    monthlyExpenses.forEach(r => {
      if (!monthMap[r.month]) monthMap[r.month] = { month: r.month, revenue: 0, refunds: 0, expenses: 0 };
      monthMap[r.month].expenses = parseFloat(r.expenses) || 0;
    });
    const plTrend = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    // Supplier balances
    const supplierBalances = await db('suppliers')
      .leftJoin('purchase_invoices', 'suppliers.id', 'purchase_invoices.supplier_id')
      .select('suppliers.name')
      .sum('purchase_invoices.total_amount as invoiced')
      .sum('purchase_invoices.paid_amount as paid')
      .groupBy('suppliers.id', 'suppliers.name')
      .havingRaw('SUM(purchase_invoices.total_amount) - SUM(purchase_invoices.paid_amount) > 0')
      .orderByRaw('SUM(purchase_invoices.total_amount) - SUM(purchase_invoices.paid_amount) DESC')
      .limit(10);

    const totalRevenue = parseFloat(revenue.total_revenue) || 0;
    const totalRefunded = parseFloat(revenue.total_refunded) || 0;
    const totalCogs = parseFloat(cogs.total_cogs) || 0;
    const totalExpenses = expensesByCategory.reduce((s, r) => s + (parseFloat(r.total) || 0), 0);

    return {
      summary: {
        total_revenue: totalRevenue,
        total_refunded: totalRefunded,
        net_revenue: totalRevenue - totalRefunded,
        total_discount: parseFloat(revenue.total_discount) || 0,
        cogs: totalCogs,
        gross_profit: totalRevenue - totalRefunded - totalCogs,
        total_expenses: totalExpenses,
        net_profit: totalRevenue - totalRefunded - totalCogs - totalExpenses,
      },
      expenses_by_category: expensesByCategory.map(r => ({ category: r.category, total: parseFloat(r.total) || 0 })),
      pl_trend: plTrend,
      supplier_balances: supplierBalances.map(r => ({ name: r.name, invoiced: parseFloat(r.invoiced) || 0, paid: parseFloat(r.paid) || 0, balance: (parseFloat(r.invoiced) || 0) - (parseFloat(r.paid) || 0) })),
    };
  }

  // ============================================================
  // CUSTOMER ANALYTICS
  // ============================================================
  async getCustomerAnalytics(filters = {}) {
    const { startDate, endDate, store_id, limit = 20 } = filters;
    const lmt = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      if (startDate) query.where(dateCol, '>=', startDate);
      if (endDate) query.where(dateCol, '<=', endDate + ' 23:59:59');
      if (store_id && storeCol) query.where(storeCol, store_id);
      return query;
    };

    // Top customers by spending
    const topCustomers = await applyFilters(
      db('sales')
        .join('customers', 'sales.customer_id', 'customers.id')
        .select('customers.name', 'customers.phone')
        .count('sales.id as visits')
        .sum('sales.final_amount as total_spent')
        .groupBy('customers.id', 'customers.name', 'customers.phone')
        .orderBy('total_spent', 'desc')
        .limit(lmt)
    );

    // New vs returning customers per month
    const customerTrend = await applyFilters(
      db('sales')
        .whereNotNull('customer_id')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM') as month"))
        .count('id as total_orders')
        .countDistinct('customer_id as unique_customers')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM')")
        .orderBy('month', 'asc')
    );

    // Return rate by customer
    const returnRates = await applyFilters(
      db('customer_returns')
        .join('sales', 'customer_returns.sale_id', 'sales.id')
        .join('customers', 'sales.customer_id', 'customers.id')
        .select('customers.name', 'customers.phone')
        .count('customer_returns.id as return_count')
        .groupBy('customers.id', 'customers.name', 'customers.phone')
        .orderBy('return_count', 'desc')
        .limit(10),
      'customer_returns.created_at', 'customer_returns.store_id'
    );

    // Walk-in vs registered
    const walkInStats = await applyFilters(
      db('sales')
        .select(
          db.raw('COUNT(id) as total'),
          db.raw('SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) as walk_in'),
          db.raw('SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) as registered')
        )
    ).first();

    return {
      top_customers: topCustomers.map(r => ({ name: r.name, phone: r.phone, visits: parseInt(r.visits), total_spent: parseFloat(r.total_spent) || 0 })),
      customer_trend: customerTrend.map(r => ({ month: r.month, total_orders: parseInt(r.total_orders), unique_customers: parseInt(r.unique_customers) })),
      top_returners: returnRates.map(r => ({ name: r.name, phone: r.phone, returns: parseInt(r.return_count) })),
      walk_in_stats: {
        total: parseInt(walkInStats.total) || 0,
        walk_in: parseInt(walkInStats.walk_in) || 0,
        registered: parseInt(walkInStats.registered) || 0,
      },
    };
  }

  // ============================================================
  // EMPLOYEE ANALYTICS
  // ============================================================
  async getEmployeeAnalytics(filters = {}) {
    const { startDate, endDate, store_id } = filters;

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      if (startDate) query.where(dateCol, '>=', startDate);
      if (endDate) query.where(dateCol, '<=', endDate + ' 23:59:59');
      if (store_id && storeCol) query.where(storeCol, store_id);
      return query;
    };

    // Sales by employee
    const salesByEmployee = await applyFilters(
      db('sales')
        .join('users', 'sales.created_by', 'users.id')
        .select('users.full_name')
        .count('sales.id as sales_count')
        .sum('sales.final_amount as revenue')
        .groupBy('users.id', 'users.full_name')
        .orderBy('revenue', 'desc')
    );

    // Employee daily trend
    const empTrend = await applyFilters(
      db('sales')
        .join('users', 'sales.created_by', 'users.id')
        .select(db.raw("TO_CHAR(sales.created_at, 'YYYY-MM-DD') as date"), 'users.full_name')
        .count('sales.id as count')
        .sum('sales.final_amount as revenue')
        .groupByRaw("TO_CHAR(sales.created_at, 'YYYY-MM-DD'), users.full_name")
        .orderBy('date', 'asc')
    );

    // Format emp trend as { date, employee1, employee2, ... }
    const empMap = {};
    const empNames = new Set();
    empTrend.forEach(r => {
      empNames.add(r.full_name);
      if (!empMap[r.date]) empMap[r.date] = { date: r.date };
      empMap[r.date][r.full_name] = parseFloat(r.revenue) || 0;
    });

    return {
      sales_by_employee: salesByEmployee.map(r => ({ name: r.full_name, sales_count: parseInt(r.sales_count), revenue: parseFloat(r.revenue) || 0 })),
      employee_trend: Object.values(empMap).sort((a, b) => a.date.localeCompare(b.date)),
      employee_names: [...empNames],
    };
  }
}

module.exports = new ReportsService();
