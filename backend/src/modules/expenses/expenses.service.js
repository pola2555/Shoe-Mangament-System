const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class ExpensesService {
  async list({ store_id, category_id, from_date, to_date } = {}) {
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

    if (store_id) query = query.where('expenses.store_id', store_id);
    if (category_id) query = query.where('expenses.category_id', category_id);
    if (from_date) query = query.where('expenses.expense_date', '>=', from_date);
    if (to_date) query = query.where('expenses.expense_date', '<=', to_date);

    return query;
  }

  async getCategories() {
    return db('expense_categories').orderBy('name', 'asc');
  }

  async create(data, userId) {
    const [expense] = await db('expenses')
      .insert({ id: generateUUID(), ...data, created_by: userId })
      .returning('*');
    return expense;
  }

  async update(id, data) {
    data.updated_at = new Date();
    const [expense] = await db('expenses').where('id', id).update(data).returning('*');
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
