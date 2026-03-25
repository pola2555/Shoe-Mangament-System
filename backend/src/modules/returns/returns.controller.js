const returnsService = require('./returns.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');

// Helper: verify user has access to the given store
async function verifyStoreAccess(user, storeId) {
  if (user.role_name === 'admin' || user.permissions.all_stores) return;
  const assignment = await db('user_stores')
    .where({ user_id: user.id, store_id: storeId })
    .first();
  if (!assignment && user.store_id !== storeId) {
    throw new AppError('Access denied: you are not assigned to this store', 403);
  }
}

exports.createCustomerReturn = async (req, res, next) => {
  try {
    await verifyStoreAccess(req.user, req.body.store_id);
    const data = { ...req.body, created_by: req.user.id };
    const result = await returnsService.createCustomerReturn(data);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.createSupplierReturn = async (req, res, next) => {
  try {
    // Verify user has access to the stores holding the items being returned
    if (req.user.role_name !== 'admin' && !req.user.permissions?.all_stores) {
      const items = await db('inventory_items')
        .whereIn('id', req.body.items)
        .select('store_id');
      for (const item of items) {
        await verifyStoreAccess(req.user, item.store_id);
      }
    }
    const data = { ...req.body, created_by: req.user.id };
    const result = await returnsService.createSupplierReturn(data);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
