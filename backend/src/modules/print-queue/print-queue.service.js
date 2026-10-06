const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const barcodesService = require('../barcodes/barcodes.service');

/**
 * The label print queue.
 *
 * A standing list of labels the shop owes itself. Stock arrives at a desk and labels
 * come out of a printer, and those are rarely the same place or the same minute — the
 * queue is what carries the job from one to the other.
 *
 * TWO RULES DECIDE EVERY EDGE CASE HERE
 *
 * 1. ADDING THE SAME DOCUMENT TWICE MUST NOT DOUBLE THE LABELS. The prompt after
 *    receiving stock can be answered more than once, so adding a document REPLACES its
 *    own pending rows. Adding by hand SUMS, because a person pressing "add" a second
 *    time is asking for more.
 *
 * 2. A QUEUE ROW IS NEVER A RECORD OF STOCK. It is a note about work to do. Nothing in
 *    inventory, sales or reporting reads it, deleting one loses no history, and it is
 *    never the thing that says how many pairs exist. That is why it can be cleared
 *    freely and why `printed_qty` is allowed to disagree with stock: somebody may want
 *    a spare label, or may have ruined three on a jammed roll.
 *
 * The label CONTENT is never stored. It is looked up live from barcodes.service at
 * print time, so a price change or a newly minted barcode between queueing and printing
 * shows on the label rather than being frozen at the moment somebody pressed a button.
 */

const SOURCE_TYPES = ['purchase_box', 'stock_intake', 'manual'];
const DOCUMENT_SOURCES = ['purchase_box', 'stock_intake'];

/** Base select, joined out to what the page shows. */
function baseQuery(scope = {}) {
  const q = db('print_queue_items as pq')
    .join('product_variants as pv', 'pv.id', 'pq.variant_id')
    .join('products as p', 'p.id', 'pv.product_id')
    .join('product_colors as pc', 'pc.id', 'pv.product_color_id')
    .join('stores as s', 's.id', 'pq.store_id')
    .leftJoin('product_categories as pcat', 'pcat.id', 'p.category_id')
    .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
    .leftJoin('size_scale_values as ssv', 'ssv.id', 'pv.size_scale_value_id')
    .leftJoin('users as ua', 'ua.id', 'pq.added_by')
    .select(
      'pq.id',
      'pq.store_id',
      'pq.variant_id',
      'pq.quantity',
      'pq.printed_qty',
      'pq.status',
      'pq.source_type',
      'pq.source_id',
      'pq.source_ref',
      'pq.note',
      'pq.created_at',
      'pq.updated_at',
      'pq.last_printed_at',
      'pq.completed_at',
      's.name as store_name',
      'ua.full_name as added_by_name',
      'p.id as product_id',
      'p.product_code',
      'p.model_name as product_name',
      'p.brand',
      'pv.sku',
      'pv.size_eu',
      'pv.barcode',
      'pv.size_sort',
      'pc.color_name',
      'pc.hex_code',
      // Both carried so the frontend's formatSize/formatColor produce the same words
      // here as on every other screen — a belt must not read "EU OS", and a knife's
      // stand-in colour must not read as a colour somebody chose.
      'pc.is_placeholder as color_is_placeholder',
      'sscale.display_prefix as size_prefix',
      'sscale.display_suffix as size_suffix',
      'ssv.label_en as size_label_en',
      'ssv.label_ar as size_label_ar',
      'pcat.has_sizes'
    );

  applyStoreScope(q, 'pq.store_id', scope);
  return q;
}

class PrintQueueService {
  // ------------------------------------------------------------------ reading

