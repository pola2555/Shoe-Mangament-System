const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { applyStoreScope, resolveStoreScope } = require('../../utils/storeScope');
const { applyDateRange, defaultRange, businessDayStart, businessDayBoundary } = require('../../utils/dateRange');
const { ITEM_PROFIT } = require('../../utils/saleMath');
const { invalidateUserCache } = require('../../middleware/auth');

/**
 * Stores — the branch itself, what it holds, who works in it, and what it is worth.
 *
 * This module used to be four columns and an edit form. A store is the unit the whole
 * system is scoped by (see utils/storeScope.js), so everything else is filtered by one
 * and yet nothing could be said *about* one.
 *
 * Three rules shape what follows:
 *
 * 1. **Stats are grouped aggregates, never a query per store.** The suppliers and
 *    products lists each cost 2000 queries before that was fixed; this one is built
 *    the fixed way from the start — a handful of `GROUP BY store_id` queries awaited
 *    together and joined in JS.
 *
 * 2. **Names are not money.** `list()` returns every store because the transfer form
 *    needs somewhere to send stock to, but the *figures* attached to those stores go
 *    through applyStoreScope. A user who cannot see a branch's sales still needs to be
 *    able to send it a pair of shoes.
 *
 * 3. **A store is never deleted, and cannot be deactivated while it still holds
 *    stock.** Deactivating hides it from the till and the transfer form, so stock left
 *    inside would become unsellable and unmovable without any error saying so.
 */

/** Stock this low is worth flagging on the store card. */
const LOW_STOCK_THRESHOLD = 3;

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Index rows by store_id for joining aggregates back onto the store list. */
function byStore(rows, map) {
  const out = new Map();
  for (const row of rows) out.set(row.store_id, map(row));
  return out;
}

class StoresService {
  /**
   * Every store, optionally with a live picture of each.
   *
   * `include_stats` is opt-in: the store list is fetched by the POS, the transfer
   * form, the expenses filter and half a dozen other screens that want nothing but
   * names, and none of them should pay for eight aggregates.
   */
  async list({ is_active, include_stats } = {}, requestingUser = null) {
    const query = db('stores').orderBy([{ column: 'is_warehouse', order: 'asc' }, { column: 'created_at', order: 'asc' }]);
    if (is_active !== undefined) {
      query.where('is_active', is_active === 'false' ? false : !!is_active);
    }
    const stores = await query;
    if (!include_stats || stores.length === 0) return stores;

    const scope = requestingUser ? resolveStoreScope(requestingUser, {}) : {};
    const stats = await this._statsFor(stores.map((s) => s.id), scope);
    return stores.map((s) => ({ ...s, stats: stats.get(s.id) || null }));
  }

  async getById(id) {
    const store = await db('stores').where('id', id).first();
    if (!store) throw new AppError('Store not found', 404);
    return store;
  }

