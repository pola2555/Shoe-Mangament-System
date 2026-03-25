const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class ExpensesService {
  async list({ store_id, category_id, from_date, to_date } = {}, requestingUser) {
    let query = db('expenses')
      .join('stores', 'expenses.store_id', 'stores.id')
      .join('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .leftJoin('users', 'expenses.created_by', 'users.id')
      .select(
        'expenses.*',
        'stores.name as store_name',
        'expense_categories.name as category_name',
        'users.full_name as created_by_name'
      )
      .orderBy('expense_date', 'desc');

    // Store scoping for non-admin users
    if (requestingUser && requestingUser.role_name !== 'admin' && !requestingUser.permissions?.all_stores) {
      query = query.where('expenses.store_id', requestingUser.store_id);
    } else if (store_id) {
      query = query.where('expenses.store_id', store_id);
    }
    if (category_id) query = query.where('expenses.category_id', category_id);
    if (from_date) query = query.where('expenses.expense_date', '>=', from_date);
    if (to_date) query = query.where('expenses.expense_date', '<=', to_date);

    return query.limit(500);
  }

  async getCategories() {
    return db('expense_categories').orderBy('name', 'asc');
  }

  async create(data, userId) {
    const safeData = {
      id: generateUUID(),
      store_id: data.store_id,
      category_id: data.category_id,
      amount: data.amount,
      description: data.description,
      expense_date: data.expense_date,
      created_by: userId,
    };
    const [expense] = await db('expenses')
      .insert(safeData)
      .returning('*');
    return expense;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.category_id !== undefined) safeData.category_id = data.category_id;
    if (data.amount !== undefined) safeData.amount = data.amount;
    if (data.description !== undefined) safeData.description = data.description;
    if (data.expense_date !== undefined) safeData.expense_date = data.expense_date;
    const [expense] = await db('expenses').where('id', id).update(safeData).returning('*');
    if (!expense) throw new AppError('Expense not found', 404);
    return expense;
  }

  async delete(id) {
    const count = await db('expenses').where('id', id).del();
    if (!count) throw new AppError('Expense not found', 404);
  }

  async summary({ store_id, from_date, to_date } = {}) {
    let query = db('expenses')
      .join('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .select('expense_categories.name as category')
      .sum('expenses.amount as total')
      .groupBy('expense_categories.name')
      .orderBy('total', 'desc');

    if (store_id) query = query.where('expenses.store_id', store_id);
    if (from_date) query = query.where('expense_date', '>=', from_date);
    if (to_date) query = query.where('expense_date', '<=', to_date);

    return query;
  }
}

module.exports = new ExpensesService();
