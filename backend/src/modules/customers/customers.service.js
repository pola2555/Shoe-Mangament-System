const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class CustomersService {
  async list({ search } = {}) {
    let query = db('customers').orderBy('name', 'asc');
    if (search) {
      query = query.where(function () {
        this.where('phone', 'ilike', `%${search}%`)
          .orWhere('name', 'ilike', `%${search}%`);
      });
    }
    return query;
  }

  async getById(id) {
    const customer = await db('customers').where('id', id).first();
    if (!customer) throw new AppError('Customer not found', 404);

    // Fetch purchase history
    customer.sales = await db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .where('customer_id', id)
      .select('sales.*', 'stores.name as store_name')
      .orderBy('sales.created_at', 'desc');

    return customer;
  }

  async searchByPhone(phone) {
    return db('customers').where('phone', 'ilike', `%${phone}%`).limit(10);
  }

  async create(data) {
    const existing = await db('customers').where('phone', data.phone).first();
    if (existing) throw new AppError('Customer with this phone already exists', 409);

    const [customer] = await db('customers')
      .insert({ id: generateUUID(), ...data })
      .returning('*');
    return customer;
  }

  async update(id, data) {
    data.updated_at = new Date();
    const [customer] = await db('customers')
      .where('id', id).update(data).returning('*');
    if (!customer) throw new AppError('Customer not found', 404);
    return customer;
  }

  async delete(id) {
    const salesCount = await db('sales').where('customer_id', id).count('id as count').first();
    if (parseInt(salesCount.count) > 0) {
      throw new AppError('Cannot delete customer with existing sales. Edit their info instead.', 400);
    }
    const count = await db('customers').where('id', id).del();
    if (!count) throw new AppError('Customer not found', 404);
  }
}

module.exports = new CustomersService();
