const db = require('../../config/database');
const { applyStoreScope } = require('../../utils/storeScope');
const { businessDayStart, businessDayBoundary, applyDateRange, defaultRange, addDays } = require('../../utils/dateRange');
const { suppliersWithOutstandingBalance } = require('../../utils/supplierBalance');
// One definition of "cash with no cash-up", shared with the till strip. shifts.service
// pulls in nothing from here, so this import is one-directional and safe.
const { applyUnassignedCash } = require('../shifts/shifts.service');

// Revenue and profit per sale line live in utils/saleMath.js, so the store reports
// and these reports cannot drift apart.
const { ITEM_NET_REVENUE, ITEM_PROFIT } = require('../../utils/saleMath');

/**
 * Reports service — aggregated business metrics for the dashboard.
 *
 * Two conventions every method here follows:
 *   - Store filtering goes through applyStoreScope so multi-store users are scoped
 *     to their assigned stores, not silently given the whole company.
 *   - Date ranges go through applyDateRange, which uses a half-open [start, end+1day)
 *     interval in the business timezone rather than a UTC `<= end + ' 23:59:59'` string.
 */
/**
 * Report filters arrive as raw query strings. A malformed uuid would reach Postgres
 * as a cast error and surface to the user as a 500, so anything that is not a uuid is
 * treated as "no filter" rather than as an error.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function asUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

class ReportsService {

  // ============================================================
  // DASHBOARD HOME (lightweight daily snapshot)
  // ============================================================
  async getDashboardHome(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    // The UTC instant of local midnight, not a bare date string — Postgres would
    // otherwise resolve the literal in the server's timezone and miss the first
    // few hours of the local day.
    const today = businessDayBoundary(businessDayStart());

    const applyStore = (q, col = 'store_id') => applyStoreScope(q, col, scope);

    // Today's snapshot
    const salesToday = await applyStore(
      db('sales').whereNull('sales.voided_at').where('created_at', '>=', today)
        .select(db.raw('COUNT(id) as count'), db.raw('COALESCE(SUM(final_amount), 0) as revenue'))
    ).first();

    const itemsSoldToday = await applyStore(
      db('sale_items').join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
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
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const applyStore = (q, col = 'store_id') => applyStoreScope(q, col, scope);

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

    // Low stock count. Previously this pulled every matching group just to read .length;
    // count the groups in the database instead.
    const lowStockInner = applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .where('inventory_items.status', 'in_stock')
        .select('product_variants.product_id')
        .groupBy('product_variants.product_id')
        .having(db.raw('COUNT(inventory_items.id)'), '<', 5),
      'inventory_items.store_id'
    );
    const lowStockCountRow = await db.count('* as count').from(lowStockInner.as('low_stock')).first();

    // Recent 5 sales
    const recentSales = await applyStore(
      db('sales').whereNull('sales.voided_at')
        .leftJoin('customers', 'sales.customer_id', 'customers.id')
        .leftJoin('stores', 'sales.store_id', 'stores.id')
        .leftJoin('users', 'sales.created_by', 'users.id')
        .select('sales.id', 'sales.sale_number', 'sales.final_amount', 'sales.created_at',
          'customers.name as customer_name', 'stores.name as store_name', 'users.full_name as cashier')
        .orderBy('sales.created_at', 'desc')
        .limit(5),
      // Must be qualified: the joined customers/stores tables also carry a
      // store_id, so a bare 'store_id' is ambiguous and Postgres rejects it.
      'sales.store_id'
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

    // Overdue loans.
    //
    // Overdue is derived from due_date against CURRENT_DATE rather than stored: a
    // stored flag is wrong the morning after it is written unless something sweeps the
    // table, and there is no scheduler in this deployment. Surfacing it here is the
    // reminder — a loan nobody is chasing is the whole reason to track loans at all.
    //
    // Loans with no store belong to the business rather than a branch, so they are not
    // scoped away; that matches how the loans list itself reads them.
    const overdueLoansQuery = db('loans')
      .leftJoin('users as borrower', 'loans.borrower_user_id', 'borrower.id')
      .whereIn('loans.status', ['active', 'partial'])
      .whereNotNull('loans.due_date')
      .whereRaw('loans.due_date < CURRENT_DATE')
      .select(
        'loans.id', 'loans.borrower_name', 'loans.due_date', 'loans.amount', 'loans.paid_amount',
        'borrower.full_name as borrower_full_name',
        db.raw('(loans.amount - loans.paid_amount) as remaining'),
        db.raw('(CURRENT_DATE - loans.due_date) as days_overdue')
      )
      .orderBy('loans.due_date', 'asc')
      .limit(5);
    if (scope.store_id || Array.isArray(scope.store_ids)) {
      overdueLoansQuery.where(function () {
        applyStoreScope(this, 'loans.store_id', scope);
        this.orWhereNull('loans.store_id');
      });
    }
    const overdueLoans = await overdueLoansQuery;

    // Recurring expenses whose next date has arrived. They deliberately do NOT post
    // themselves — booking rent without a person deciding it went out is worse than a
    // reminder — so this is how anyone finds out one is waiting.
    const dueRecurring = await applyStore(
      db('expense_recurring as r')
        .leftJoin('expense_categories as c', 'c.id', 'r.category_id')
        .where('r.is_active', true)
        .whereRaw('r.next_date <= CURRENT_DATE')
        .select('r.id', 'r.description', 'r.amount', 'r.next_date', 'r.frequency',
          'c.name as category_name', 'c.name_ar as category_name_ar')
        .orderBy('r.next_date', 'asc')
        .limit(5),
      'r.store_id'
    );

    return {
      pending_transfers: pendingTransfers,
      unpaid_invoices: unpaidInvoices.map(i => ({
        ...i, total_amount: parseFloat(i.total_amount), paid_amount: parseFloat(i.paid_amount),
        balance: parseFloat(i.total_amount) - parseFloat(i.paid_amount),
      })),
      low_stock_count: parseInt(lowStockCountRow?.count, 10) || 0,
      overdue_loans: overdueLoans.map(l => ({
        ...l,
        amount: parseFloat(l.amount),
        paid_amount: parseFloat(l.paid_amount),
        remaining: parseFloat(l.remaining),
      })),
      due_recurring: dueRecurring.map(r => ({ ...r, amount: parseFloat(r.amount) })),
      recent_sales: recentSales.map(s => ({ ...s, final_amount: parseFloat(s.final_amount) })),
      recent_activity: recentActivity,
    };
  }

  async getDashboardStats(filters = {}) {
    const { store_id, store_ids, limit = 5 } = filters;
    const lmt = Math.min(50, Math.max(1, parseInt(limit, 10) || 5));
    const scope = { store_id, store_ids };
    // Bound the window when the caller gives none — otherwise every dashboard load
    // scans the entire sales history.
    const range = defaultRange(filters);

    const applyDateFilter = (query, dateColumn = 'created_at') =>
      applyDateRange(query, dateColumn, range);

    const applyStoreFilter = (query, storeColumn = 'store_id') =>
      applyStoreScope(query, storeColumn, scope);

    const applyBoth = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      applyDateFilter(query, dateCol);
      if (storeCol) applyStoreFilter(query, storeCol);
      return query;
    };

    // Every query below is independent, so they are built first and awaited together
    // at the end. Previously these ran as 13 sequential round-trips.

    // 1. Basic Counts & Totals (Filtered)
    const inventoryQuery = db('inventory_items').where('status', 'in_stock').count('id as count');
    applyStoreFilter(inventoryQuery, 'store_id');

    const salesQuery = db('sales').whereNull('sales.voided_at').count('id as count').sum('total_amount as subtotal').sum('final_amount as total').sum('refunded_amount as refunded');
    applyBoth(salesQuery, 'created_at', 'store_id');

    // 2. Profit & Items Sold (Filtered)
    const profitQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .select(
        db.raw('COUNT(sale_items.id) as items_sold'),
        db.raw('SUM(CASE WHEN customer_return_items.id IS NOT NULL THEN 1 ELSE 0 END) as items_returned')
      );
    applyBoth(profitQuery, 'sales.created_at', 'sales.store_id');

    const actualProfitQuery = applyBoth(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select(
          db.raw(`SUM(${ITEM_PROFIT}) as profit`)
        ),
      'sales.created_at', 'sales.store_id'
    );

    // 3. Expenses (Filtered)
    const expensesQuery = db('expenses').sum('amount as total');
    applyBoth(expensesQuery, 'expense_date', 'store_id');

    // 3b. Outstanding Loans (store-filtered)
    const loansQuery = db('loans').whereIn('status', ['active', 'partial'])
      .select(db.raw('COALESCE(SUM(amount - paid_amount), 0) as total'));
    applyStoreFilter(loansQuery, 'store_id');

    // 4. Supplier/Dealer Balances (Global typically) + Inventory Valuation
    const valQuery = db('inventory_items').where('status', 'in_stock').sum('cost as total');
    applyStoreFilter(valQuery, 'store_id');

    const pendingTransfersQuery = db('store_transfers').whereIn('status', ['pending', 'shipped']).count('id as count');
    applyStoreFilter(pendingTransfersQuery, 'from_store_id'); // Optional interpretation

    // 5. Sales Trend (Line Chart grouping by Date)
    const trendQuery = db('sales').whereNull('sales.voided_at')
      .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
      .sum('final_amount as revenue')
      .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
      .orderBy('date', 'asc');
    applyBoth(trendQuery, 'created_at', 'store_id');

    // 6. Profit Trend
    const profitTrendQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .whereNull('customer_return_items.id')
      .select(
        db.raw("TO_CHAR(sales.created_at, 'YYYY-MM-DD') as date"),
        db.raw(`SUM(${ITEM_PROFIT}) as profit`)
      )
      .groupByRaw("TO_CHAR(sales.created_at, 'YYYY-MM-DD')")
      .orderBy('date', 'asc');
    applyBoth(profitTrendQuery, 'sales.created_at', 'sales.store_id');

    // 7. Store Performance
    const storePerfQuery = applyStoreFilter(
      applyDateFilter(
        db('sales').whereNull('sales.voided_at')
          .join('stores', 'sales.store_id', 'stores.id')
          .select('stores.name')
          .sum('sales.final_amount as revenue')
          .groupBy('sales.store_id', 'stores.name'),
        'sales.created_at'
      ),
      'sales.store_id'
    );

    // 8. Payment Methods
    const paymentsQuery = db('sale_payments')
      .join('sales', 'sale_payments.sale_id', 'sales.id').whereNull('sales.voided_at')
      .select('sale_payments.payment_method as method')
      .sum('sale_payments.amount as total')
      .groupBy('sale_payments.payment_method');
    applyBoth(paymentsQuery, 'sales.created_at', 'sales.store_id');

    // 9. Top Products
    const topProdQuery = db('sale_items')
      .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .select('products.product_code as product', 'products.model_name as name')
      .count('sale_items.id as qty')
      .select(db.raw(`SUM(${ITEM_NET_REVENUE}) as revenue`))
      .whereNull('customer_return_items.id')
      .groupBy('products.id', 'products.product_code', 'products.model_name')
      .orderBy('qty', 'desc')
      .limit(lmt);
    applyBoth(topProdQuery, 'sales.created_at', 'sales.store_id');

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

    // --- Single round-trip for all of the above ---
    const [
      inventoryResult, salesResult, profitData, actualProfitData,
      expensesResult, loansResult, valResult, pendingTransfers,
      salesTrend, profitTrend, storePerf, paymentsPerf, topProducts, lowStock,
    ] = await Promise.all([
      inventoryQuery.first(),
      salesQuery.first(),
      profitQuery.first(),
      actualProfitQuery.first(),
      expensesQuery.first(),
      loansQuery.first(),
      valQuery.first(),
      pendingTransfersQuery.first(),
      trendQuery,
      profitTrendQuery,
      storePerfQuery,
      paymentsQuery,
      topProdQuery,
      lowStockQuery,
    ]);

    const trendMap = {};
    salesTrend.forEach(t => trendMap[t.date] = { date: t.date, revenue: parseFloat(t.revenue) || 0, profit: 0 });
    profitTrend.forEach(t => {
      if (!trendMap[t.date]) trendMap[t.date] = { date: t.date, revenue: 0, profit: 0 };
      trendMap[t.date].profit = parseFloat(t.profit) || 0;
    });
    const finalTrend = Object.values(trendMap).sort((a,b) => a.date.localeCompare(b.date));

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
        total_loans_outstanding: parseFloat(loansResult.total) || 0,
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
  // ============================================================
  // PERIOD COMPARISON
  // ============================================================

  /**
   * The same headline figures for this period and the one before it.
   *
   * A number on its own says almost nothing: "42,000 EGP" is good news or bad news
   * depending entirely on what last month was. This is the cheapest possible way to
   * answer that — six aggregates per window rather than a second full dashboard, so
   * the overview can show a direction beside every card without doubling its cost.
   *
   * The previous window is the same LENGTH immediately before the current one, not
   * "last calendar month": comparing a 12-day month-to-date against a full 31-day
   * month is the single most common way a dashboard lies to somebody.
   *
   * All Time has nothing before it, so it reports `comparable: false` rather than
   * inventing a baseline of zero and calling everything a 100% rise.
   */
  async getPeriodComparison(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);

    if (!range.startDate || !range.endDate) {
      return { comparable: false, current: null, previous: null };
    }

    // Inclusive day count, so a single-day range compares against the day before.
    const days = Math.max(
      1,
      Math.round(
        (new Date(`${range.endDate}T00:00:00Z`) - new Date(`${range.startDate}T00:00:00Z`)) / 86400000
      ) + 1
    );
    const previous = {
      startDate: addDays(range.startDate, -days),
      endDate: addDays(range.startDate, -1),
    };

    const windowMetrics = async (win) => {
      const salesQ = applyStoreScope(
        applyDateRange(
          db('sales').whereNull('voided_at').select(
            db.raw('COUNT(id)::int as orders'),
            db.raw('COALESCE(SUM(final_amount), 0) as revenue'),
            db.raw('COALESCE(SUM(refunded_amount), 0) as refunded'),
            db.raw('COALESCE(SUM(discount_amount), 0) as discounts'),
            db.raw('COUNT(DISTINCT customer_id)::int as customers')
          ),
          'created_at', win
        ),
        'store_id', scope
      ).first();

      const profitQ = applyStoreScope(
        applyDateRange(
          db('sale_items')
            .join('sales', 'sale_items.sale_id', 'sales.id')
            .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
            .whereNull('sales.voided_at')
            .whereNull('customer_return_items.id')
            .select(
              db.raw('COUNT(sale_items.id)::int as items_sold'),
              db.raw(`COALESCE(SUM(${ITEM_PROFIT}), 0) as gross_profit`)
            ),
          'sales.created_at', win
        ),
        'sales.store_id', scope
      ).first();

      const expensesQ = applyStoreScope(
        applyDateRange(
          db('expenses').select(db.raw('COALESCE(SUM(amount), 0) as expenses')),
          'expense_date', win
        ),
        'store_id', scope
      ).first();

      const [sales, profit, expenses] = await Promise.all([salesQ, profitQ, expensesQ]);
      const gross = parseFloat(sales.revenue) || 0;
      const refunded = parseFloat(sales.refunded) || 0;
      // `revenue` here means what the dashboard's headline means: takings less
      // refunds. Two screens using one word for two numbers is how a reader stops
      // trusting both.
      const revenue = Math.round((gross - refunded) * 100) / 100;
      const grossProfit = parseFloat(profit.gross_profit) || 0;
      const spend = parseFloat(expenses.expenses) || 0;
      return {
        range: win,
        orders: sales.orders,
        gross_revenue: Math.round(gross * 100) / 100,
        refunded: Math.round(refunded * 100) / 100,
        revenue,
        discounts: Math.round((parseFloat(sales.discounts) || 0) * 100) / 100,
        customers: sales.customers,
        items_sold: profit.items_sold,
        gross_profit: Math.round(grossProfit * 100) / 100,
        expenses: Math.round(spend * 100) / 100,
        net: Math.round((grossProfit - spend) * 100) / 100,
        aov: sales.orders ? Math.round((revenue / sales.orders) * 100) / 100 : 0,
      };
    };


    const [current, prior] = await Promise.all([windowMetrics(range), windowMetrics(previous)]);

    // Percentage change, with the one case that has no honest answer left as null:
    // growth from zero is not "infinite" or "100%", it is "there was nothing before".
    const change = {};
    for (const key of ['orders', 'revenue', 'customers', 'items_sold', 'gross_profit', 'expenses', 'net', 'aov']) {
      const before = prior[key];
      const now = current[key];
      change[key] = before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null;
    }

    return { comparable: true, current, previous: prior, change };
  }

  async getSalesAnalytics(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);

    const applyFilters = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      applyDateRange(query, dateCol, range);
      if (storeCol) applyStoreScope(query, storeCol, scope);
      return query;
    };

    // Daily sales trend
    const dailySales = await applyFilters(
      db('sales').whereNull('sales.voided_at')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
        .orderBy('date', 'asc')
    );

    // Hourly distribution
    const hourly = await applyFilters(
      db('sales').whereNull('sales.voided_at')
        .select(db.raw("EXTRACT(HOUR FROM created_at)::int as hour"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("EXTRACT(HOUR FROM created_at)")
        .orderBy('hour', 'asc')
    );

    // Day-of-week distribution
    const dayOfWeek = await applyFilters(
      db('sales').whereNull('sales.voided_at')
        .select(db.raw("EXTRACT(DOW FROM created_at)::int as dow"))
        .count('id as count')
        .sum('final_amount as revenue')
        .groupByRaw("EXTRACT(DOW FROM created_at)")
        .orderBy('dow', 'asc')
    );

    // Payment methods breakdown
    const paymentMethods = await applyFilters(
      db('sale_payments')
        .join('sales', 'sale_payments.sale_id', 'sales.id').whereNull('sales.voided_at')
        .select('sale_payments.payment_method as method')
        .count('sale_payments.id as count')
        .sum('sale_payments.amount as total')
        .groupBy('sale_payments.payment_method'),
      'sales.created_at', 'sales.store_id'
    );

    // Average order value trend
    const aovTrend = await applyFilters(
      db('sales').whereNull('sales.voided_at')
        .select(db.raw("TO_CHAR(created_at, 'YYYY-MM-DD') as date"))
        .avg('final_amount as aov')
        .groupByRaw("TO_CHAR(created_at, 'YYYY-MM-DD')")
        .orderBy('date', 'asc')
    );

    // Discount analysis
    const discountStats = await applyFilters(
      db('sales').whereNull('sales.voided_at')
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
    const { store_id, store_ids, limit = 20 } = filters;
    const lmt = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);
    const categoryId = asUuid(filters.category_id);

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      applyDateRange(query, dateCol, range);
      if (storeCol) applyStoreScope(query, storeCol, scope);
      // Every query in this tab joins products, so the category predicate belongs
      // here rather than being repeated four times and forgotten on the fifth.
      if (categoryId) query.where('products.category_id', categoryId);
      return query;
    };

    // Top selling products by quantity
    const topByQty = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.product_code', 'products.model_name', 'products.brand')
        .count('sale_items.id as qty_sold')
        // SUM must wrap the expression here, not be applied via .sum(raw) — knex
        // renders that as `sum(<expr> as alias)`, which Postgres rejects.
        .select(db.raw(`SUM(${ITEM_NET_REVENUE}) as revenue`))
        .select(db.raw(`SUM(${ITEM_PROFIT}) as profit`))
        .groupBy('products.id', 'products.product_code', 'products.model_name', 'products.brand')
        .orderBy('qty_sold', 'desc')
        .limit(lmt)
    );

    // Top selling by revenue
    const topByRevenue = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.product_code', 'products.model_name', 'products.brand')
        .count('sale_items.id as qty_sold')
        // SUM must wrap the expression here, not be applied via .sum(raw) — knex
        // renders that as `sum(<expr> as alias)`, which Postgres rejects.
        .select(db.raw(`SUM(${ITEM_NET_REVENUE}) as revenue`))
        .select(db.raw(`SUM(${ITEM_PROFIT}) as profit`))
        .groupBy('products.id', 'products.product_code', 'products.model_name', 'products.brand')
        .orderBy('revenue', 'desc')
        .limit(lmt)
    );

    // Size distribution.
    //
    // Grouped by the size list as well as the label, and carrying the list's prefix
    // and suffix so the chart can write "EU 42" and "95 cm". Two lists may both
    // contain 'M' — merging a sock M with a belt M gives a bucket that means nothing.
    const sizeDistribution = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
        .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('product_variants.size_eu as size')
        .select('sscale.display_prefix as size_prefix', 'sscale.display_suffix as size_suffix')
        .select('pcat.has_sizes')
        .min('product_variants.size_sort as size_sort')
        .count('sale_items.id as count')
        .groupBy('product_variants.size_eu', 'sscale.display_prefix', 'sscale.display_suffix', 'pcat.has_sizes')
        .orderBy('count', 'desc')
    );

    // Brand performance
    const brandPerformance = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select('products.brand')
        .count('sale_items.id as qty_sold')
        .select(db.raw(`SUM(${ITEM_NET_REVENUE}) as revenue`))
        .groupBy('products.brand')
        .orderBy('revenue', 'desc')
    );

    return {
      top_by_qty: topByQty.map(r => ({ code: r.product_code, name: r.model_name, brand: r.brand, qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0, profit: parseFloat(r.profit) || 0 })),
      top_by_revenue: topByRevenue.map(r => ({ code: r.product_code, name: r.model_name, brand: r.brand, qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0, profit: parseFloat(r.profit) || 0 })),
      // The prefix/suffix travel with the row: the chart formats them through the same
      // variantFormat helper every other screen uses, rather than a second copy here.
      size_distribution: sizeDistribution.map(r => ({
        size: r.size, count: parseInt(r.count),
        size_prefix: r.size_prefix, size_suffix: r.size_suffix,
        has_sizes: r.has_sizes, size_sort: r.size_sort == null ? null : Number(r.size_sort),
      })),
      brand_performance: brandPerformance.map(r => ({ brand: r.brand || 'Unknown', qty: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) || 0 })),
    };
  }

  // ============================================================
  // INVENTORY ANALYTICS
  // ============================================================
  async getInventoryAnalytics(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const categoryId = asUuid(filters.category_id);

    const applyStore = (query, col = 'inventory_items.store_id') =>
      applyStoreScope(query, col, scope);

    /**
     * Restrict a query to one product category.
     *
     * Half the queries in this tab do not touch products at all, so the join is added
     * only when a category is actually chosen — an unfiltered report costs exactly
     * what it did before. Every query gets the predicate: a report filtered to Socks
     * whose aging chart still counted shoes would be worse than no filter at all.
     *
     * inventory_items -> variant -> product is many-to-one both ways, so the extra
     * joins cannot duplicate a row and inflate a COUNT.
     */
    const applyCategory = (query, { joined = false } = {}) => {
      if (!categoryId) return query;
      if (joined) return query.where('products.category_id', categoryId);
      return query
        .join('product_variants as cat_pv', 'inventory_items.variant_id', 'cat_pv.id')
        .join('products as cat_p', 'cat_pv.product_id', 'cat_p.id')
        .where('cat_p.category_id', categoryId);
    };

    // Stock by store — also scoped, so a store-limited user does not see a
    // per-store breakdown of the whole company.
    const stockByStore = await applyCategory(applyStore(
      db('inventory_items')
        .join('stores', 'inventory_items.store_id', 'stores.id')
        .where('inventory_items.status', 'in_stock')
        .select('stores.name')
        .count('inventory_items.id as count')
        .sum('inventory_items.cost as value')
        .groupBy('stores.id', 'stores.name')
        .orderBy('count', 'desc')
    ));

    // Stock by brand
    const stockByBrand = await applyCategory(applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .where('inventory_items.status', 'in_stock')
        .select('products.brand')
        .count('inventory_items.id as count')
        .groupBy('products.brand')
        .orderBy('count', 'desc')
    ), { joined: true });

    // Stock by size.
    //
    // Grouped by the size list as well as the label, and ordered by the numeric key so
    // '10' does not land before '9' and words come back in their list's own order.
    // Without the list in the group key a sock M and a belt M merge into one bucket.
    const stockBySize = await applyCategory(applyStore(
      db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
        .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
        .where('inventory_items.status', 'in_stock')
        .select('product_variants.size_eu as size')
        .select('sscale.display_prefix as size_prefix', 'sscale.display_suffix as size_suffix')
        .select('pcat.has_sizes')
        .min('product_variants.size_sort as size_sort')
        .count('inventory_items.id as count')
        .groupBy('product_variants.size_eu', 'sscale.display_prefix', 'sscale.display_suffix', 'pcat.has_sizes')
        .orderBy('size_sort', 'asc')
    ), { joined: true });

    // Stock aging (days since purchase)
    // created_at is qualified: products and product_variants both carry one, so the
    // bare column becomes ambiguous the moment a category filter adds those joins.
    const aging = await applyCategory(applyStore(
      db('inventory_items')
        .where('inventory_items.status', 'in_stock')
        .select(
          db.raw("SUM(CASE WHEN inventory_items.created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::int as within_30"),
          db.raw("SUM(CASE WHEN inventory_items.created_at >= NOW() - INTERVAL '60 days' AND inventory_items.created_at < NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::int as d30_60"),
          db.raw("SUM(CASE WHEN inventory_items.created_at >= NOW() - INTERVAL '90 days' AND inventory_items.created_at < NOW() - INTERVAL '60 days' THEN 1 ELSE 0 END)::int as d60_90"),
          db.raw("SUM(CASE WHEN inventory_items.created_at < NOW() - INTERVAL '90 days' THEN 1 ELSE 0 END)::int as over_90")
        )
    )).first();

    // Low stock products (< 5 items)
    const lowStock = await applyCategory(applyStore(
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
    ), { joined: true });

    // Status distribution
    const statusDist = await applyCategory(applyStore(
      db('inventory_items')
        // Qualified for the same reason as the aging query above.
        .select('inventory_items.status')
        .count('inventory_items.id as count')
        .groupBy('inventory_items.status')
    ));

    return {
      stock_by_store: stockByStore.map(r => ({ name: r.name, count: parseInt(r.count), value: parseFloat(r.value) || 0 })),
      stock_by_brand: stockByBrand.map(r => ({ brand: r.brand || 'Unknown', count: parseInt(r.count) })),
      stock_by_size: stockBySize.map(r => ({
        size: r.size, count: parseInt(r.count),
        size_prefix: r.size_prefix, size_suffix: r.size_suffix,
        has_sizes: r.has_sizes, size_sort: r.size_sort == null ? null : Number(r.size_sort),
      })),
      aging: { within_30: aging.within_30 || 0, d30_60: aging.d30_60 || 0, d60_90: aging.d60_90 || 0, over_90: aging.over_90 || 0 },
      low_stock: lowStock.map(r => ({ code: r.product_code, name: r.model_name, stock: parseInt(r.stock) })),
      status_distribution: statusDist.map(r => ({ status: r.status, count: parseInt(r.count) })),
    };
  }

  // ============================================================
  // FINANCIAL REPORT
  // ============================================================
  async getFinancialReport(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);

    const applyFilters = (query, dateCol = 'created_at', storeCol = 'store_id') => {
      applyDateRange(query, dateCol, range);
      if (storeCol) applyStoreScope(query, storeCol, scope);
      return query;
    };

    // Revenue
    const revenue = await applyFilters(
      db('sales').whereNull('sales.voided_at').select(
        db.raw('SUM(final_amount) as total_revenue'),
        db.raw('SUM(refunded_amount) as total_refunded'),
        db.raw('SUM(discount_amount) as total_discount')
      )
    ).first();

    // COGS (cost of goods sold)
    const cogs = await applyFilters(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id').whereNull('sales.voided_at')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('customer_return_items.id')
        .select(db.raw('SUM(sale_items.cost_at_sale) as total_cogs')),
      'sales.created_at', 'sales.store_id'
    ).first();

    // Expenses by category. leftJoin + COALESCE: category_id is nullable, and the old
    // inner join dropped uncategorised expenses — which then vanished from net profit too.
    // Sub-categories roll up under their parent: a shop that files Electricity and
    // Water under Utilities wants to read "Utilities", with the split available under
    // it — not two unrelated lines that never add up to the heading anyone expects.
    const expensesByCategory = await applyFilters(
      db('expenses')
        .leftJoin('expense_categories as c', 'expenses.category_id', 'c.id')
        .leftJoin('expense_categories as p', 'p.id', 'c.parent_id')
        .select(
          db.raw("COALESCE(p.name, c.name, 'Uncategorised') as category"),
          db.raw("COALESCE(p.name_ar, c.name_ar) as category_ar")
        )
        .sum('expenses.amount as total')
        .groupByRaw("COALESCE(p.name, c.name, 'Uncategorised'), COALESCE(p.name_ar, c.name_ar)")
        .orderBy('total', 'desc'),
      'expenses.expense_date', 'expenses.store_id'
    );

    // Expenses month by month, over the same window as the P&L trend, so the two
    // charts can be read against each other.
    const expenseTrend = await applyFilters(
      db('expenses')
        .select(db.raw("TO_CHAR(expense_date, 'YYYY-MM') as month"))
        .sum('amount as total')
        .groupByRaw("TO_CHAR(expense_date, 'YYYY-MM')")
        .orderByRaw("TO_CHAR(expense_date, 'YYYY-MM')"),
      'expenses.expense_date', 'expenses.store_id'
    );

    // Authoritative expense total, independent of the category breakdown.
    const expensesTotalRow = await applyFilters(
      db('expenses').select(db.raw('COALESCE(SUM(amount), 0) as total')),
      'expenses.expense_date', 'expenses.store_id'
    ).first();

    // Monthly P&L trend
    const monthlyPL = await applyFilters(
      db('sales').whereNull('sales.voided_at')
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

    // Supplier balances — uses the shared formula so this agrees with the suppliers
    // page. The old query here was `SUM(total_amount) - SUM(paid_amount)`, which ignored
    // discounts, returns and withdrawals and so reported different debt.
    const supplierBalances = await suppliersWithOutstandingBalance(db, 10);

    const totalRevenue = parseFloat(revenue.total_revenue) || 0;
    const totalRefunded = parseFloat(revenue.total_refunded) || 0;
    const totalCogs = parseFloat(cogs.total_cogs) || 0;
    const totalExpenses = parseFloat(expensesTotalRow?.total) || 0;

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
        // What share of what came in went straight back out. null rather than 0 when
        // there was no revenue: a percentage of nothing is not a number to show anyone.
        expense_ratio_pct: totalRevenue - totalRefunded > 0
          ? Math.round((totalExpenses / (totalRevenue - totalRefunded)) * 1000) / 10
          : null,
      },
      expenses_by_category: expensesByCategory.map(r => ({
        category: r.category, category_ar: r.category_ar, total: parseFloat(r.total) || 0,
      })),
      expense_trend: expenseTrend.map(r => ({ month: r.month, total: parseFloat(r.total) || 0 })),
      pl_trend: plTrend,
      supplier_balances: supplierBalances.map(r => ({
        name: r.name,
        invoiced: parseFloat(r.total_invoiced) || 0,
        paid: parseFloat(r.total_paid) || 0,
        balance: parseFloat(r.balance) || 0,
      })),
    };
  }

  // ============================================================
  // CUSTOMER ANALYTICS
  // ============================================================
  async getCustomerAnalytics(filters = {}) {
    const { store_id, store_ids, limit = 20 } = filters;
    const lmt = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      applyDateRange(query, dateCol, range);
      if (storeCol) applyStoreScope(query, storeCol, scope);
      return query;
    };

    // Top customers by spending
    const topCustomers = await applyFilters(
      db('sales').whereNull('sales.voided_at')
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
      db('sales').whereNull('sales.voided_at')
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
        .join('sales', 'customer_returns.sale_id', 'sales.id').whereNull('sales.voided_at')
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
      db('sales').whereNull('sales.voided_at')
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
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const range = defaultRange(filters);

    const applyFilters = (query, dateCol = 'sales.created_at', storeCol = 'sales.store_id') => {
      applyDateRange(query, dateCol, range);
      if (storeCol) applyStoreScope(query, storeCol, scope);
      return query;
    };

    // Sales by employee
    const salesByEmployee = await applyFilters(
      db('sales').whereNull('sales.voided_at')
        .join('users', 'sales.created_by', 'users.id')
        .select('users.full_name')
        .count('sales.id as sales_count')
        .sum('sales.final_amount as revenue')
        .groupBy('users.id', 'users.full_name')
        .orderBy('revenue', 'desc')
    );

    // Employee daily trend
    const empTrend = await applyFilters(
      db('sales').whereNull('sales.voided_at')
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

  /**
   * The findings a person would reach if they read every other report carefully.
   *
   * A dashboard shows numbers. This says what they MEAN, in a sentence, ranked by how
   * much money is attached — because the thing an owner actually needs is not "revenue
   * 48,300" but "you are out of the shoe that sells nine a week".
   *
   * Composed from the reports that already exist rather than new SQL: an insight that
   * disagreed with the tab it came from would be worse than no insight.
   *
   * Every finding carries a `severity` and, where there is one, a `value` in EGP, so
   * the caller can rank and colour without parsing English.
   */
  async getInsights(filters = {}) {
    const range = defaultRange(filters);
    const scope = { store_id: filters.store_id, store_ids: filters.store_ids };

    const [comparison, reorder, basis, financial, dash] = await Promise.all([
      this.getPeriodComparison(filters).catch(() => null),
      this.getReorderSignals(filters).catch(() => null),
      this.getCostBasis({ ...filters, startDate: range.startDate, endDate: range.endDate }).catch(() => null),
      this.getFinancialReport(filters).catch(() => null),
      this.getDashboardStats(filters).catch(() => null),
    ]);

    const out = [];
    const add = (severity, key, title, detail, value = null, extra = {}) =>
      out.push({ severity, key, title, detail, value, ...extra });

    // ---- what is about to run out -------------------------------------------
    if (reorder) {
      const outOf = reorder.buy.filter((r) => r.status === 'out');
      if (outOf.length) {
        const worst = outOf[0];
        add('critical', 'out_of_stock',
          `${outOf.length} product(s) are out of stock and still selling`,
          `${worst.product_name} sold ${worst.weekly_rate}/week and there are none left.`,
          null, { count: outOf.length, products: outOf.slice(0, 5) });
      }
      const soon = reorder.buy.filter((r) => r.status === 'critical' && r.on_hand > 0);
      if (soon.length) {
        add('warning', 'running_out',
          `${soon.length} product(s) run out within a week`,
          `${soon[0].product_name} has ${soon[0].on_hand} left, about ${soon[0].days_cover} days.`,
          null, { count: soon.length, products: soon.slice(0, 5) });
      }
      if (reorder.summary.dead_value > 0) {
        add('warning', 'dead_stock',
          `${reorder.summary.dead_value.toLocaleString()} EGP is sitting in stock that is not selling`,
          `${reorder.summary.dead} product(s) have not sold in ${reorder.dead_after_days} days.`,
          reorder.summary.dead_value, { count: reorder.summary.dead, products: reorder.dead.slice(0, 5) });
      }
      if (reorder.summary.suggested_units > 0) {
        add('info', 'reorder',
          `About ${reorder.summary.suggested_units} unit(s) are worth reordering`,
          `Roughly ${reorder.summary.suggested_cost.toLocaleString()} EGP at your last known costs.`,
          reorder.summary.suggested_cost);
      }
    }

    // ---- is the shop growing -------------------------------------------------
    if (comparison?.comparable) {
      const rev = comparison.current?.net_sales ?? comparison.current?.revenue;
      const prev = comparison.previous?.net_sales ?? comparison.previous?.revenue;
      if (prev > 0 && rev != null) {
        const pct = Math.round(((rev - prev) / prev) * 1000) / 10;
        if (Math.abs(pct) >= 5) {
          add(pct < 0 ? 'warning' : 'good', 'revenue_trend',
            `Takings are ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the period before`,
            `${Math.round(rev).toLocaleString()} EGP against ${Math.round(prev).toLocaleString()}.`,
            Math.round(rev - prev));
        }
      }
    }

    // ---- is it profitable ----------------------------------------------------
    if (financial?.summary) {
      const s = financial.summary;
      if (s.net_revenue > 0) {
        const margin = Math.round((s.gross_profit / s.net_revenue) * 1000) / 10;
        if (margin < 15) {
          add('critical', 'thin_margin',
            `Gross margin is ${margin}%`,
            'Cost of goods is eating most of what comes in — check your buying prices and discounts.',
            s.gross_profit);
        }
        if (s.expense_ratio_pct != null && s.expense_ratio_pct > 40) {
          add('warning', 'expense_ratio',
            `Expenses are ${s.expense_ratio_pct}% of takings`,
            `${Math.round(s.total_expenses).toLocaleString()} EGP against ${Math.round(s.net_revenue).toLocaleString()} in.`,
            s.total_expenses);
        }
        if (s.net_profit < 0) {
          add('critical', 'loss',
            'This period made a loss',
            `${Math.round(Math.abs(s.net_profit)).toLocaleString()} EGP more went out than came in.`,
            s.net_profit);
        }
      }
      if (s.total_discount > 0 && s.net_revenue > 0) {
        const dpct = Math.round((s.total_discount / (s.net_revenue + s.total_discount)) * 1000) / 10;
        if (dpct >= 10) {
          add('warning', 'discounts',
            `${dpct}% of the price list was given away in discounts`,
            `${Math.round(s.total_discount).toLocaleString()} EGP.`,
            s.total_discount);
        }
      }
    }

    // ---- can the numbers be trusted -----------------------------------------
    if (basis?.estimated_items > 0) {
      add('info', 'estimated_costs',
        `${basis.estimated_share_pct}% of what sold rests on an estimated cost`,
        'Profit for this period is provisional until those products are bought on a real invoice.',
        basis.estimated_cost);
    }
    if (basis?.restated_items > 0 && basis.restated_at) {
      add('info', 'restated',
        'This period has been restated since it was first reported',
        `${basis.restated_items} item(s) were re-costed on ${String(basis.restated_at).slice(0, 10)}.`,
        basis.restated_cost_delta);
    }

    // ---- the till ------------------------------------------------------------
    const drawer = await this._drawerInsights(range, scope).catch(() => null);
    if (drawer) out.push(...drawer);

    // ---- money owed ----------------------------------------------------------
    if (dash?.customer_credit_outstanding > 0) {
      add('info', 'customer_credit',
        `${Math.round(dash.customer_credit_outstanding).toLocaleString()} EGP is owed by customers`,
        'Sales taken on account that have not been settled.',
        dash.customer_credit_outstanding);
    }

    const rank = { critical: 0, warning: 1, good: 2, info: 3 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity]
      || Math.abs(b.value || 0) - Math.abs(a.value || 0));

    return { range, insights: out };
  }

  /** Shift differences and cash that belongs to no count. Split out to keep the above readable. */
  async _drawerInsights(range, scope) {
    const out = [];

    const shiftQ = db('shifts')
      .where('status', 'closed')
      .whereNotNull('difference');
    applyStoreScope(shiftQ, 'shifts.store_id', scope);
    applyDateRange(shiftQ, 'shifts.opened_at', range);

    const [diff, unassigned] = await Promise.all([
      shiftQ.clone()
        .select(
          db.raw('COALESCE(SUM(difference), 0) as net'),
          db.raw('COALESCE(SUM(CASE WHEN difference < 0 THEN -difference ELSE 0 END), 0) as short'),
          db.raw('COUNT(*) FILTER (WHERE ABS(difference) > 0.01) as off_count'),
          db.raw('COUNT(*) as shifts')
        )
        .first(),
      (async () => {
        const q = db('sale_payments')
          .join('sales', 'sales.id', 'sale_payments.sale_id');
        // Cash with no cash-up, but ONLY since the branch started running cash-ups —
        // shared with the till strip so both mean the same thing. Before that, a sale
        // with no shift is pre-feature history, not loose cash, and counting it once
        // flagged 12,487 EGP when only 4,812 was genuinely unreconciled.
        applyUnassignedCash(q);
        applyStoreScope(q, 'sales.store_id', scope);
        applyDateRange(q, 'sales.created_at', range);
        return q.sum('sale_payments.amount as total').count('sale_payments.id as n').first();
      })(),
    ]);

    const short = Math.round((Number(diff?.short) || 0) * 100) / 100;
    const offCount = Number(diff?.off_count) || 0;
    if (short > 0) {
      out.push({
        severity: short > 500 ? 'critical' : 'warning',
        key: 'cash_short',
        title: `The till came up short by ${short.toLocaleString()} EGP`,
        detail: `Across ${offCount} shift(s) that did not balance.`,
        value: -short,
      });
    }

    const loose = Math.round((Number(unassigned?.total) || 0) * 100) / 100;
    if (loose > 0) {
      out.push({
        severity: 'warning',
        key: 'unassigned_cash',
        title: `${loose.toLocaleString()} EGP of cash was taken with no cash-up open`,
        detail: `Across ${Number(unassigned?.n) || 0} payment(s) since this branch started doing cash-ups. `
          + 'That money belongs to no count, so nothing reconciles it — open the till before selling.',
        value: loose,
      });
    }

    return out;
  }

  /**
   * WHAT TO BUY, and what to stop buying.
   *
   * "Low stock" as a bare number is close to useless: three pairs of a shoe that sells
   * eight a week is an emergency, and three of one that sells one a month is fine. The
   * only figure that means anything is DAYS OF COVER — how long the shelf lasts at the
   * rate this thing actually leaves.
   *
   *     rate      = units sold in the window / days in the window
   *     cover     = on hand / rate
   *     suggested = enough to reach `target_days`, rounded up, minus what is on hand
   *
   * A product with no sales at all in the window has no rate, so cover is infinite
   * rather than zero — it is not urgent, it is DEAD, and it appears in the other half
   * of this answer where it belongs. Reporting it as "0 days of cover" would put the
   * shop's worst stock at the top of its shopping list.
   *
   * `products.reorder_point` overrides the computed floor when a shop knows better —
   * a line they always keep ten of regardless of what the maths says.
   */
  async getReorderSignals(filters = {}) {
    const { store_id, store_ids } = filters;
    const scope = { store_id, store_ids };
    const windowDays = Math.min(365, Math.max(7, parseInt(filters.window_days, 10) || 30));
    const targetDays = Math.min(365, Math.max(7, parseInt(filters.target_days, 10) || 30));
    const deadAfter = Math.min(730, Math.max(30, parseInt(filters.dead_after_days, 10) || 90));
    const since = addDays(businessDayStart(), -windowDays);

    // Sold per product in the window. One grouped query, not one per product.
    const soldQ = db('sale_items')
      .join('sales', 'sales.id', 'sale_items.sale_id')
      .join('inventory_items as ii', 'ii.id', 'sale_items.inventory_item_id')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .leftJoin('customer_return_items as cri', 'cri.sale_item_id', 'sale_items.id')
      .whereNull('sales.voided_at')
      // A returned pair did not really sell, and counting it inflates the rate — which
      // is how a shop ends up re-ordering the thing everyone brings back.
      .whereNull('cri.id')
      .where('sales.created_at', '>=', since)
      .groupBy('pv.product_id')
      .select('pv.product_id')
      .count('sale_items.id as units');
    applyStoreScope(soldQ, 'sales.store_id', scope);

    // On hand per product, and when it last sold at all.
    const stockQ = db('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .where('ii.status', 'in_stock')
      .groupBy('pv.product_id')
      .select('pv.product_id')
      .count('ii.id as on_hand')
      .sum('ii.cost as stock_value');
    applyStoreScope(stockQ, 'ii.store_id', scope);

    const lastSoldQ = db('sales')
      .join('sale_items', 'sale_items.sale_id', 'sales.id')
      .join('inventory_items as ii', 'ii.id', 'sale_items.inventory_item_id')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .whereNull('sales.voided_at')
      .groupBy('pv.product_id')
      .select('pv.product_id')
      .max('sales.created_at as last_sold_at');
    applyStoreScope(lastSoldQ, 'sales.store_id', scope);

    const [sold, stock, lastSold, products] = await Promise.all([
      soldQ, stockQ, lastSoldQ,
      db('products as p')
        .leftJoin('product_categories as c', 'c.id', 'p.category_id')
        .where('p.is_active', true)
        .select('p.id', 'p.product_code', 'p.brand', 'p.model_name', 'p.reorder_point',
          'p.default_selling_price', 'p.net_price', 'c.name_en as category_name_en',
          'c.name_ar as category_name_ar'),
    ]);

    const soldBy = new Map(sold.map((r) => [r.product_id, Number(r.units)]));
    const stockBy = new Map(stock.map((r) => [r.product_id, r]));
    const lastBy = new Map(lastSold.map((r) => [r.product_id, r.last_sold_at]));

    const rows = products.map((p) => {
      const units = soldBy.get(p.id) || 0;
      const onHand = Number(stockBy.get(p.id)?.on_hand) || 0;
      const stockValue = Math.round((Number(stockBy.get(p.id)?.stock_value) || 0) * 100) / 100;
      const rate = units / windowDays;                 // units per day
      const weekly = Math.round(rate * 7 * 10) / 10;
      // No rate means no cover figure at all — null, not zero. See the note above.
      const cover = rate > 0 ? Math.round((onHand / rate) * 10) / 10 : null;

      const floor = p.reorder_point != null ? Number(p.reorder_point) : null;
      const target = Math.ceil(rate * targetDays);
      const suggested = Math.max(0, Math.max(target, floor ?? 0) - onHand);

      const lastSoldAt = lastBy.get(p.id) || null;
      const daysSinceSale = lastSoldAt
        ? Math.floor((Date.now() - new Date(lastSoldAt).getTime()) / 86400000)
        : null;

      let status;
      if (onHand === 0 && rate > 0) status = 'out';
      else if (floor !== null && onHand <= floor) status = 'critical';
      else if (cover !== null && cover <= 7) status = 'critical';
      else if (cover !== null && cover <= 14) status = 'low';
      else if (onHand > 0 && rate === 0 && (daysSinceSale === null || daysSinceSale >= deadAfter)) status = 'dead';
      else if (cover !== null && cover > 120) status = 'overstocked';
      else status = 'ok';

      return {
        product_id: p.id,
        product_code: p.product_code,
        brand: p.brand,
        product_name: p.model_name,
        category_name_en: p.category_name_en,
        category_name_ar: p.category_name_ar,
        on_hand: onHand,
        stock_value: stockValue,
        sold_in_window: units,
        weekly_rate: weekly,
        days_cover: cover,
        reorder_point: floor,
        suggested_qty: suggested,
        last_sold_at: lastSoldAt,
        days_since_sale: daysSinceSale,
        status,
      };
    });

    const order = { out: 0, critical: 1, low: 2, ok: 3, overstocked: 4, dead: 5 };
    const buy = rows
      .filter((r) => ['out', 'critical', 'low'].includes(r.status))
      .sort((a, b) => order[a.status] - order[b.status]
        || (a.days_cover ?? 999) - (b.days_cover ?? 999));

    const dead = rows
      .filter((r) => r.status === 'dead' && r.on_hand > 0)
      .sort((a, b) => b.stock_value - a.stock_value);

    const overstocked = rows
      .filter((r) => r.status === 'overstocked')
      .sort((a, b) => b.stock_value - a.stock_value);

    return {
      window_days: windowDays,
      target_days: targetDays,
      dead_after_days: deadAfter,
      buy,
      dead,
      overstocked,
      summary: {
        out: rows.filter((r) => r.status === 'out').length,
        critical: rows.filter((r) => r.status === 'critical').length,
        low: rows.filter((r) => r.status === 'low').length,
        dead: dead.length,
        dead_value: Math.round(dead.reduce((n, r) => n + r.stock_value, 0) * 100) / 100,
        overstocked: overstocked.length,
        overstocked_value: Math.round(overstocked.reduce((n, r) => n + r.stock_value, 0) * 100) / 100,
        suggested_units: buy.reduce((n, r) => n + r.suggested_qty, 0),
        suggested_cost: Math.round(
          buy.reduce((n, r) => n + r.suggested_qty * (Number(
            products.find((p) => p.id === r.product_id)?.net_price
          ) || 0), 0) * 100
        ) / 100,
      },
    };
  }

  /**
   * How much of a period's profit rests on a guessed cost, and whether it has since
   * been restated.
   *
   * Stock entered without an invoice carries an ESTIMATED cost until that product is
   * bought again on a real one (see utils/costCorrection.js). Until then the profit
   * reported for anything sold out of it is provisional — and because the till hands
   * out the oldest pair first, a shop's opening stock is exactly what sells first. So
   * for the first months after adoption, a large share of reported profit can be
   * resting on guesses with nothing on screen to say so.
   *
   * A separate endpoint rather than a field threaded through nine report payloads: it
   * is one small query, every profit-bearing screen wants the same answer, and adding
   * it to each report is how one gets missed.
   *
   * `restated_at` answers the other half — a number the owner already read may have
   * MOVED since, because a real invoice arrived and corrected the guess behind it.
   */
  async getCostBasis({ startDate, endDate, store_id, store_ids } = {}) {
    const range = { startDate, endDate };

    // Sold on a live sale in this period, still resting on a guess.
    const estQ = db('sale_items')
      .join('sales', 'sales.id', 'sale_items.sale_id')
      .where('sale_items.cost_is_estimated', true)
      .whereNull('sales.voided_at');
    applyStoreScope(estQ, 'sales.store_id', { store_id, store_ids });
    applyDateRange(estQ, 'sales.created_at', range);

    // Everything sold in the period, so the share can be expressed as a proportion —
    // "43 pairs" means nothing without knowing whether the period held 50 or 5000.
    const allQ = db('sale_items')
      .join('sales', 'sales.id', 'sale_items.sale_id')
      .whereNull('sales.voided_at');
    applyStoreScope(allQ, 'sales.store_id', { store_id, store_ids });
    applyDateRange(allQ, 'sales.created_at', range);

    // Corrections that landed on a sale INSIDE this period. sale_date is denormalised
    // onto the log precisely so this needs no join back through sale_items.
    const restQ = db('cost_corrections')
      .whereNull('reverted_at')
      .whereNotNull('sale_item_id');
    if (startDate) restQ.where('sale_date', '>=', String(startDate).slice(0, 10));
    if (endDate) restQ.where('sale_date', '<=', String(endDate).slice(0, 10));

    const [estimated, all, restated] = await Promise.all([
      estQ.clone().count('sale_items.id as items').sum('sale_items.cost_at_sale as cost').first(),
      allQ.clone().count('sale_items.id as items').sum('sale_items.cost_at_sale as cost').first(),
      restQ.clone()
        .select(
          db.raw('COUNT(DISTINCT inventory_item_id) as items'),
          db.raw('MAX(applied_at) as last_applied_at'),
          db.raw('COALESCE(SUM(new_cost - old_cost), 0) as cost_delta')
        )
        .first(),
    ]);

    const estItems = Number(estimated?.items) || 0;
    const allItems = Number(all?.items) || 0;
    const estCost = Math.round((Number(estimated?.cost) || 0) * 100) / 100;
    const restatedItems = Number(restated?.items) || 0;

    return {
      // Still provisional.
      estimated_items: estItems,
      estimated_cost: estCost,
      total_items: allItems,
      // Null rather than 0 when nothing sold, so the UI shows nothing instead of "0%".
      estimated_share_pct: allItems > 0 ? Math.round((estItems / allItems) * 1000) / 10 : null,
      // Already corrected — this period's profit is not what it first read.
      restated_items: restatedItems,
      restated_at: restated?.last_applied_at || null,
      // Positive means costs went UP on correction, so the profit first reported for
      // this period was too high by this much.
      restated_cost_delta: Math.round((Number(restated?.cost_delta) || 0) * 100) / 100,
    };
  }
}

module.exports = new ReportsService();
