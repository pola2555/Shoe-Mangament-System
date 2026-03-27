const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Auth service — handles authentication logic.
 * Separated from controller for testability and reuse.
 */
class AuthService {
  /**
   * Authenticate user by username + password.
   * Returns access token, refresh token, and user profile.
   */
  async login(username, password) {
    // Find user with role info
    const user = await db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .where('users.username', username)
      .where('users.is_active', true)
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.password_hash',
        'users.store_id',
        'users.role_id',
        'roles.name as role_name'
      )
      .first();

    if (!user) {
      throw new AppError('Invalid username or password', 401);
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      throw new AppError('Invalid username or password', 401);
    }

    // Generate tokens
    const accessToken = this._generateAccessToken(user);
    const refreshToken = await this._generateRefreshToken(user.id);

    // Update last login
    await db('users').where('id', user.id).update({ last_login_at: new Date() });

    // Fetch permissions
    const permissions = await db('user_permissions')
      .where('user_id', user.id)
      .select('permission_code', 'access_level');

    // Fetch assigned stores
    const assignedStores = await db('user_stores')
      .where('user_id', user.id)
      .select('store_id');

    // Remove password hash from response
    delete user.password_hash;

    return {
      user: {
        ...user,
        permissions: permissions.reduce((acc, p) => {
          acc[p.permission_code] = p.access_level;
          return acc;
        }, {}),
        assigned_stores: assignedStores.map(s => s.store_id),
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Refresh the access token using a valid refresh token.
   */
  async refresh(refreshTokenStr) {
    // Verify refresh token JWT
    let decoded;
    try {
      decoded = jwt.verify(refreshTokenStr, env.jwt.refreshSecret, { algorithms: ['HS256'] });
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    // Check if token exists and is not revoked
    const tokenRecord = await db('refresh_tokens')
      .where('token', refreshTokenStr)
      .where('is_revoked', false)
      .where('expires_at', '>', new Date())
      .first();

    if (!tokenRecord) {
      throw new AppError('Refresh token is invalid or has been revoked', 401);
    }

    // Fetch user
    const user = await db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .where('users.id', decoded.userId)
      .where('users.is_active', true)
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.store_id',
        'users.role_id',
        'roles.name as role_name'
      )
      .first();

    if (!user) {
      throw new AppError('User not found or deactivated', 401);
    }

    // Rotate refresh token: revoke old one, issue new one
    await db('refresh_tokens')
      .where('token', refreshTokenStr)
      .update({ is_revoked: true });

    const accessToken = this._generateAccessToken(user);
    const refreshToken = await this._generateRefreshToken(user.id);

    return { accessToken, refreshToken };
  }

  /**
   * Logout — revoke the refresh token.
   */
  async logout(refreshTokenStr) {
    await db('refresh_tokens')
      .where('token', refreshTokenStr)
      .update({ is_revoked: true });
  }

  /**
   * Get full profile of the authenticated user.
   */
  async getProfile(userId) {
    const user = await db('users')
      .join('roles', 'users.role_id', 'roles.id')
      .leftJoin('stores', 'users.store_id', 'stores.id')
      .where('users.id', userId)
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.full_name',
        'users.store_id',
        'users.role_id',
        'users.last_login_at',
        'users.created_at',
        'users.theme',
        'users.locale',
        'roles.name as role_name',
        'stores.name as store_name'
      )
      .first();

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const permissions = await db('user_permissions')
      .where('user_id', userId)
      .select('permission_code', 'access_level');

    user.permissions = permissions.reduce((acc, p) => {
      acc[p.permission_code] = p.access_level;
      return acc;
    }, {});

    // Fetch assigned stores
    const assignedStores = await db('user_stores')
      .where('user_id', userId)
      .select('store_id');
    user.assigned_stores = assignedStores.map(s => s.store_id);

    return user;
  }

  async updatePreferences(userId, prefs) {
    const allowed = {};
    if (prefs.theme && ['dark', 'light'].includes(prefs.theme)) allowed.theme = prefs.theme;
    if (prefs.locale && ['en', 'ar'].includes(prefs.locale)) allowed.locale = prefs.locale;

    if (Object.keys(allowed).length > 0) {
      await db('users').where('id', userId).update(allowed);
    }

    return allowed;
  }

  // --- Private helpers ---

  _generateAccessToken(user) {
    return jwt.sign(
      { userId: user.id, role: user.role_name },
      env.jwt.secret,
      { expiresIn: env.jwt.expiresIn, algorithm: 'HS256' }
    );
  }

  async _generateRefreshToken(userId) {
    const token = jwt.sign(
      { userId },
      env.jwt.refreshSecret,
      { expiresIn: env.jwt.refreshExpiresIn, algorithm: 'HS256' }
    );

    // Parse expiration to store in DB
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    await db('refresh_tokens').insert({
      id: generateUUID(),
      user_id: userId,
      token,
      expires_at: expiresAt,
    });

    return token;
  }
}

module.exports = new AuthService();