  async list({ status, store_id, store_ids, source_type, search, limit = 500 } = {}) {
    let q = baseQuery({ store_id, store_ids });

    // Default to the work outstanding. A queue that opens showing everything ever
    // printed is a list of things that no longer need doing.
    q = q.where('pq.status', status || 'pending');
    if (source_type) q = q.where('pq.source_type', source_type);

    if (search) {
      const term = `%${search}%`;
      q = q.where((b) => {
        b.where('p.product_code', 'ilike', term)
          .orWhere('p.model_name', 'ilike', term)
          .orWhere('p.brand', 'ilike', term)
          .orWhere('pv.sku', 'ilike', term)
          .orWhere('pv.barcode', 'ilike', term)
          .orWhere('pq.source_ref', 'ilike', term);
      });
    }

    const rows = await q
      .orderBy('pq.created_at', 'desc')
      .orderBy('p.model_name')
      .orderBy('pc.color_name')
      .orderBy(['pv.size_sort', 'pv.size_eu'])
      .limit(Math.min(Number(limit) || 500, 2000));

    return rows.map((r) => ({
      ...r,
      quantity: Number(r.quantity),
      printed_qty: Number(r.printed_qty),
      remaining: Math.max(0, Number(r.quantity) - Number(r.printed_qty)),
    }));
  }

  /**
   * What the badge shows. Two numbers, because they answer different questions: how
   * many things are waiting, and how much paper that is.
   */
  async summary({ store_id, store_ids } = {}) {
    const q = db('print_queue_items as pq')
      .where('pq.status', 'pending')
      .select(
        db.raw('COUNT(*)::int AS items'),
        db.raw('COALESCE(SUM(GREATEST(pq.quantity - pq.printed_qty, 0)), 0)::int AS labels')
      );
    applyStoreScope(q, 'pq.store_id', { store_id, store_ids });
    const [row] = await q;
    return { items: Number(row?.items || 0), labels: Number(row?.labels || 0) };
  }

  /**
   * Label payloads for a set of queue rows, ready for the print dialog.
   *
   * Reuses barcodes.service#labels so a label printed from the queue is byte-identical
   * to one printed from the product page — there is one definition of what a label
   * carries, and it lives there.
   *
   * `copies` is the queue's remaining count SUMMED across every selected row for that
   * variant, which is the whole reason this exists rather than the caller calling
   * /barcodes/labels directly: two boxes of the same shoe are two rows and one label
   * run. `queue_ids` names the rows that contributed, so marking them printed
   * afterwards needs no second lookup.
   */
  async labels({ ids, store_id, store_ids }) {
    if (!ids || ids.length === 0) return [];

    const q = db('print_queue_items as pq')
      .whereIn('pq.id', ids)
      .where('pq.status', 'pending')
      .select('pq.id', 'pq.variant_id', 'pq.store_id', 'pq.quantity', 'pq.printed_qty');
    applyStoreScope(q, 'pq.store_id', { store_id, store_ids });
    const queued = await q;
    if (queued.length === 0) return [];

    // The label's price is the BRANCH's price when the queue rows all belong to one
    // branch. Mixed branches fall back to the catalogue price rather than silently
    // picking one branch's override and printing it on the other branch's stock.
    const stores = [...new Set(queued.map((r) => r.store_id))];
    const priceStore = stores.length === 1 ? stores[0] : null;

    const variantIds = [...new Set(queued.map((r) => r.variant_id))];
    const rows = await barcodesService.labels({
      variant_ids: variantIds,
      store_id: priceStore,
      store_ids: priceStore ? undefined : store_ids,
    });

    const byVariant = new Map();
    for (const r of queued) {
      const remaining = Math.max(0, Number(r.quantity) - Number(r.printed_qty));
      const cur = byVariant.get(r.variant_id) || { copies: 0, queue_ids: [] };
      cur.copies += remaining;
      cur.queue_ids.push(r.id);
      byVariant.set(r.variant_id, cur);
    }

    return rows.map((r) => {
      const q2 = byVariant.get(r.variant_id) || { copies: 0, queue_ids: [] };
      return { ...r, copies: q2.copies, queue_ids: q2.queue_ids };
    });
  }

