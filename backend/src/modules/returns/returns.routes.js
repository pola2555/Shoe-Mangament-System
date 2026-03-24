const express = require('express');
const router = express.Router();
const returnsController = require('./returns.controller');
const validate = require('../../middleware/validate');
const { createCustomerReturnSchema, createSupplierReturnSchema } = require('./returns.validation');
const auth = require('../../middleware/auth');
const permission = require('../../middleware/permission');

router.use(auth);

// Customer Returns
router.post('/customer', permission('customer_returns', 'write'), validate(createCustomerReturnSchema), returnsController.createCustomerReturn);

// Supplier Returns
router.post('/supplier', permission('supplier_returns', 'write'), validate(createSupplierReturnSchema), returnsController.createSupplierReturn);

module.exports = router;
