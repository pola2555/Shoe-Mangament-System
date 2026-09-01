const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { applyStoreScope, resolveStoreScope } = require('../../utils/storeScope');
const { toDateOnly, businessDayStart } = require('../../utils/dateRange');

/**
 * Expenses: what the shop spends, on what, and against which budget.
 *
 * Three things shape this module:
 *
 * 1. Filtering and totalling happen HERE, in SQL. They used to happen in the browser
 *    over `GET /expenses` with no parameters and a hard `LIMIT 500`, so every filter
 *    and every "Total" silently described only the 500 most recent rows. A money
 *    figure that quietly stops being true at row 501 is worse than no figure.
 *
 * 2. Categories are two levels and shop-managed. `expense_categories` used to be six
 *    rows seeded once with no way to add a seventh.
 *
 * 3. Uncategorised expenses must never vanish. Every join to expense_categories is a
 *    leftJoin and every roll-up COALESCEs — the same rule the rest of this codebase
 *    learned the hard way (see the note on inventory.service.js).
 */

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MAX_PAGE_SIZE = 200;

/**
 * First day of the month a date falls in, as YYYY-MM-DD.
 *
 * Goes through toDateOnly rather than toISOString: a DATE from the database is a local
 * midnight, and converting it to UTC moves it into the previous month on the 1st.
 */
function monthStart(value) {
  if (!value) return `${businessDayStart().slice(0, 8)}01`;
  const iso = toDateOnly(value);
  if (!iso) throw new AppError('Invalid month', 400);
  return `${iso.slice(0, 8)}01`;
}

/**
 * The next due date after posting one occurrence.
 *
 * Advances from the date that was due, not from today: a template posted three weeks
 * late still lands on the right day next month, and a month that was missed entirely
 * stays visible as overdue instead of being skipped.
 */