  /**
   * One row of headline figures per store, in six grouped queries rather than six
   * per store.
   *
   * Anything the caller may not see is simply absent from the map, so the store still
   * appears in the list with no figures rather than with somebody else's.
   */
  async _statsFor(storeIds, scope) {
    if (!storeIds.length) return new Map();

    const monthStart = `${businessDayStart().slice(0, 8)}01`;
    const monthBoundary = businessDayBoundary(monthStart);
    const todayBoundary = businessDayBoundary(businessDayStart());

    const scoped = (query, column) => {
      query.whereIn(column, storeIds);
      applyStoreScope(query, column, scope);
      return query;
    };

    const stockQ = scoped(
      db('inventory_items')
        .where('status', 'in_stock')
        .select('store_id')
        .count('id as units')
        .sum('cost as value')
        .groupBy('store_id'),
      'store_id'
    );

    // Month to date. `voided_at IS NULL` is the only test for whether a sale really
    // happened — see the note on sales.service.voidSale.
    const salesQ = scoped(
      db('sales')
        .whereNull('voided_at')
        .where('created_at', '>=', monthBoundary)
        .select('store_id')
        .count('id as sales_count')
        .sum('final_amount as revenue')
        .groupBy('store_id'),
      'store_id'
    );

    const todayQ = scoped(
      db('sales')
        .whereNull('voided_at')
        .where('created_at', '>=', todayBoundary)
        .select('store_id')
        .count('id as sales_count')
        .sum('final_amount as revenue')
        .groupBy('store_id'),
      'store_id'
    );

    const profitQ = scoped(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereNull('sales.voided_at')
        .whereNull('customer_return_items.id')
        .where('sales.created_at', '>=', monthBoundary)
        .select('sales.store_id')
        .select(db.raw(`SUM(${ITEM_PROFIT}) as profit`))
        .groupBy('sales.store_id'),
      'sales.store_id'
    );

    const expensesQ = scoped(
      db('expenses')
        .where('expense_date', '>=', monthStart)
        .select('store_id')
        .sum('amount as total')
        .groupBy('store_id'),
      'store_id'
    );

    // Staff: user_stores rows UNION the legacy users.store_id home store, which is
    // still how a single-store user is assigned. Counting only one of the two
    // undercounts every shop that has not been re-assigned since.
    const staffQ = db
      .from(
        db.raw(
          `(SELECT us.store_id, us.user_id FROM user_stores us
              JOIN users u ON u.id = us.user_id AND u.is_active = true
            UNION
            SELECT u.store_id, u.id FROM users u
             WHERE u.store_id IS NOT NULL AND u.is_active = true) staff`
        )
      )
      .whereIn('store_id', storeIds)
      .select('store_id')
      .countDistinct('user_id as staff_count')
      .groupBy('store_id');

    const transfersOutQ = db('store_transfers')
      .whereIn('status', ['pending', 'shipped'])
      .whereIn('from_store_id', storeIds)
      .select('from_store_id as store_id')
      .count('id as n')
      .groupBy('from_store_id');

    const transfersInQ = db('store_transfers')
      .whereIn('status', ['pending', 'shipped'])
      .whereIn('to_store_id', storeIds)
      .select('to_store_id as store_id')
      .count('id as n')
      .groupBy('to_store_id');

    // Sold on account and not yet settled. Voided sales owe nothing.
    const creditQ = scoped(
      db('sales')
        .whereNull('voided_at')
        .select('store_id')
        .select(db.raw(`SUM(GREATEST(sales.final_amount - COALESCE(
          (SELECT SUM(amount) FROM sale_payments sp WHERE sp.sale_id = sales.id), 0), 0)) as outstanding`))
        .groupBy('store_id'),
      'store_id'
    );

    const [stock, sales, todaySales, profit, expenses, staff, tOut, tIn, credit] = await Promise.all([
      stockQ, salesQ, todayQ, profitQ, expensesQ, staffQ, transfersOutQ, transfersInQ, creditQ,
    ]);

    const stockMap = byStore(stock, (r) => ({ units: Number(r.units), value: num(r.value) }));
    const salesMap = byStore(sales, (r) => ({ count: Number(r.sales_count), revenue: num(r.revenue) }));
    const todayMap = byStore(todaySales, (r) => ({ count: Number(r.sales_count), revenue: num(r.revenue) }));
    const profitMap = byStore(profit, (r) => num(r.profit));
    const expenseMap = byStore(expenses, (r) => num(r.total));
    const staffMap = byStore(staff, (r) => Number(r.staff_count));
    const outMap = byStore(tOut, (r) => Number(r.n));
    const inMap = byStore(tIn, (r) => Number(r.n));
    const creditMap = byStore(credit, (r) => num(r.outstanding));

    // Only stores the caller may actually see get figures. Anything else stays absent.
    const visible = new Set(
      scope.store_id ? [scope.store_id]
        : Array.isArray(scope.store_ids) ? scope.store_ids
          : storeIds
    );

    const out = new Map();
    for (const id of storeIds) {
      if (!visible.has(id)) continue;
      const monthRevenue = salesMap.get(id)?.revenue || 0;
      const monthProfit = profitMap.get(id) || 0;
      const monthExpenses = expenseMap.get(id) || 0;
      out.set(id, {
        stock_units: stockMap.get(id)?.units || 0,
        stock_value: Math.round((stockMap.get(id)?.value || 0) * 100) / 100,
        sales_today: todayMap.get(id)?.count || 0,
        revenue_today: Math.round((todayMap.get(id)?.revenue || 0) * 100) / 100,
        sales_month: salesMap.get(id)?.count || 0,
        revenue_month: Math.round(monthRevenue * 100) / 100,
        profit_month: Math.round(monthProfit * 100) / 100,
        expenses_month: Math.round(monthExpenses * 100) / 100,
        net_month: Math.round((monthProfit - monthExpenses) * 100) / 100,
        staff_count: staffMap.get(id) || 0,
        transfers_out: outMap.get(id) || 0,
        transfers_in: inMap.get(id) || 0,
        customer_credit: Math.round((creditMap.get(id) || 0) * 100) / 100,
      });
    }
    return out;
  }

