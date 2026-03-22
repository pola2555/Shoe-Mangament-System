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
    const [store] = await db('stores')
      .insert({ id: generateUUID(), ...data })
      .returning('*');
    return store;
  }

  async update(id, data) {
    data.updated_at = new Date();
    const [store] = await db('stores')
      .where('id', id)
      .update(data)
      .returning('*');
    if (!store) {
      throw new AppError('Store not found', 404);
    }
    return store;
  }
}

module.exports = new StoresService();