  /**
   * What a document put on the shelf, offered as a print run.
   *
   * Counted from `inventory_items` rather than from the document's own lines, because
   * inventory is what actually exists: a box whose quantities were edited after
   * completion, or an intake line that resolved to an existing variant, both give the
   * right answer here and the wrong one from the lines.
   */
  async sourceLines({ source_type, source_id, store_id, store_ids }) {
    if (!DOCUMENT_SOURCES.includes(source_type)) {
      throw new AppError('Specify a purchase box or a stock intake', 400);
    }

    // The DOCUMENT decides the branch, not the pairs it created.
    //
    // A pair can be transferred the same afternoon it is received, and its current
    // store_id then says where it is rather than where it was labelled. Reading the
    // branch off the items would split one print run across two branches and price the
    // labels for whichever happened to sort first. The document has exactly one
    // destination, so that is the answer.
    const doc = await this._sourceDoc(source_type, source_id);
    if (!doc) throw new AppError('That document no longer exists', 404);

    // Access is decided on the document's branch, for the same reason.
    const scope = { store_id, store_ids };
    if (!this._inScope(doc.store_id, scope)) {
      throw new AppError('Access denied: you are not assigned to this store', 403);
    }

    const column = source_type === 'purchase_box' ? 'invoice_box_id' : 'intake_id';
    const counts = await db('inventory_items')
      .where(column, source_id)
      .groupBy('variant_id')
      .select('variant_id')
      .count('* as c');

    if (counts.length === 0) {
      return { store_id: doc.store_id, source_ref: doc.ref, rows: [] };
    }

    const rows = await barcodesService.labels({
      variant_ids: counts.map((c) => c.variant_id),
      store_id: doc.store_id,
    });

    const qtyByVariant = new Map(counts.map((c) => [c.variant_id, Number(c.c)]));

    // Anything already sitting in the queue for this same document, so the dialog can
    // open showing what was queued before rather than looking like nothing happened.
    const existing = await db('print_queue_items')
      .where({ store_id: doc.store_id, source_type, source_id, status: 'pending' })
      .select('variant_id', 'quantity');
    const queuedByVariant = new Map(existing.map((e) => [e.variant_id, Number(e.quantity)]));

    return {
      store_id: doc.store_id,
      source_ref: doc.ref,
      rows: rows.map((r) => ({
        ...r,
        created_qty: qtyByVariant.get(r.variant_id) || 0,
        queued_qty: queuedByVariant.get(r.variant_id) || 0,
      })),
    };
  }

  /** The document's branch and its human number, so the queue says where a row came from. */
  async _sourceDoc(source_type, source_id) {
    if (source_type === 'purchase_box') {
      // Boxes are not numbered, so the reference is the invoice plus the product the
      // box held — which is what somebody standing at the printer would recognise.
      const box = await db('purchase_invoice_boxes as b')
        .leftJoin('purchase_invoices as i', 'i.id', 'b.invoice_id')
        .leftJoin('products as p', 'p.id', 'b.product_id')
        .where('b.id', source_id)
        .first('b.destination_store_id', 'i.invoice_number', 'p.product_code');
      if (!box || !box.destination_store_id) return null;
      const ref = [box.invoice_number, box.product_code].filter(Boolean).join(' · ');
      return { store_id: box.destination_store_id, ref: ref || null };
    }
    const intake = await db('stock_intakes').where('id', source_id).first('store_id', 'intake_number');
    if (!intake) return null;
    return { store_id: intake.store_id, ref: intake.intake_number || null };
  }

  /**
   * Does a resolved scope admit this branch?
   *
   * `resolveStoreScope` returns {} for somebody who sees everything, {store_id} for one
   * branch and {store_ids: []} for somebody with none — and that empty array must match
   * NOTHING, which is why it is tested before the "no restriction" case.
   */
  _inScope(storeId, { store_id, store_ids } = {}) {
    if (store_id) return store_id === storeId;
    if (Array.isArray(store_ids)) return store_ids.includes(storeId);
    return true;
  }

  // ------------------------------------------------------------------ writing