  async create(data) {
    const safeData = { id: generateUUID() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.is_warehouse !== undefined) safeData.is_warehouse = data.is_warehouse;
    const [store] = await db('stores').insert(safeData).returning('*');
    return store;
  }

  /**
   * Update a store, refusing the two changes that would strand stock.
   *
   * Deactivating hides a store from the till, the transfer form and every picker.
   * Doing that while pairs are still sitting on its shelves makes them unsellable and
   * unmovable, with nothing on screen to say why — so it is refused, and the message
   * says how many pairs and what to do about them.
   */
  async update(id, data) {
    const existing = await this.getById(id);

    if (data.is_active === false && existing.is_active) {
      const [{ count: stock }] = await db('inventory_items')
        .where({ store_id: id, status: 'in_stock' }).count('id as count');
      if (Number(stock) > 0) {
        throw new AppError(
          `This store still holds ${stock} item(s) in stock. Transfer or sell them before closing it.`,
          400
        );
      }
      const [{ count: pending }] = await db('store_transfers')
        .whereIn('status', ['pending', 'shipped'])
        .where(function () { this.where('from_store_id', id).orWhere('to_store_id', id); })
        .count('id as count');
      if (Number(pending) > 0) {
        throw new AppError(
          `This store has ${pending} transfer(s) still in flight. Complete or cancel them first.`,
          400
        );
      }
      const [{ count: activeStores }] = await db('stores')
        .where('is_active', true).whereNot('id', id).count('id as count');
      if (Number(activeStores) === 0) {
        throw new AppError('At least one store must stay open.', 400);
      }
    }

    const safeData = { updated_at: new Date() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.is_warehouse !== undefined) safeData.is_warehouse = data.is_warehouse;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;

    const [store] = await db('stores').where('id', id).update(safeData).returning('*');
    if (!store) throw new AppError('Store not found', 404);
    return store;
  }

  // ================================================================
  //  STAFF
  // ================================================================

  /**
   * Who works here.
   *
   * Both routes into a store are reported: an explicit `user_stores` assignment, and
   * the older `users.store_id` home store. They mean different things — a home store
   * cannot be revoked from this screen, because it is the user's own record — so the
   * list says which is which rather than silently merging them.
   */
  async listStaff(storeId) {
    await this.getById(storeId);
    const rows = await db('users')
      .leftJoin('roles', 'users.role_id', 'roles.id')
      .leftJoin('user_stores', function () {
        this.on('user_stores.user_id', '=', 'users.id').andOn('user_stores.store_id', '=', db.raw('?', [storeId]));
      })
      .where(function () {
        this.where('users.store_id', storeId).orWhereNotNull('user_stores.id');
      })
      .select(
        'users.id', 'users.username', 'users.full_name', 'users.is_active',
        'roles.name as role_name',
        db.raw('(user_stores.id IS NOT NULL) as assigned'),
        db.raw('(users.store_id = ?) as is_home_store', [storeId])
      )
      .orderBy('users.full_name');
    return rows;
  }

