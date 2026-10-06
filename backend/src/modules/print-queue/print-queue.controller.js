const service = require('./print-queue.service');
const { resolveStoreScope } = require('../../utils/storeScope');

/**
 * Every route re-derives the branch filter from the user rather than trusting the
 * query, and every :id route resolves through that scope — so a queue row in a branch
 * you are not assigned to is a 404, not somebody else's work you can print.
 *
 * A queue row is not stock, but it does name a product, a branch and a quantity, and
 * that is enough to tell an unassigned person what another branch just received.
 */
function scopeOf(req) {
  const { store_id: _s, store_ids: _si, ...rest } = req.query;
  return { rest, scope: resolveStoreScope(req.user, req.query) };
}

/** Query strings arrive as a bare value when there is one, an array when several. */
function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

class PrintQueueController {
  async list(req, res, next) {
    try {
      const { rest, scope } = scopeOf(req);
      res.json({ success: true, data: await service.list({ ...rest, ...scope }) });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      res.json({ success: true, data: await service.summary(scope) });
    } catch (error) { next(error); }
  }

  /**
   * Label payloads for a selection, with copies already set to what is owed.
   *
   * Served on GET and on POST: a few hundred row ids do not fit in a query string, and
   * the POST twin is the same read with the selection in the body. Nothing is written
   * on either.
   */
  async labels(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const ids = asArray(req.body?.ids ?? req.query.ids);
      res.json({ success: true, data: await service.labels({ ids, ...scope }) });
    } catch (error) { next(error); }
  }

  /** What a purchase box or a stock intake put on the shelf, offered as a print run. */
  async sourceLines(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const data = await service.sourceLines({
        source_type: req.query.source_type,
        source_id: req.query.source_id,
        ...scope,
      });
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async add(req, res, next) {
    try {
      // Queueing labels for a branch you are not assigned to would put work — and that
      // branch's prices — in front of somebody who should not see either.
      //
      // Checked with resolveStoreScope rather than userHasStoreAccess, so that adding
      // obeys exactly the same rule as listing. The two differ on one real case:
      // userHasStoreAccess treats a non-empty `assigned_stores` as the whole answer and
      // ignores `users.store_id`, while resolveStoreScope unions them. A user whose home
      // branch is not among their user_stores rows would see that branch on the queue
      // and be refused when adding to it.
      resolveStoreScope(req.user, { store_id: req.body.store_id });
      const rows = await service.add(req.body, req.user.id);
      res.status(201).json({ success: true, data: rows });
    } catch (error) { next(error); }
  }

  async addFromSource(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const rows = await service.addFromSource(req.body, req.user.id, scope);
      res.status(201).json({ success: true, data: rows });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      res.json({ success: true, data: await service.update(req.params.id, req.body, scope) });
    } catch (error) { next(error); }
  }

  async markPrinted(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const data = await service.markPrinted(req.body.items, req.user.id, scope);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async requeue(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      const rows = await service.requeue(req.params.id, req.user.id, scope);
      res.status(201).json({ success: true, data: rows });
    } catch (error) { next(error); }
  }

  async remove(req, res, next) {
    try {
      const { scope } = scopeOf(req);
      res.json({ success: true, data: await service.remove(req.params.id, scope) });
    } catch (error) { next(error); }
  }

  async clear(req, res, next) {
    try {
      const scope = resolveStoreScope(req.user, req.body);
      const data = await service.clear({ status: req.body.status, ...scope });
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }
}

module.exports = new PrintQueueController();
