const returnsService = require('./returns.service');

exports.createCustomerReturn = async (req, res, next) => {
  try {
    const data = { ...req.body, created_by: req.user.id };
    const result = await returnsService.createCustomerReturn(data);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.createSupplierReturn = async (req, res, next) => {
  try {
    const data = { ...req.body, created_by: req.user.id };
    const result = await returnsService.createSupplierReturn(data);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
