const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class CustomersService {
  async list({ search } = {}) {
    let query = db('customers').orderBy('name', 'asc');
    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('phone', 'ilike', `%${safeSearch}%`)
          .orWhere('name', 'ilike', `%${safeSearch}%`);
      });
    }
    return query.limit(500);
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
    const safePhone = phone.replace(/[%_\\]/g, '\\$&');
    return db('customers').where('phone', 'ilike', `%${safePhone}%`).limit(10);
  }

  async create(data) {
    const existing = await db('customers').where('phone', data.phone).first();
    if (existing) throw new AppError('Customer with this phone already exists', 409);

    const safeData = { id: generateUUID() };
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.name !== undefined) safeData.name = data.name;
    if (data.notes !== undefined) safeData.notes = data.notes;

    const [customer] = await db('customers')
      .insert(safeData)
      .returning('*');
    return customer;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.name !== undefined) safeData.name = data.name;
    if (data.notes !== undefined) safeData.notes = data.notes;

    const [customer] = await db('customers')
      .where('id', id).update(safeData).returning('*');
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