  /**
   * Replace the set of users assigned to this store.
   *
   * A whole-set replace rather than add/remove calls, mirroring `setBoxItems`: the
   * screen shows a list of checkboxes and one save, so one transaction should reflect
   * exactly what is on screen.
   *
   * Assigning a user to a store grants them that store's sales, stock and money, so
   * the route is gated on `users:write` — the permission that already carries the
   * power to change what somebody can see. Anyone with only `stores:write` can rename
   * a branch but cannot let themselves into another one.
   */
  async setStaff(storeId, userIds) {
    await this.getById(storeId);
    const ids = [...new Set(userIds || [])];

    if (ids.length) {
      const found = await db('users').whereIn('id', ids).select('id');
      if (found.length !== ids.length) throw new AppError('One or more users do not exist', 400);
    }

    // Everyone whose access is about to change — those removed as well as those added —
    // so the auth cache cannot leave a removed user with this branch's data for the
    // 30s TTL. Gathered before the delete.
    const before = await db('user_stores').where('store_id', storeId).pluck('user_id');
    const affected = [...new Set([...before, ...ids])];

    const result = await db.transaction(async (trx) => {
      await trx('user_stores').where('store_id', storeId).del();
      if (ids.length) {
        await trx('user_stores').insert(ids.map((user_id) => ({ user_id, store_id: storeId })));
      }
      return this.listStaff(storeId);
    });

    affected.forEach(invalidateUserCache);
    return result;
  }

  // ================================================================
  //  PER-STORE PRICING
  // ================================================================

  /**
   * What each product sells for in this store.
   *
   * `store_product_prices` has existed since the first migration and is read by the
   * inventory query, the barcode lookup and the till — but nothing has ever written a
   * row into it. A branch in a different neighbourhood could not charge a different
   * price, and there was no screen that would have shown you why.
   *
   * Products with no override are listed too, showing the catalogue price they fall
   * back to, because "which of my products have a local price?" is the question this
   * screen exists to answer.
   */
  async listPrices(storeId, { search, only_overridden, limit = 200, page = 1 } = {}) {
    await this.getById(storeId);
    const lmt = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
    const pg = Math.max(1, parseInt(page, 10) || 1);

    const base = () => {
      const q = db('products')
        .leftJoin('store_product_prices as spp', function () {
          this.on('spp.product_id', '=', 'products.id').andOn('spp.store_id', '=', db.raw('?', [storeId]));
        })
        .where('products.is_active', true);
      if (search) {
        const safe = String(search).replace(/[%_\\]/g, '\\$&');
        q.where(function () {
          this.where('products.model_name', 'ilike', `%${safe}%`)
            .orWhere('products.product_code', 'ilike', `%${safe}%`)
            .orWhere('products.brand', 'ilike', `%${safe}%`);
        });
      }
      if (only_overridden === true || only_overridden === 'true') q.whereNotNull('spp.id');
      return q;
    };

    const rows = await base()
      .select(
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.default_selling_price',
        'products.min_selling_price',
        'products.max_selling_price',
        'spp.selling_price as store_selling_price',
        'spp.min_selling_price as store_min_selling_price',
        'spp.max_selling_price as store_max_selling_price'
      )
      .orderBy([{ column: 'products.product_code', order: 'asc' }])
      .limit(lmt)
      .offset((pg - 1) * lmt);

    const [{ count }] = await base().count('products.id as count');

    return {
      data: rows,
      pagination: {
        page: pg,
        limit: lmt,
        total: Number(count),
        totalPages: Math.ceil(Number(count) / lmt) || 1,
      },
    };
  }