  /**
   * Put labels on the queue.
   *
   * @param {object}   payload
   * @param {string}   payload.store_id
   * @param {Array}    payload.items        [{ variant_id, quantity }]
   * @param {string}   payload.source_type  purchase_box | stock_intake | manual
   * @param {string}   [payload.source_id]
   * @param {string}   [payload.source_ref]
   * @param {string}   [payload.note]
   * @param {string}   userId
   */
  async add({ store_id, items, source_type = 'manual', source_id = null, source_ref = null, note = null }, userId) {
    if (!SOURCE_TYPES.includes(source_type)) {
      throw new AppError('Unknown print queue source', 400);
    }
    if (source_type !== 'manual' && !source_id) {
      throw new AppError('A document source needs its id', 400);
    }
    // A manual row has no document, and the pending-manual index keys on that being
    // NULL. Letting an id through on a manual add would quietly defeat the merge.
    if (source_type === 'manual') source_id = null;

    const wanted = (items || [])
      .map((i) => ({ variant_id: i.variant_id, quantity: Math.max(0, Number(i.quantity) || 0) }))
      .filter((i) => i.variant_id && i.quantity > 0);

    if (wanted.length === 0) {
      throw new AppError('Nothing to queue — every quantity was zero', 400);
    }

    // Collapse a list that names the same variant twice before it reaches the unique
    // index, which would otherwise reject the whole batch on a duplicate the caller
    // meant as "and this many more".
    const merged = new Map();
    for (const w of wanted) {
      merged.set(w.variant_id, (merged.get(w.variant_id) || 0) + w.quantity);
    }

    const variantIds = [...merged.keys()];
    const known = await db('product_variants').whereIn('id', variantIds).pluck('id');
    const missing = variantIds.filter((v) => !known.includes(v));
    if (missing.length) {
      throw new AppError(`${missing.length} of the items no longer exist`, 400);
    }

    const store = await db('stores').where('id', store_id).first('id');
    if (!store) throw new AppError('Branch not found', 404);

    return db.transaction(async (trx) => {
      // Serialises the whole read-then-write per branch. The two partial unique indexes
      // are the backstop; this is what stops two clicks a tenth of a second apart from
      // both deciding there was no existing row.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`print_queue:${store_id}`]);

      const now = new Date();
      const inserted = [];

      // RULE 1: a document REPLACES its own pending rows, so answering the prompt twice
      // leaves one set of labels rather than two.
      //
      // Reconciled row by row rather than deleted and re-inserted, because a delete
      // would throw away `printed_qty`. Somebody who queued 20, printed 6, then
      // re-opened the box and pressed Add would get a fresh row owing 20 — and print
      // those first 6 a second time. That is the same doubling this rule exists to
      // prevent, arriving through the back door.
      if (source_type !== 'manual') {
        await trx('print_queue_items')
          .where({ store_id, source_type, source_id, status: 'pending' })
          .whereNotIn('variant_id', [...merged.keys()])
          .del();
      }

      for (const [variant_id, quantity] of merged) {
        // The row this add merges into, if there is one: the branch's manual row, or
        // this document's own row for the same variant. Locked, because the advisory
        // lock above only serialises other adds — markPrinted and remove take the row
        // lock, and without FOR UPDATE here one of those could commit between this read
        // and the update below.
        const existing = await trx('print_queue_items')
          .where({ store_id, variant_id, status: 'pending' })
          .modify((q) => (source_type === 'manual'
            ? q.whereNull('source_id')
            : q.where({ source_type, source_id })))
          .forUpdate()
          .first();

        if (existing) {
          // Manual SUMS — pressing add twice by hand is asking for more labels. A
          // document REPLACES, and keeps what has already come off the printer.
          const nextQty = source_type === 'manual'
            ? Number(existing.quantity) + quantity
            : quantity;
          const printed = Math.min(Number(existing.printed_qty), nextQty);
          const [row] = await trx('print_queue_items')
            .where('id', existing.id)
            .update({
              quantity: nextQty,
              printed_qty: printed,
              // A row whose whole run has already been printed is finished, not owed.
              status: printed >= nextQty ? 'done' : 'pending',
              completed_at: printed >= nextQty ? now : null,
              completed_by: printed >= nextQty ? (userId || null) : null,
              note: note ?? existing.note,
              source_ref: source_ref ?? existing.source_ref,
              updated_at: now,
            })
            .returning('*');
          if (row) inserted.push(row);
          continue;
        }

        const [row] = await trx('print_queue_items')
          .insert({
            id: generateUUID(),
            store_id,
            variant_id,
            quantity,
            printed_qty: 0,
            status: 'pending',
            source_type,
            source_id,
            source_ref,
            note,
            added_by: userId || null,
            created_at: now,
            updated_at: now,
          })
          .returning('*');
        if (row) inserted.push(row);
      }

      return inserted;
    });
  }

