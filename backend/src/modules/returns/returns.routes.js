const express = require('express');
const router = express.Router();
const returnsController = require('./returns.controller');
const validate = require('../../middleware/validate');
const { createCustomerReturnSchema, createSupplierReturnSchema } = require('./returns.validation');
const auth = require('../../middleware/auth');

router.use(auth);

// Customer Returns
// Customer Returns
router.post('/customer', validate(createCustomerReturnSchema), returnsController.createCustomerReturn);

// Supplier Returns
router.post('/supplier', validate(createSupplierReturnSchema), returnsController.createSupplierReturn);

module.exports = router;