  /**
   * Set or clear this store's price for one product.
   *
   * A null `selling_price` clears the override, which is a different thing from a
   * price of zero and has to stay expressible — otherwise the only way back to the
   * catalogue price would be to retype it and hope it never changes again.
   */
  async setPrice(storeId, productId, { selling_price, min_selling_price, max_selling_price }) {
    await this.getById(storeId);
    const product = await db('products').where('id', productId).first();
    if (!product) throw new AppError('Product not found', 404);

    if (selling_price === null || selling_price === undefined || selling_price === '') {
      await db('store_product_prices').where({ store_id: storeId, product_id: productId }).del();
      return { store_id: storeId, product_id: productId, store_selling_price: null };
    }

    const price = num(selling_price);
    const min = min_selling_price === null || min_selling_price === undefined || min_selling_price === '' ? null : num(min_selling_price);
    const max = max_selling_price === null || max_selling_price === undefined || max_selling_price === '' ? null : num(max_selling_price);

    // The till enforces min <= price <= max at checkout. A band that cannot contain
    // its own default would reject every sale of this product in this store, so it is
    // refused here where the message can say so.
    if (min !== null && max !== null && min > max) {
      throw new AppError('Minimum price cannot be above the maximum price', 400);
    }
    if (min !== null && price < min) throw new AppError('Selling price is below this store\'s minimum', 400);
    if (max !== null && price > max) throw new AppError('Selling price is above this store\'s maximum', 400);

    const existing = await db('store_product_prices').where({ store_id: storeId, product_id: productId }).first();
    if (existing) {
      const [row] = await db('store_product_prices')
        .where('id', existing.id)
        .update({ selling_price: price, min_selling_price: min, max_selling_price: max, updated_at: new Date() })
        .returning('*');
      return row;
    }
    const [row] = await db('store_product_prices')
      .insert({
        id: generateUUID(),
        store_id: storeId,
        product_id: productId,
        selling_price: price,
        min_selling_price: min,
        max_selling_price: max,
      })
      .returning('*');
    return row;
  }

  // ================================================================
  //  STORE REPORT
  // ================================================================

