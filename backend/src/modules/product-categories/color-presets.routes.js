const { Router } = require('express');
const controller = require('./product-categories.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const {
  createColorPresetSchema,
  updateColorPresetSchema,
} = require('./product-categories.validation');

/**
 * Reusable colour names, so "Black" is defined once instead of retyped per product.
 *
 * These are presets, not colours: a product still owns its own product_colors rows,
 * because images and variants hang off them. Picking from a shared list is what keeps
 * the names consistent across the catalogue, which matters because they are printed on
 * labels and grouped in reports.
 */
const router = Router();

router.use(auth);

router.get('/', permission('products', 'read'), controller.listColorPresets);
router.post('/', permission('product_categories', 'write'), validate(createColorPresetSchema), controller.createColorPreset);
router.put('/:id', permission('product_categories', 'write'), validate(updateColorPresetSchema), controller.updateColorPreset);

module.exports = router;