  /** Add everything a purchase box or a stock intake put on the shelf. */
  async addFromSource({ source_type, source_id, items }, userId, scope = {}) {
    const preview = await this.sourceLines({ source_type, source_id, ...scope });
    if (!preview.rows.length) {
      throw new AppError('This document created no stock to label', 400);
    }

    // An explicit item list wins, because the dialog lets the operator drop sizes they
    // do not want labelled. It is filtered against what the document actually created,
    // so a request cannot attach labels for a size that never arrived.
    //
    // The COUNT is deliberately not capped at what arrived: a spare label for a box
    // that gets damaged is an ordinary thing to want, and the per-row ceiling of 999 in
    // the schema is the only bound on it.
    const allowed = new Map(preview.rows.map((r) => [r.variant_id, r.created_qty]));
    const chosen = (items && items.length)
      ? items
        .filter((i) => allowed.has(i.variant_id))
        .map((i) => ({ variant_id: i.variant_id, quantity: Number(i.quantity) || 0 }))
      : preview.rows.map((r) => ({ variant_id: r.variant_id, quantity: r.created_qty }));

    return this.add({
      store_id: preview.store_id,
      items: chosen,
      source_type,
      source_id,
      source_ref: preview.source_ref,
    }, userId);
  }

  async update(id, { quantity, note }, scope = {}) {
    const row = await this._own(id, scope);
    if (row.status !== 'pending') {
      throw new AppError('This row has already been printed. Queue it again instead.', 400);
    }

    const now = new Date();
    const patch = { updated_at: now };
    if (quantity != null) {
      const q = Math.max(0, Number(quantity) || 0);
      if (q === 0) throw new AppError('Use remove to take a row off the queue', 400);
      // A quantity cut below what has already come off the printer would leave the row
      // owing negative labels. Clamping the printed count instead keeps both honest.
      patch.quantity = q;
      const printed = Math.min(Number(row.printed_qty), q);
      patch.printed_qty = printed;

      // ...and the cut can finish the row. Cutting a run of 10 with 6 printed down to 6
      // means nothing is owed any more, and a row left `pending` owing zero is stuck
      // for good: it sits on the To-print list for ever, contributes 0 to the badge, and
      // marking it printed does nothing because there is nothing left to mark.
      if (printed >= q) {
        patch.status = 'done';
        patch.completed_at = now;
        patch.completed_by = row.completed_by || null;
      }
    }
    if (note !== undefined) patch.note = note;

    await db('print_queue_items').where('id', id).update(patch);
    return this.getById(id, scope);
  }