  /**
   * One branch, over one period: what it sold, what it earned, what it spent, what it
   * is sitting on, and who did the selling.
   *
   * Every figure here is built from the same expressions the company-wide reports use
   * (utils/saleMath.js), so a store's revenue and the company revenue filtered to that
   * store are the same number — which is the whole reason for sharing them.
   */
  async overview(storeId, filters = {}, requestingUser = null) {
    const store = await this.getById(storeId);
    // Throws 403 if this user has no business looking at this branch.
    if (requestingUser) resolveStoreScope(requestingUser, { store_id: storeId });

    const range = defaultRange(filters);
    const withRange = (q, col = 'sales.created_at') => applyDateRange(q, col, range);

    const salesQ = withRange(
      db('sales')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .select(
          db.raw('COUNT(sales.id)::int as sales_count'),
          db.raw('COALESCE(SUM(sales.final_amount), 0) as revenue'),
          db.raw('COALESCE(SUM(sales.discount_amount), 0) as discounts'),
          db.raw('COALESCE(SUM(sales.refunded_amount), 0) as refunded'),
          db.raw('COUNT(DISTINCT sales.customer_id)::int as customers')
        )
    );

    const profitQ = withRange(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .select(
          db.raw('COUNT(sale_items.id)::int as items_sold'),
          db.raw('SUM(CASE WHEN customer_return_items.id IS NOT NULL THEN 1 ELSE 0 END)::int as items_returned'),
          db.raw(`COALESCE(SUM(CASE WHEN customer_return_items.id IS NULL THEN ${ITEM_PROFIT} ELSE 0 END), 0) as profit`)
        )
    );

    const expensesQ = applyDateRange(
      db('expenses').where('store_id', storeId).select(db.raw('COALESCE(SUM(amount), 0) as total')),
      'expense_date',
      range
    );

    const stockQ = db('inventory_items')
      .where({ store_id: storeId, status: 'in_stock' })
      .select(
        db.raw('COUNT(id)::int as units'),
        db.raw('COALESCE(SUM(cost), 0) as value')
      );

    const trendQ = withRange(
      db('sales')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .select(db.raw("TO_CHAR(sales.created_at, 'YYYY-MM-DD') as date"))
        .sum('sales.final_amount as revenue')
        .count('sales.id as orders')
        .groupByRaw("TO_CHAR(sales.created_at, 'YYYY-MM-DD')")
        .orderBy('date', 'asc')
    );

    const topProductsQ = withRange(
      db('sale_items')
        .join('sales', 'sale_items.sale_id', 'sales.id')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .whereNull('customer_return_items.id')
        .select('products.product_code as code', 'products.model_name as name', 'products.brand')
        .select(
          db.raw('COUNT(sale_items.id)::int as qty'),
          db.raw('COALESCE(SUM(sale_items.sale_price), 0) as revenue'),
          db.raw(`COALESCE(SUM(${ITEM_PROFIT}), 0) as profit`)
        )
        .groupBy('products.id', 'products.product_code', 'products.model_name', 'products.brand')
        .orderBy('qty', 'desc')
        .limit(10)
    );

    const staffQ = withRange(
      db('sales')
        .leftJoin('users', 'sales.created_by', 'users.id')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .select(db.raw("COALESCE(users.full_name, users.username, 'Unknown') as name"))
        .select(
          db.raw('COUNT(sales.id)::int as sales_count'),
          db.raw('COALESCE(SUM(sales.final_amount), 0) as revenue')
        )
        .groupByRaw("COALESCE(users.full_name, users.username, 'Unknown')")
        .orderBy('revenue', 'desc')
    );

    const paymentsQ = withRange(
      db('sale_payments')
        .join('sales', 'sale_payments.sale_id', 'sales.id')
        .where('sales.store_id', storeId)
        .whereNull('sales.voided_at')
        .select('sale_payments.payment_method as method')
        .sum('sale_payments.amount as total')
        .groupBy('sale_payments.payment_method')
        .orderBy('total', 'desc')
    );

    // Stock by category, so "what is this branch actually holding" has an answer that
    // is not a list of 400 pairs. leftJoin + COALESCE: a product with no category must
    // not vanish from its own store's stock count.
    const stockByCategoryQ = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .leftJoin('product_categories as pc', 'pc.id', 'products.category_id')
      .where({ 'inventory_items.store_id': storeId, 'inventory_items.status': 'in_stock' })
      .select(
        db.raw("COALESCE(pc.name_en, 'Uncategorised') as category"),
        db.raw('pc.name_ar as category_ar'),
        db.raw('COUNT(inventory_items.id)::int as units'),
        db.raw('COALESCE(SUM(inventory_items.cost), 0) as value')
      )
      .groupByRaw("COALESCE(pc.name_en, 'Uncategorised'), pc.name_ar")
      .orderBy('units', 'desc');

    const lowStockQ = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .where({ 'inventory_items.store_id': storeId, 'inventory_items.status': 'in_stock' })
      .select('products.product_code as code', 'products.model_name as name')
      .count('inventory_items.id as stock')
      .groupBy('products.id', 'products.product_code', 'products.model_name')
      .havingRaw('COUNT(inventory_items.id) <= ?', [LOW_STOCK_THRESHOLD])
      .orderBy('stock', 'asc')
      .limit(10);

    const creditQ = db('sales')
      .where('sales.store_id', storeId)
      .whereNull('sales.voided_at')
      .select(db.raw(`COALESCE(SUM(GREATEST(sales.final_amount - COALESCE(
        (SELECT SUM(amount) FROM sale_payments sp WHERE sp.sale_id = sales.id), 0), 0)), 0) as outstanding`));

    const transfersQ = db('store_transfers')
      .whereIn('status', ['pending', 'shipped'])
      .where(function () { this.where('from_store_id', storeId).orWhere('to_store_id', storeId); })
      .select(
        db.raw('SUM(CASE WHEN from_store_id = ? THEN 1 ELSE 0 END)::int as outgoing', [storeId]),
        db.raw('SUM(CASE WHEN to_store_id = ? THEN 1 ELSE 0 END)::int as incoming', [storeId])
      );

    const [sales, profit, expenses, stock, trend, topProducts, staff, payments,
      stockByCategory, lowStock, credit, transfers] = await Promise.all([
      salesQ.first(), profitQ.first(), expensesQ.first(), stockQ.first(), trendQ,
      topProductsQ, staffQ, paymentsQ, stockByCategoryQ, lowStockQ, creditQ.first(), transfersQ.first(),
    ]);

    const revenue = num(sales.revenue);
    const refunded = num(sales.refunded);
    // What the branch actually kept. The company dashboard headlines `net_sales`,
    // which is revenue less refunds — so this one has to mean the same thing, or the
    // same branch reads two different revenues on two screens and neither is wrong.
    // Gross is still returned beside it, because a shop with heavy returns needs to
    // see both halves rather than one number that hides them.
    const netRevenue = Math.round((revenue - refunded) * 100) / 100;
    const grossProfit = num(profit.profit);
    const spend = num(expenses.total);

    return {
      store,
      range: { startDate: range.startDate || null, endDate: range.endDate || null },
      metrics: {
        sales_count: sales.sales_count,
        gross_revenue: Math.round(revenue * 100) / 100,
        revenue: netRevenue,
        discounts: Math.round(num(sales.discounts) * 100) / 100,
        refunded: Math.round(refunded * 100) / 100,
        customers: sales.customers,
        items_sold: profit.items_sold,
        items_returned: profit.items_returned,
        gross_profit: Math.round(grossProfit * 100) / 100,
        expenses: Math.round(spend * 100) / 100,
        net: Math.round((grossProfit - spend) * 100) / 100,
        aov: sales.sales_count ? Math.round((netRevenue / sales.sales_count) * 100) / 100 : 0,
        margin_pct: netRevenue ? Math.round((grossProfit / netRevenue) * 1000) / 10 : 0,
        stock_units: stock.units,
        stock_value: Math.round(num(stock.value) * 100) / 100,
        customer_credit: Math.round(num(credit.outstanding) * 100) / 100,
        transfers_in: transfers?.incoming || 0,
        transfers_out: transfers?.outgoing || 0,
      },
      trend: trend.map((r) => ({ date: r.date, revenue: num(r.revenue), orders: Number(r.orders) })),
      top_products: topProducts.map((r) => ({ ...r, revenue: num(r.revenue), profit: num(r.profit) })),
      staff: staff.map((r) => ({ name: r.name, sales_count: r.sales_count, revenue: num(r.revenue) })),
      payment_methods: payments.map((r) => ({ method: r.method, total: num(r.total) })),
      stock_by_category: stockByCategory.map((r) => ({ ...r, value: num(r.value) })),
      low_stock: lowStock.map((r) => ({ ...r, stock: Number(r.stock) })),
    };
  }

