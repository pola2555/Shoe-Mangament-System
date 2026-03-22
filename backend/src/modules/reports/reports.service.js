const db = require('../../config/database');

/**
 * Reports service — aggregated business metrics for the dashboard.
 */
class ReportsService {
  async getDashboardStats(filters = {}) {
    const { startDate, endDate, store_id, limit = 5 } = filters;
    const lmt = parseInt(limit, 10) || 5;

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
}

module.exports = new ReportsService();
