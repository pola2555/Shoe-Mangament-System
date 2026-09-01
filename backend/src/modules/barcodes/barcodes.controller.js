const barcodesService = require('./barcodes.service');
const { resolveStoreScope } = require('../../utils/storeScope');

/** Query strings arrive as a bare value when there is one, an array when several. */
function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
}

class BarcodesController {
  /** POS scan resolution. Store scope is re-derived, never taken from the client. */
  async lookup(req, res, next) {
    try {
      const scope = resolveStoreScope(req.user, req.query);
      const result = await barcodesService.lookup({
        code: req.query.code,
        exclude_ids: asArray(req.query.exclude_ids),
        ...scope,
      });
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async assign(req, res, next) {
    try {
      const { product_id, variant_ids } = req.body;
      const result = product_id
        ? await barcodesService.assignForProduct(product_id)
        : await barcodesService.assignForVariants(variant_ids);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async link(req, res, next) {
    try {
      const result = await barcodesService.linkManufacturerBarcode(
        req.body.variant_id,
        req.body.barcode
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async clear(req, res, next) {
    try {
      const result = await barcodesService.clearBarcode(req.params.variantId);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async labels(req, res, next) {
    try {
      const scope = resolveStoreScope(req.user, req.query);
      const rows = await barcodesService.labels({
        variant_ids: asArray(req.query.variant_ids),
        product_id: req.query.product_id,
        invoice_box_id: req.query.invoice_box_id,
        ...scope,
      });
      res.json({ success: true, data: rows });
    } catch (error) { next(error); }
  }
}

module.exports = new BarcodesController();