function advance(value, frequency) {
  const dateStr = toDateOnly(value);
  if (!dateStr) throw new AppError('Invalid date', 400);
  // Anchored at UTC midnight so every getUTC*/setUTC* below is unambiguous, whatever
  // the machine's timezone is.
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfMonth = d.getUTCDate();
  switch (frequency) {
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: d.setUTCMonth(d.getUTCMonth() + 1); break;
  }
  // Rolling 31 Jan forward lands on 3 March, because month 1 has no 31st. Clamp back
  // to the last day of the intended month so a rent template does not drift.
  if (frequency !== 'weekly' && d.getUTCDate() !== dayOfMonth) {
    d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

/** Category columns every read returns, so the UI can localise without a second call. */
const CATEGORY_FIELDS = [
  'expense_categories.id as category_id',
  'expense_categories.name as category_name',
  'expense_categories.name as category_name_en',
  'expense_categories.name_ar as category_name_ar',
  'expense_categories.parent_id as category_parent_id',
  'parent_cat.name as parent_name_en',
  'parent_cat.name_ar as parent_name_ar',
];

class ExpensesService {
  // ================================================================
  //  CATEGORIES
  // ================================================================

  /**
   * Every category, each carrying its parent's name and how much it is used.
   *
   * `in_use` is what blocks deletion in the UI. It is one grouped count, not one query
   * per category.
   */
  async listCategories({ is_active, include_counts } = {}) {
    const q = db('expense_categories as c')
      .leftJoin('expense_categories as p', 'p.id', 'c.parent_id')
      .select(
        'c.id', 'c.name', 'c.name as name_en', 'c.name_ar', 'c.parent_id',
        'c.sort_order', 'c.is_active', 'c.created_at',
        'p.name as parent_name_en',
        'p.name_ar as parent_name_ar',
        'p.is_active as parent_is_active'
      )
      // Children sort under their parent; a parent sorts by its own key.
      .orderByRaw('COALESCE(p.sort_order, c.sort_order), COALESCE(p.id, c.id), c.parent_id NULLS FIRST, c.sort_order, c.name');

    if (is_active !== undefined) {
      const want = is_active === 'false' ? false : !!is_active;
      q.where('c.is_active', want);
      // A child of a deactivated parent is not selectable either — otherwise a shop
      // retires "Utilities" and "Electricity" carries on appearing on its own.
      if (want) q.where(function () { this.whereNull('c.parent_id').orWhere('p.is_active', true); });
    }

    const categories = await q;
    if (!include_counts) return categories;

    const counts = await db('expenses')
      .whereNotNull('category_id')
      .select('category_id')
      .count('id as n')
      .groupBy('category_id');
    const byId = new Map(counts.map((r) => [r.category_id, Number(r.n)]));

    const childCounts = new Map();
    for (const c of categories) {
      if (c.parent_id) childCounts.set(c.parent_id, (childCounts.get(c.parent_id) || 0) + 1);
    }
    return categories.map((c) => ({
      ...c,
      expense_count: byId.get(c.id) || 0,
      child_count: childCounts.get(c.id) || 0,
    }));
  }

  /**
   * Categories are two levels deep. Never more.
   *
   * Arbitrary nesting costs a recursive CTE in every roll-up and buys a shop nothing:
   * "Utilities > Electricity" is the real requirement, "Utilities > Power > Electricity"
   * is not. Enforced here rather than by a constraint, so the message can say why.
   */
  async _assertParentAllowed(parentId, selfId = null) {
    if (!parentId) return;
    if (selfId && Number(parentId) === Number(selfId)) {
      throw new AppError('A category cannot be its own parent', 400);
    }
    const parent = await db('expense_categories').where('id', parentId).first();
    if (!parent) throw new AppError('Parent category not found', 404);
    if (parent.parent_id) {
      throw new AppError(
        `"${parent.name}" is already a sub-category, so it cannot hold another. Categories go two levels deep.`,
        400
      );
    }
    if (selfId) {
      const children = await db('expense_categories').where('parent_id', selfId).count('id as n').first();
      if (Number(children.n) > 0) {
        throw new AppError(
          'This category has sub-categories of its own, so it cannot become one. Move its children out first.',
          400
        );
      }
    }
  }

  async createCategory(data) {
    await this._assertParentAllowed(data.parent_id);
    try {
      const [row] = await db('expense_categories')
        .insert({
          name: data.name.trim(),
          name_ar: data.name_ar ? data.name_ar.trim() : null,
          parent_id: data.parent_id || null,
          sort_order: data.sort_order ?? 0,
          is_active: data.is_active ?? true,
        })
        .returning('*');
      return row;
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError(`A category called "${data.name}" already exists here`, 409);
      }
      throw err;
    }
  }

  async updateCategory(id, data) {
    const current = await db('expense_categories').where('id', id).first();
    if (!current) throw new AppError('Category not found', 404);
    if (data.parent_id !== undefined) await this._assertParentAllowed(data.parent_id, id);

    const safe = { updated_at: new Date() };
    if (data.name !== undefined) safe.name = data.name.trim();
    if (data.name_ar !== undefined) safe.name_ar = data.name_ar ? data.name_ar.trim() : null;
    if (data.parent_id !== undefined) safe.parent_id = data.parent_id || null;
    if (data.sort_order !== undefined) safe.sort_order = data.sort_order;
    if (data.is_active !== undefined) safe.is_active = data.is_active;

    try {
      const [row] = await db('expense_categories').where('id', id).update(safe).returning('*');
      return row;
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError(`A category called "${safe.name}" already exists here`, 409);
      }
      throw err;
    }
  }

  /**
   * Retire a category instead of deleting it.
   *
   * Expenses reference it, and a deleted category would either take real spending with
   * it or leave it uncategorised — losing the history of what the money was for. Same
   * posture as products and colours everywhere else in this codebase.
   */
  async toggleCategoryActive(id) {
    const current = await db('expense_categories').where('id', id).first();
    if (!current) throw new AppError('Category not found', 404);
    const [row] = await db('expense_categories')
      .where('id', id)
      .update({ is_active: !current.is_active, updated_at: new Date() })
      .returning('*');
    return row;
  }

  async deleteCategory(id) {
    const used = await db('expenses').where('category_id', id).count('id as n').first();
    if (Number(used.n) > 0) {
      throw new AppError(
        `This category is used by ${used.n} expense(s), so deleting it would lose what that money was for. Deactivate it instead.`,
        400
      );
    }
    const children = await db('expense_categories').where('parent_id', id).count('id as n').first();
    if (Number(children.n) > 0) {
      throw new AppError('Move or delete its sub-categories first', 400);
    }
    const budgets = await db('expense_budgets').where('category_id', id).count('id as n').first();
    if (Number(budgets.n) > 0) {
      throw new AppError('This category has budgets set against it. Deactivate it instead.', 400);
    }
    const recurring = await db('expense_recurring').where('category_id', id).count('id as n').first();
    if (Number(recurring.n) > 0) {
      throw new AppError('This category is used by a recurring expense. Deactivate it instead.', 400);
    }
    const deleted = await db('expense_categories').where('id', id).del();
    if (!deleted) throw new AppError('Category not found', 404);
  }

  /** Backwards-compatible alias — the old route name. */
  async getCategories() {
    return this.listCategories({ is_active: true });
  }

  // ================================================================
  //  EXPENSES
  // ================================================================

  /**
   * Apply every filter to a query builder, so list(), the count and the total all
   * describe exactly the same set of rows. Keeping them in one place is the point:
   * a total computed over a different filter than the list it sits under is a lie.
   */
  _applyFilters(query, { category_id, from_date, to_date, search, payment_method, recurring_only }) {
    if (category_id) {
      // Selecting a parent includes everything filed under it, which is what a person
      // means by "show me Utilities".
      const ids = db('expense_categories').select('id').where('parent_id', category_id);
      query.where(function () {
        this.where('expenses.category_id', category_id).orWhereIn('expenses.category_id', ids);
      });
    }
    if (from_date) query.where('expenses.expense_date', '>=', from_date);
    if (to_date) query.where('expenses.expense_date', '<=', to_date);
    if (payment_method) query.where('expenses.payment_method', payment_method);
    if (recurring_only) query.whereNotNull('expenses.recurring_id');
    if (search) {
      const safe = String(search).replace(/[%_\\]/g, '\\$&');
      query.where(function () {
        this.where('expenses.description', 'ilike', `%${safe}%`)
          .orWhere('expenses.paid_to', 'ilike', `%${safe}%`)
          .orWhere('expense_categories.name', 'ilike', `%${safe}%`)
          .orWhere('expense_categories.name_ar', 'ilike', `%${safe}%`);
      });
    }
    return query;
  }

  _baseQuery(scope, filters) {
    const query = db('expenses')
      .join('stores', 'expenses.store_id', 'stores.id')
      // leftJoin: category_id is nullable, and an inner join silently hides
      // uncategorised expenses from the list entirely.
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .leftJoin('expense_categories as parent_cat', 'parent_cat.id', 'expense_categories.parent_id')
      .leftJoin('users', 'expenses.created_by', 'users.id');
    applyStoreScope(query, 'expenses.store_id', scope);
    return this._applyFilters(query, filters);
  }

  /**
   * A page of expenses, plus the total of the WHOLE filtered set.
   *
   * `summary.total` is deliberately not the sum of the returned page: the page shows
   * fifty rows, the figure underneath has to describe the filter.
   */
  async list(filters = {}, requestingUser) {
    const scope = resolveStoreScope(requestingUser, { store_id: filters.store_id });
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(filters.limit, 10) || 50));

    const rows = await this._baseQuery(scope, filters)
      .select(
        'expenses.*',
        'stores.name as store_name',
        ...CATEGORY_FIELDS,
        'users.full_name as created_by_name',
        db.raw('(SELECT COUNT(*)::int FROM attached_images ai WHERE ai.entity_type = ? AND ai.entity_id = expenses.id) as receipt_count', ['expense'])
      )
      .orderBy([{ column: 'expenses.expense_date', order: 'desc' }, { column: 'expenses.created_at', order: 'desc' }])
      .limit(limit)
      .offset((page - 1) * limit);

    const [{ total: count }] = await this._baseQuery(scope, filters).count('expenses.id as total');
    const [{ sum }] = await this._baseQuery(scope, filters).sum('expenses.amount as sum');

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total: parseInt(count, 10),
        totalPages: Math.ceil(parseInt(count, 10) / limit) || 1,
      },
      summary: { total: parseFloat(sum) || 0 },
    };
  }

  async getById(id) {
    const expense = await db('expenses')
      .join('stores', 'expenses.store_id', 'stores.id')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .leftJoin('expense_categories as parent_cat', 'parent_cat.id', 'expense_categories.parent_id')
      .leftJoin('users', 'expenses.created_by', 'users.id')
      .where('expenses.id', id)
      .first(
        'expenses.*',
        'stores.name as store_name',
        ...CATEGORY_FIELDS,
        'users.full_name as created_by_name'
      );
    if (!expense) throw new AppError('Expense not found', 404);
    expense.receipts = await this.listReceipts(id);
    return expense;
  }

  async create(data, userId) {
    const safeData = {
      id: generateUUID(),
      store_id: data.store_id,
      category_id: data.category_id ?? null,
      amount: data.amount,
      description: data.description,
      expense_date: data.expense_date,
      payment_method: data.payment_method || null,
      paid_to: data.paid_to || null,
      recurring_id: data.recurring_id || null,
      created_by: userId,
    };
    const [expense] = await db('expenses').insert(safeData).returning('*');
    return expense;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    for (const field of ['category_id', 'amount', 'description', 'expense_date', 'payment_method', 'paid_to', 'store_id']) {
      if (data[field] !== undefined) safeData[field] = data[field];
    }
    const [expense] = await db('expenses').where('id', id).update(safeData).returning('*');
    if (!expense) throw new AppError('Expense not found', 404);
    return expense;
  }

  async delete(id) {
    // Receipts hang off the expense polymorphically, so nothing cascades them.
    await db('attached_images').where({ entity_type: 'expense', entity_id: id }).del();
    const count = await db('expenses').where('id', id).del();
    if (!count) throw new AppError('Expense not found', 404);
  }

  // ================================================================
  //  RECEIPTS  (attached_images, entity_type = 'expense')
  // ================================================================

  async listReceipts(expenseId) {
    return db('attached_images')
      .where({ entity_type: 'expense', entity_id: expenseId })
      .orderBy('created_at', 'asc')
      .select('id', 'image_url', 'thumb_url', 'original_name', 'created_at');
  }

  async addReceipt(expenseId, { image_url, thumb_url, original_name }) {
    const expense = await db('expenses').where('id', expenseId).first();
    if (!expense) throw new AppError('Expense not found', 404);
    const [row] = await db('attached_images')
      .insert({
        id: generateUUID(),
        entity_type: 'expense',
        entity_id: expenseId,
        image_url,
        thumb_url: thumb_url || null,
        original_name: original_name || null,
      })
      .returning('*');
    return row;
  }

  async deleteReceipt(imageId) {
    const row = await db('attached_images').where({ id: imageId, entity_type: 'expense' }).first();
    if (!row) throw new AppError('Receipt not found', 404);
    await db('attached_images').where('id', imageId).del();
    return row;
  }

  // ================================================================
  //  RECURRING
  // ================================================================

  async listRecurring({ store_id, store_ids, is_active, due_only } = {}) {
    const query = db('expense_recurring as r')
      .join('stores', 'r.store_id', 'stores.id')
      .leftJoin('expense_categories as c', 'c.id', 'r.category_id')
      .leftJoin('expense_categories as p', 'p.id', 'c.parent_id')
      .select(
        'r.*',
        'stores.name as store_name',
        'c.name as category_name_en',
        'c.name_ar as category_name_ar',
        'p.name as parent_name_en',
        'p.name_ar as parent_name_ar',
        db.raw('(r.next_date <= CURRENT_DATE) as is_due')
      )
      .orderBy('r.next_date', 'asc');

    applyStoreScope(query, 'r.store_id', { store_id, store_ids });
    if (is_active !== undefined) query.where('r.is_active', is_active === 'false' ? false : !!is_active);
    if (due_only) query.where('r.is_active', true).whereRaw('r.next_date <= CURRENT_DATE');
    return query;
  }

  async createRecurring(data, userId) {
    if (!FREQUENCIES.includes(data.frequency)) throw new AppError('Unknown frequency', 400);
    const [row] = await db('expense_recurring')
      .insert({
        id: generateUUID(),
        store_id: data.store_id,
        category_id: data.category_id,
        amount: data.amount,
        description: data.description || null,
        payment_method: data.payment_method || null,
        paid_to: data.paid_to || null,
        frequency: data.frequency,
        next_date: data.next_date,
        end_date: data.end_date || null,
        is_active: data.is_active ?? true,
        created_by: userId,
      })
      .returning('*');
    return row;
  }

  async updateRecurring(id, data) {
    if (data.frequency && !FREQUENCIES.includes(data.frequency)) throw new AppError('Unknown frequency', 400);
    const safe = { updated_at: new Date() };
    for (const f of ['store_id', 'category_id', 'amount', 'description', 'payment_method', 'paid_to', 'frequency', 'next_date', 'end_date', 'is_active']) {
      if (data[f] !== undefined) safe[f] = data[f];
    }
    const [row] = await db('expense_recurring').where('id', id).update(safe).returning('*');
    if (!row) throw new AppError('Recurring expense not found', 404);
    return row;
  }

  async deleteRecurring(id) {
    // Expenses already posted from it keep their history; recurring_id becomes NULL.
    const count = await db('expense_recurring').where('id', id).del();
    if (!count) throw new AppError('Recurring expense not found', 404);
  }

  /**
   * Post one occurrence of a template as a real expense.
   *
   * Deliberately an explicit act. There is no scheduler in this deployment, and a
   * background job that silently books rent every month is worse than a list of what
   * is due — someone has to have decided the money actually went out.
   *
   * The template is locked for the update so two people clicking "post" at the same
   * moment cannot book the same month twice.
   */
  async postRecurring(id, { expense_date, amount } = {}, userId) {
    return db.transaction(async (trx) => {
      const tpl = await trx('expense_recurring').where('id', id).forUpdate().first();
      if (!tpl) throw new AppError('Recurring expense not found', 404);
      if (!tpl.is_active) throw new AppError('This recurring expense is paused', 400);

      const date = toDateOnly(expense_date) || toDateOnly(tpl.next_date);
      const [expense] = await trx('expenses')
        .insert({
          id: generateUUID(),
          store_id: tpl.store_id,
          category_id: tpl.category_id,
          amount: amount ?? tpl.amount,
          description: tpl.description,
          expense_date: date,
          payment_method: tpl.payment_method,
          paid_to: tpl.paid_to,
          recurring_id: tpl.id,
          created_by: userId,
        })
        .returning('*');

      // Advance from the date that was DUE, not from today, so a template posted late
      // does not drift and a skipped month stays visible as overdue.
      const nextDate = advance(tpl.next_date, tpl.frequency);
      const endDate = toDateOnly(tpl.end_date);
      const ended = endDate && nextDate > endDate;
      await trx('expense_recurring').where('id', id).update({
        next_date: nextDate,
        is_active: ended ? false : tpl.is_active,
        updated_at: new Date(),
      });

      return expense;
    });
  }

  // ================================================================
  //  BUDGETS
  // ================================================================

  /**
   * Budget against actual, for one month.
   *
   * Every active category comes back, budgeted or not — a category quietly overspent
   * with no budget set is exactly what a shop needs to see, so absence is reported as
   * a row with budget 0 rather than as a missing line.
   */
  async budgets({ store_id, store_ids, period_month } = {}) {
    const month = monthStart(period_month);
    const nextMonth = advance(month, 'monthly');
    const scope = { store_id, store_ids };

    const budgetQuery = db('expense_budgets as b')
      .where('b.period_month', month)
      .select('b.category_id', 'b.id as budget_id')
      .sum('b.amount as budget');
    applyStoreScope(budgetQuery, 'b.store_id', scope);
    const budgetRows = await budgetQuery.groupBy('b.category_id', 'b.id');

    const actualQuery = db('expenses')
      .where('expenses.expense_date', '>=', month)
      .where('expenses.expense_date', '<', nextMonth)
      .select('expenses.category_id')
      .sum('expenses.amount as actual');
    applyStoreScope(actualQuery, 'expenses.store_id', scope);
    const actualRows = await actualQuery.groupBy('expenses.category_id');

    const categories = await this.listCategories({ is_active: true });
    const budgetBy = new Map(budgetRows.map((r) => [r.category_id, r]));
    const actualBy = new Map(actualRows.map((r) => [r.category_id, parseFloat(r.actual) || 0]));

    const rows = categories.map((c) => {
      const budget = parseFloat(budgetBy.get(c.id)?.budget) || 0;
      const actual = actualBy.get(c.id) || 0;
      return {
        category_id: c.id,
        name_en: c.name_en,
        name_ar: c.name_ar,
        parent_id: c.parent_id,
        parent_name_en: c.parent_name_en,
        parent_name_ar: c.parent_name_ar,
        budget_id: budgetBy.get(c.id)?.budget_id || null,
        budget,
        actual,
        variance: budget - actual,
        // Undefined rather than Infinity when nothing is budgeted: a percentage of
        // zero is not a number anyone should see on a page.
        used_pct: budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null,
      };
    });

    // Spending filed against a category that has since been retired still happened.
    const known = new Set(categories.map((c) => c.id));
    for (const [catId, actual] of actualBy) {
      if (catId === null || known.has(catId)) continue;
      const cat = await db('expense_categories').where('id', catId).first();
      rows.push({
        category_id: catId,
        name_en: cat ? cat.name : 'Unknown',
        name_ar: cat ? cat.name_ar : null,
        parent_id: cat ? cat.parent_id : null,
        budget_id: null, budget: 0, actual, variance: -actual, used_pct: null,
        is_inactive: true,
      });
    }

    const uncategorised = actualBy.get(null) || 0;
    return {
      period_month: month,
      rows,
      uncategorised,
      totals: {
        budget: rows.reduce((n, r) => n + r.budget, 0),
        actual: rows.reduce((n, r) => n + r.actual, 0) + uncategorised,
      },
    };
  }

  /** Upsert: one budget per (store, category, month). */
  async setBudget({ store_id, category_id, period_month, amount }) {
    const month = monthStart(period_month);
    const existing = await db('expense_budgets').where({ store_id, category_id, period_month: month }).first();
    if (existing) {
      if (Number(amount) === 0) {
        await db('expense_budgets').where('id', existing.id).del();
        return null;
      }
      const [row] = await db('expense_budgets')
        .where('id', existing.id)
        .update({ amount, updated_at: new Date() })
        .returning('*');
      return row;
    }
    if (Number(amount) === 0) return null;
    const [row] = await db('expense_budgets')
      .insert({ id: generateUUID(), store_id, category_id, period_month: month, amount })
      .returning('*');
    return row;
  }

  // ================================================================
  //  SUMMARY
  // ================================================================

  /**
   * Spend per category for a period, with sub-categories rolled up under their parent.
   *
   * leftJoin + COALESCE throughout: uncategorised expenses appear as their own bucket
   * rather than vanishing from a total that is supposed to be the whole of it.
   */
  async summary({ store_id, store_ids, from_date, to_date } = {}) {
    const query = db('expenses')
      .leftJoin('expense_categories as c', 'expenses.category_id', 'c.id')
      .leftJoin('expense_categories as p', 'p.id', 'c.parent_id')
      .select(
        db.raw("COALESCE(p.id, c.id) as group_id"),
        db.raw("COALESCE(p.name, c.name, 'Uncategorised') as category"),
        db.raw("COALESCE(p.name_ar, c.name_ar) as category_ar"),
        db.raw("COALESCE(c.name, 'Uncategorised') as leaf"),
        db.raw("c.name_ar as leaf_ar"),
        db.raw("c.id as leaf_id")
      )
      .sum('expenses.amount as total')
      .groupByRaw("COALESCE(p.id, c.id), COALESCE(p.name, c.name, 'Uncategorised'), COALESCE(p.name_ar, c.name_ar), COALESCE(c.name, 'Uncategorised'), c.name_ar, c.id")
      .orderBy('total', 'desc');

    applyStoreScope(query, 'expenses.store_id', { store_id, store_ids });
    if (from_date) query.where('expense_date', '>=', from_date);
    if (to_date) query.where('expense_date', '<=', to_date);

    const leaves = await query;

    // Roll the leaves up into their parent so a caller gets both levels from one call.
    const groups = new Map();
    for (const row of leaves) {
      const key = row.group_id === null ? 'none' : row.group_id;
      if (!groups.has(key)) {
        groups.set(key, {
          category_id: row.group_id,
          category: row.category,
          category_ar: row.category_ar,
          total: 0,
          children: [],
        });
      }
      const g = groups.get(key);
      const amount = parseFloat(row.total) || 0;
      g.total += amount;
      // Only a real sub-category becomes a child row; a top-level category's own
      // spending is already its group total.
      if (row.leaf_id !== null && row.leaf_id !== row.group_id) {
        g.children.push({ category_id: row.leaf_id, category: row.leaf, category_ar: row.leaf_ar, total: amount });
      }
    }

    return [...groups.values()].sort((a, b) => b.total - a.total);
  }

  /** Month-by-month spend, for the trend on the reports page. */
  async monthlyTrend({ store_id, store_ids, months = 12 } = {}) {
    const n = Math.min(36, Math.max(1, parseInt(months, 10) || 12));
    const query = db('expenses')
      .select(db.raw("to_char(date_trunc('month', expense_date), 'YYYY-MM') as month"))
      .sum('amount as total')
      .whereRaw("expense_date >= date_trunc('month', CURRENT_DATE) - (? || ' months')::interval", [n - 1])
      .groupByRaw("date_trunc('month', expense_date)")
      .orderByRaw("date_trunc('month', expense_date)");
    applyStoreScope(query, 'expenses.store_id', { store_id, store_ids });
    const rows = await query;
    return rows.map((r) => ({ month: r.month, total: parseFloat(r.total) || 0 }));
  }
}

module.exports = new ExpensesService();
module.exports.advance = advance;
module.exports.monthStart = monthStart;
