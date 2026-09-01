const { Router } = require('express');
const controller = require('./product-categories.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createCategorySchema, updateCategorySchema } = require('./product-categories.validation');

/**
 * Reads are gated on `products:read`, not on the new `product_categories` code.
 *
 * The category list is needed by the product form, the POS and the inventory filters,
 * so requiring a fresh permission just to READ it would 403 every existing user until
 * an admin re-granted it — the same trap that broke the dashboard route once already.
 * Only editing needs `product_categories:write`.
 *
 * There is no DELETE. Categories are referenced by products with RESTRICT, so retiring
 * one means `is_active = false` — the convention the rest of the catalogue follows.
 */
const router = Router();

router.use(auth);

router.get('/', permission('products', 'read'), controller.listCategories);
router.get('/:id', permission('products', 'read'), controller.getCategory);
router.post('/', permission('product_categories', 'write'), validate(createCategorySchema), controller.createCategory);
router.put('/:id', permission('product_categories', 'write'), validate(updateCategorySchema), controller.updateCategory);
router.patch('/:id/toggle-active', permission('product_categories', 'write'), controller.toggleCategoryActive);

module.exports = router;