  /**
   * Every store side by side, over one period.
   *
   * The company reports answer "how are we doing"; this answers "which branch is
   * doing it". Same expressions, grouped by store instead of filtered to one.
   */
  async comparison(filters = {}, requestingUser = null) {
    const scope = requestingUser ? resolveStoreScope(requestingUser, filters) : {};
    const range = defaultRange(filters);

    const storesQuery = db('stores').orderBy('name');
    applyStoreScope(storesQuery, 'id', scope);
    const stores = await storesQuery;
    if (!stores.length) return { range, stores: [] };

    const ids = stores.map((s) => s.id);
    const scoped = (q, col) => { q.whereIn(col, ids); return q; };

    const salesQ = applyDateRange(
      scoped(
        db('sales')
          .whereNull('voided_at')
          .select('store_id')
          .count('id as orders')
          .sum('final_amount as revenue')
          .sum('discount_amount as discounts')
          .sum('refunded_amount as refunded')
          .groupBy('store_id'),
        'store_id'
      ),
      'created_at', range
    );

    const profitQ = applyDateRange(
      scoped(
        db('sale_items')
          .join('sales', 'sale_items.sale_id', 'sales.id')
          .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
          .whereNull('sales.voided_at')
          .whereNull('customer_return_items.id')
          .select('sales.store_id')
          .select(
            db.raw('COUNT(sale_items.id)::int as items'),
            db.raw(`COALESCE(SUM(${ITEM_PROFIT}), 0) as profit`)
          )
          .groupBy('sales.store_id'),
        'sales.store_id'
      ),
      'sales.created_at', range
    );

    const expensesQ = applyDateRange(
      scoped(db('expenses').select('store_id').sum('amount as total').groupBy('store_id'), 'store_id'),
      'expense_date', range
    );

    const stockQ = scoped(
      db('inventory_items').where('status', 'in_stock')
        .select('store_id').count('id as units').sum('cost as value').groupBy('store_id'),
      'store_id'
    );

    const [sales, profit, expenses, stock] = await Promise.all([salesQ, profitQ, expensesQ, stockQ]);

    const salesMap = byStore(sales, (r) => ({ orders: Number(r.orders), revenue: num(r.revenue), discounts: num(r.discounts), refunded: num(r.refunded) }));
    const profitMap = byStore(profit, (r) => ({ items: r.items, profit: num(r.profit) }));
    const expenseMap = byStore(expenses, (r) => num(r.total));
    const stockMap = byStore(stock, (r) => ({ units: Number(r.units), value: num(r.value) }));

    const rows = stores.map((s) => {
      const sale = salesMap.get(s.id) || { orders: 0, revenue: 0, discounts: 0, refunded: 0 };
      const prof = profitMap.get(s.id) || { items: 0, profit: 0 };
      const spend = expenseMap.get(s.id) || 0;
      const stk = stockMap.get(s.id) || { units: 0, value: 0 };
      // Net of refunds, matching the dashboard and the single-store overview.
      const netRevenue = Math.round((sale.revenue - sale.refunded) * 100) / 100;
      return {
        store_id: s.id,
        name: s.name,
        is_warehouse: s.is_warehouse,
        is_active: s.is_active,
        orders: sale.orders,
        gross_revenue: Math.round(sale.revenue * 100) / 100,
        refunded: Math.round(sale.refunded * 100) / 100,
        revenue: netRevenue,
        discounts: Math.round(sale.discounts * 100) / 100,
        // Net of returns: a pair that came back was not sold. `revenue` above is
        // gross of returns (refunds are recorded separately), so the two are not
        // two views of one number and the UI labels them apart.
        items_net: prof.items,
        gross_profit: Math.round(prof.profit * 100) / 100,
        expenses: Math.round(spend * 100) / 100,
        net: Math.round((prof.profit - spend) * 100) / 100,
        aov: sale.orders ? Math.round((netRevenue / sale.orders) * 100) / 100 : 0,
        margin_pct: netRevenue ? Math.round((prof.profit / netRevenue) * 1000) / 10 : 0,
        stock_units: stk.units,
        stock_value: Math.round(stk.value * 100) / 100,
      };
    });

    return {
      range: { startDate: range.startDate || null, endDate: range.endDate || null },
      stores: rows,
      totals: rows.reduce((acc, r) => ({
        orders: acc.orders + r.orders,
        revenue: Math.round((acc.revenue + r.revenue) * 100) / 100,
        refunded: Math.round((acc.refunded + r.refunded) * 100) / 100,
        items_net: acc.items_net + r.items_net,
        gross_profit: Math.round((acc.gross_profit + r.gross_profit) * 100) / 100,
        expenses: Math.round((acc.expenses + r.expenses) * 100) / 100,
        net: Math.round((acc.net + r.net) * 100) / 100,
        stock_units: acc.stock_units + r.stock_units,
        stock_value: Math.round((acc.stock_value + r.stock_value) * 100) / 100,
      }), { orders: 0, revenue: 0, refunded: 0, items_net: 0, gross_profit: 0, expenses: 0, net: 0, stock_units: 0, stock_value: 0 }),
    };
  }
}

module.exports = new StoresService();
