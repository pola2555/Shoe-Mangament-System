const bcrypt = require('bcryptjs');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Users service — CRUD + permission management.
 * 
 * Key rules:
 * - Only admins can create/edit users
 * - Users without 'all_stores' permission can only see their own store's users
 * - Passwords are bcrypt-hashed before storage
 * - Permissions are managed as a replace-all operation (simpler than add/remove individual)
 */
class UsersService {
  async listRoles() {
    return db('roles').select('id', 'name', 'description').orderBy('id');
  }

  async listPermissions() {
    return db('permissions').select('id', 'code', 'description', 'category').orderBy('category', 'asc').orderBy('code', 'asc');
  }

  async list(requestingUser) {
    let query = db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .leftJoin('stores', 'users.store_id', 'stores.id')
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.store_id',
        'users.role_id',
        'users.is_active',
        'users.last_login_at',
        'users.created_at',
        'roles.name as role_name',
        'stores.name as store_name'
      )
      .orderBy('users.created_at', 'desc');

    // Non-admin users without 'all_stores' can only see their store's users
    if (requestingUser.role_name !== 'admin' && !requestingUser.permissions.all_stores) {
      query = query.where('users.store_id', requestingUser.store_id);
    }

    return query;
  }

  async getById(id) {
    const user = await db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .leftJoin('stores', 'users.store_id', 'stores.id')
      .where('users.id', id)
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.store_id',
        'users.role_id',
        'users.is_active',
        'users.last_login_at',
        'users.created_at',
        'roles.name as role_name',
        'stores.name as store_name'
      )
      .first();

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Fetch permissions
    const permissions = await db('user_permissions')
      .where('user_id', id)
      .select('permission_code', 'access_level');

    user.permissions = permissions;
    return user;
  }

  async create(data) {
    // Hash password
    const password_hash = await bcrypt.hash(data.password, 12);

    const [user] = await db('users')
      .insert({
        id: generateUUID(),
        username: data.username,
        email: data.email,
        password_hash,
        full_name: data.full_name,
        role_id: data.role_id,
        store_id: data.store_id || null,
      })
      .returning(['id', 'username', 'email', 'full_name', 'role_id', 'store_id', 'is_active', 'created_at']);

    return user;
  }

  async update(id, data) {
    // Ensure user exists
    const existing = await db('users').where('id', id).first();
    if (!existing) {
      throw new AppError('User not found', 404);
    }

    // If password is provided, hash it
    if (data.password) {
      data.password_hash = await bcrypt.hash(data.password, 12);
      delete data.password;
    }

    data.updated_at = new Date();

    const [user] = await db('users')
      .where('id', id)
      .update(data)
      .returning(['id', 'username', 'email', 'full_name', 'role_id', 'store_id', 'is_active', 'updated_at']);

    return user;
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = await db('users').where('id', userId).first();
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      throw new AppError('Current password is incorrect', 400);
    }

    const password_hash = await bcrypt.hash(newPassword, 12);
    await db('users').where('id', userId).update({ password_hash, updated_at: new Date() });
  }

  /**
   * Replace all permissions for a user.
   * This is a "set all" operation — easier than add/remove individual.
   * 
   * @param {string} userId
   * @param {Array} permissions - [{ permission_code: 'inventory', access_level: 'write' }, ...]
   */
  async setPermissions(userId, permissions) {
    // Ensure user exists
    const user = await db('users').where('id', userId).first();
    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Delete all existing permissions
    await db('user_permissions').where('user_id', userId).del();

    // Insert new permissions
    if (permissions.length > 0) {
      const rows = permissions.map((p) => ({
        user_id: userId,
        permission_code: p.permission_code,
        access_level: p.access_level,
      }));
      await db('user_permissions').insert(rows);
    }

    // Return updated permissions
    return db('user_permissions')
      .where('user_id', userId)
      .select('permission_code', 'access_level');
  }

  /**
   * Deactivate a user (soft delete).
   */
  async deactivate(id) {
    const [user] = await db('users')
      .where('id', id)
      .update({ is_active: false, updated_at: new Date() })
      .returning(['id', 'username', 'is_active']);

    if (!user) {
      throw new AppError('User not found', 404);
    }
    return user;
  }

  async getStores(userId) {
    return db('user_stores')
      .join('stores', 'user_stores.store_id', 'stores.id')
      .where('user_stores.user_id', userId)
      .select('stores.id', 'stores.name');
  }

  async setStores(userId, storeIds) {
    const user = await db('users').where('id', userId).first();
    if (!user) {
      throw new AppError('User not found', 404);
    }

    await db('user_stores').where('user_id', userId).del();

    if (storeIds && storeIds.length > 0) {
      const rows = storeIds.map((store_id) => ({
        user_id: userId,
        store_id,
      }));
      await db('user_stores').insert(rows);
    }

    return this.getStores(userId);
  }
}

module.exports = new UsersService();
