const inventoryService = require('./inventory.service');

class InventoryController {
  async list(req, res, next) {
    try {
      const items = await inventoryService.list(req.query);
      res.json({ success: true, data: items });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const data = await inventoryService.summary(req.query);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async manualEntry(req, res, next) {
    try {
      const result = await inventoryService.manualEntry(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async markDamaged(req, res, next) {
    try {
      const item = await inventoryService.markDamaged(req.params.id, req.body.notes);
      res.json({ success: true, data: item });
    } catch (error) { next(error); }
  }
}

module.exports = new InventoryController();
