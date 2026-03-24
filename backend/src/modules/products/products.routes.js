const { Router } = require('express');
const controller = require('./products.controller');
const validate = require('../../middleware/validate');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');
const { createUpload } = require('../../middleware/upload');
const {
  createProductSchema, updateProductSchema,
  createColorSchema, updateColorSchema,
  createVariantSchema, bulkCreateVariantsSchema, updateVariantSchema,
  setStorePriceSchema,
} = require('./products.validation');

const router = Router();
const upload = createUpload('products');

router.use(auth);

// --- Products ---
router.get('/', permission('products', 'read'), controller.list);
router.get('/:id', permission('products', 'read'), controller.getById);
router.post('/', permission('products', 'write'), validate(createProductSchema), controller.create);
router.put('/:id', permission('products', 'write'), validate(updateProductSchema), controller.update);
router.patch('/:id/toggle-active', permission('products', 'write'), controller.toggleActive);

// --- Colors (nested under product) ---
router.get('/:id/colors', permission('products', 'read'), controller.listColors);
router.post('/:id/colors', permission('products', 'write'), validate(createColorSchema), controller.createColor);
router.put('/:id/colors/:colorId', permission('products', 'write'), validate(updateColorSchema), controller.updateColor);
router.delete('/:id/colors/:colorId', permission('products', 'write'), controller.deleteColor);

// --- Images (nested under color) ---
router.post('/:id/colors/:colorId/images', permission('product_images', 'write'), upload.single('image'), controller.uploadImage);
router.put('/:id/images/:imageId/primary', permission('product_images', 'write'), controller.setPrimaryImage);
router.delete('/:id/images/:imageId', permission('product_images', 'write'), controller.deleteImage);

// --- Variants (nested under product) ---
router.get('/:id/variants', permission('product_variants', 'read'), controller.listVariants);
router.post('/:id/variants', permission('product_variants', 'write'), validate(createVariantSchema), controller.createVariant);
router.post('/:id/variants/bulk', permission('product_variants', 'write'), validate(bulkCreateVariantsSchema), controller.bulkCreateVariants);
router.put('/:id/variants/:variantId', permission('product_variants', 'write'), validate(updateVariantSchema), controller.updateVariant);
router.delete('/:id/variants/:variantId', permission('product_variants', 'write'), controller.deleteVariant);

// --- Store Prices ---
router.get('/:id/prices', permission('product_prices', 'read'), controller.getStorePrices);
router.put('/:id/prices/:storeId', permission('product_prices', 'write'), validate(setStorePriceSchema), controller.setStorePrice);
router.delete('/:id/prices/:storeId', permission('product_prices', 'write'), controller.deleteStorePrice);

module.exports = router;
