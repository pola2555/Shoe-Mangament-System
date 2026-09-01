const { Router } = require('express');
const controller = require('./product-categories.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  createScaleSchema,
  updateScaleSchema,
  replaceScaleValuesSchema,
} = require('./product-categories.validation');

/**
 * Size lists. Same permission split as categories: anyone who can read products can
 * read the lists, because the product form and the POS both need them.
 *
 * `PUT /:id/values` replaces the whole set in one transaction rather than exposing
 * per-value endpoints — that is what makes a reorder atomic, and it is the same shape
 * as setBoxItems in the purchases module.
 */
const router = Router();

router.use(auth);

router.get('/', permission('products', 'read'), controller.listScales);
router.get('/:id', permission('products', 'read'), controller.getScale);
router.post('/', permission('product_categories', 'write'), validate(createScaleSchema), controller.createScale);
router.put('/:id', permission('product_categories', 'write'), validate(updateScaleSchema), controller.updateScale);
router.put('/:id/values', permission('product_categories', 'write'), validate(replaceScaleValuesSchema), controller.replaceScaleValues);

module.exports = router;