  /**
   * Record that labels came out of the printer.
   *
   * Nothing here can know whether they did — a browser cannot see a print dialog's
   * outcome, let alone the paper. So this is an explicit act by the person who watched
   * them come out, which is the only thing that is actually true.
   *
   * @param {Array<{id: string, quantity?: number}>} items
   */
  async markPrinted(items, userId, scope = {}) {
    const ids = items.map((i) => i.id).filter(Boolean);
    if (!ids.length) throw new AppError('Nothing selected', 400);

    const qtyById = new Map(items.map((i) => [i.id, i.quantity]));

    return db.transaction(async (trx) => {
      // Which branches these rows belong to, read WITHOUT a lock — only to learn which
      // advisory locks to take.
      //
      // The order matters and is the whole reason this is two reads. `add` takes the
      // branch lock and then locks the row it merges into; if this took the row lock
      // first and the branch lock second, the two would deadlock the moment they met.
      // Both paths now take the branch lock first, and branches in sorted order, so
      // there is no cycle to get stuck in.
      const idQuery = trx('print_queue_items').whereIn('id', ids).select('store_id');
      applyStoreScope(idQuery, 'print_queue_items.store_id', scope);
      const stores = [...new Set((await idQuery).map((r) => r.store_id))].sort();
      if (!stores.length) throw new AppError('Nothing found to mark', 404);
      for (const storeId of stores) {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`print_queue:${storeId}`]);
      }

      const q = trx('print_queue_items').whereIn('id', ids).forUpdate().select('*');
      applyStoreScope(q, 'print_queue_items.store_id', scope);
      const rows = await q;
      if (!rows.length) throw new AppError('Nothing found to mark', 404);

      const now = new Date();
      let labels = 0;
      let completed = 0;

      for (const row of rows) {
        if (row.status !== 'pending') continue;
        const remaining = Math.max(0, Number(row.quantity) - Number(row.printed_qty));
        const asked = qtyById.get(row.id);
        const n = asked == null ? remaining : Math.min(Math.max(0, Number(asked) || 0), remaining);
        if (n === 0) continue;

        const printed = Number(row.printed_qty) + n;
        const done = printed >= Number(row.quantity);
        await trx('print_queue_items').where('id', row.id).update({
          printed_qty: printed,
          status: done ? 'done' : 'pending',
          last_printed_at: now,
          completed_at: done ? now : null,
          completed_by: done ? (userId || null) : null,
          updated_at: now,
        });
        labels += n;
        if (done) completed++;
      }

      return { labels, completed, rows: rows.length };
    });
  }

  /** Put a finished row back on the queue, as a fresh manual request. */
  async requeue(id, userId, scope = {}) {
    const row = await this._own(id, scope);
    return this.add({
      store_id: row.store_id,
      items: [{ variant_id: row.variant_id, quantity: Number(row.quantity) }],
      // Manual, because it is a fresh decision by a person and must not replace the
      // original document's rows — but it keeps the document's reference, so the queue
      // still says which delivery these labels are for.
      source_type: 'manual',
      source_ref: row.source_ref || null,
      note: row.source_ref ? `Reprint — ${row.source_ref}` : 'Reprint',
    }, userId);
  }

  async remove(id, scope = {}) {
    await this._own(id, scope);
    await db('print_queue_items').where('id', id).del();
    return { id };
  }

  /**
   * Empty a list. Defaults to the printed one — clearing work that is still outstanding
   * is a different and more destructive thing, so it has to be asked for by name.
   */
  async clear({ status = 'done', store_id, store_ids }) {
    if (!['done', 'pending', 'cancelled'].includes(status)) {
      throw new AppError('Unknown status', 400);
    }
    const q = db('print_queue_items').where('status', status);
    applyStoreScope(q, 'print_queue_items.store_id', { store_id, store_ids });
    const removed = await q.del();
    return { removed };
  }

  async getById(id, scope = {}) {
    const row = await baseQuery(scope).where('pq.id', id).first();
    if (!row) throw new AppError('Queue row not found', 404);
    return {
      ...row,
      quantity: Number(row.quantity),
      printed_qty: Number(row.printed_qty),
      remaining: Math.max(0, Number(row.quantity) - Number(row.printed_qty)),
    };
  }

  /**
   * Fetch a row the caller is allowed to touch.
   *
   * Scope is applied in the WHERE, so a row in somebody else's branch is a 404 rather
   * than a 403 — telling an unassigned caller that a specific id exists is itself a
   * leak, and every other document in this system answers the same way.
   */
  async _own(id, scope = {}) {
    const q = db('print_queue_items').where('id', id);
    applyStoreScope(q, 'print_queue_items.store_id', scope);
    const row = await q.first();
    if (!row) throw new AppError('Queue row not found', 404);
    return row;
  }
}

module.exports = new PrintQueueService();
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.DOCUMENT_SOURCES = DOCUMENT_SOURCES;
