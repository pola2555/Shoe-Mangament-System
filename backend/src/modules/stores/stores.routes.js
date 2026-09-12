const { Router } = require('express');
const controller = require('./stores.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  createStoreSchema, updateStoreSchema, setStaffSchema, setPriceSchema,
} = require('./stores.validation');

const router = Router();

// All routes require authentication
router.use(auth);

/**
 * Three different powers live on this resource, and they are deliberately not the same
 * permission:
 *
 *   stores:read   the branch and what it holds
 *   stores:write  renaming it, closing it, setting its prices
 *   reports:read  its money — revenue, profit, staff performance
 *   users:write   who is allowed inside it
 *
 * That last one is the load-bearing split. Assigning a user to a store hands them that
 * store's sales, stock and takings, so it is gated on the permission that already
 * carries the power to change what somebody can see. Otherwise anyone who could rename
 * a branch could also add themselves to it and read the branch next door.
 */
const canWrite = permission('stores', 'write');
const canSeeMoney = permission('reports', 'read');
const canAssignUsers = permission('users', 'write');
const canSeeStaff = permission('users', 'read');
// Branch pricing writes `store_product_prices`, and so does
// PUT /api/products/:id/prices/:storeId, which has always been gated on
// `product_prices`. Gating this side on `stores:write` meant one table had two keys:
// granting somebody the right to RENAME a branch silently also gave them the right to
// set its prices — which is the exact power `product_prices` exists to control.
// Same table, same permission, both ways in.
const canReadPrices = permission('product_prices', 'read');
const canWritePrices = permission('product_prices', 'write');

/**
 * Listing branches needs no permission beyond being signed in.
 *
 * A branch's name is reference data: the till, the transfer form, the expenses filter,
 * the inventory filter and half the reports all need it before they can do anything at
 * all. Gating it on `stores:read` meant a cashier granted `pos:write` — a completely
 * reasonable thing for an admin to grant on its own — got a 403 here, an empty store
 * selector, and a till that could not ring up a single sale. The only clue on screen
 * was a "Sale failed" toast.
 *
 * What is actually worth protecting is the money hanging off a branch and the power to
 * change one, and those keep their own gates: `include_stats` is dropped without
 * `reports:read`, /overview needs `reports:read`, writes need `stores:write`, and
 * staff assignment needs `users:write`.
 */
const canRead = (req, res, next) => next();

// Specific paths before /:id, so 'comparison' is never read as a store id.
router.get('/comparison', canSeeMoney, controller.comparison);

router.get('/', canRead, controller.list);
router.post('/', canWrite, validate(createStoreSchema), controller.create);

router.get('/:id', canRead, controller.getById);
router.put('/:id', canWrite, validate(updateStoreSchema), controller.update);

router.get('/:id/overview', canSeeMoney, controller.overview);

// A staff roster is a list of users, so it answers to the users permission. Left on
// `canRead` it was a way around `users:read`: anyone signed in could enumerate every
// branch's staff, with usernames and whether each account was still active.
router.get('/:id/staff', canSeeStaff, controller.listStaff);
router.put('/:id/staff', canAssignUsers, validate(setStaffSchema), controller.setStaff);

// This returns min_selling_price for every product — the floor the shop will accept,
// which is precisely what the price band exists to keep out of a cashier's hands. It
// is not the reference data a till needs; the till gets its prices from /inventory.
router.get('/:id/prices', canReadPrices, controller.listPrices);
router.put('/:id/prices/:productId', canWritePrices, validate(setPriceSchema), controller.setPrice);

module.exports = router;
