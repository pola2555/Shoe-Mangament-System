const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Stores service — CRUD operations for stores.
 */
class StoresService {
  async list() {
    return db('stores').orderBy('created_at', 'asc');
  }

  async getById(id) {
    const store = await db('stores').where('id', id).first();
    if (!store) {
      throw new AppError('Store not found', 404);
    }
    return store;
  }

  async create(data) {
    const safeData = { id: generateUUID() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.is_warehouse !== undefined) safeData.is_warehouse = data.is_warehouse;
    const [store] = await db('stores')
      .insert(safeData)
      .returning('*');
    return store;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.is_warehouse !== undefined) safeData.is_warehouse = data.is_warehouse;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;
    const [store] = await db('stores')
      .where('id', id)
      .update(safeData)
      .returning('*');
    if (!store) {
      throw new AppError('Store not found', 404);
    }
    return store;
  }
}

module.exports = new StoresService();
