const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');

/**
 * Stock takes — counting the shelf and facing what the difference means.
 *
 * WHY THE EXPECTED NUMBER IS FROZEN
 *
 * `expected_qty` is written when the sheet is GENERATED and never recomputed. The shop
 * keeps trading while somebody walks around with a clipboard, so comparing Tuesday's
 * count against Thursday's stock reports two days of ordinary sales as shrinkage — a
 * number that would send an owner looking for a thief who does not exist.
 *
 * Everything after that is arithmetic on two frozen numbers.
 *
 * WHAT POSTING DOES
 *
 *   counted > expected → stock was found. New pairs are created, at the same cost the
 *                        rest of that variant carries, and marked as an ESTIMATED cost
 *                        because nobody knows what these particular ones cost.
 *   counted < expected → stock is missing. That many pairs move to status 'lost'.
 *
 * 'lost', not 'damaged': damaged stock is a real and different business number, and
 * merging the two hides both. And not deleted, because a sale line or this very count
 * may still refer to the row.
 *
 * A LINE LEFT BLANK IS NOT A ZERO
 *
 * `counted_qty` stays null until somebody types something. A blank line is skipped at
 * posting rather than treated as "none found" — otherwise generating a sheet for the
 * whole shop and counting one shelf would write off everything else in it.
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

class StockCountsService {
  // ================================================================
  //  BUILD THE SHEET
  // ================================================================

  /**
   * Snapshot what the system believes is on the shelf right now.
   *
   * Variants with zero stock are included when a scope was given: "the system thinks
   * you have none and you found three" is exactly the kind of thing a count is for.
   */
  async create(data, userId) {
    const id = generateUUID();

    await db.transaction(async (trx) => {
      const number = await generateDocumentNumber('SC', trx, 'stock_counts', 'count_number');
      await trx('stock_counts').insert({
        id,
        count_number: number,
        store_id: data.store_id,
        scope: data.scope || 'full',
        category_id: data.category_id || null,
        product_id: data.product_id || null,
        counted_at: data.counted_at || new Date().toISOString().slice(0, 10),
        notes: data.notes || null,
        status: 'draft',
        created_by: userId,
      });

      // One grouped count over the whole branch, not a query per variant.
      const held = trx('inventory_items as ii')
        .join('product_variants as pv', 'pv.id', 'ii.variant_id')
        .where('ii.store_id', data.store_id)
        .where('ii.status', 'in_stock')
        .groupBy('ii.variant_id')
        .select('ii.variant_id')
        .count('ii.id as qty');

      if (data.category_id) {
        held.join('products as p', 'p.id', 'pv.product_id').where('p.category_id', data.category_id);
      }
      if (data.product_id) held.where('pv.product_id', data.product_id);

      const rows = await held;
      if (rows.length === 0) {
        throw new AppError('There is no stock to count for that selection', 400);
      }

      await trx.batchInsert('stock_count_lines', rows.map((r) => ({
        id: generateUUID(),
        count_id: id,
        variant_id: r.variant_id,
        expected_qty: Number(r.qty),
        counted_qty: null,
      })), 500);
    });

    return this.getById(id);
  }

  /** Type what was actually on the shelf. A whole-set replace of the counted numbers. */
  async setCounts(id, lines) {
    const count = await db('stock_counts').where('id', id).first();
    if (!count) throw new AppError('Stock count not found', 404);
    if (count.status !== 'draft') {
      throw new AppError('This count has been posted and can no longer be edited', 400);
    }

    await db.transaction(async (trx) => {
      for (const line of lines) {
        const qty = line.counted_qty === null || line.counted_qty === undefined || line.counted_qty === ''
          ? null
          : parseInt(line.counted_qty, 10);
        if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
          throw new AppError('A counted quantity cannot be negative', 400);
        }
        await trx('stock_count_lines')
          .where({ count_id: id, variant_id: line.variant_id })
          .update({ counted_qty: qty, notes: line.notes || null });
      }
    });

    return this.getById(id);
  }

  /**
   * Add a variant the sheet did not list.
   *
   * Stock genuinely turns up that the system has never heard of — a pair that was
   * received against the wrong branch, or one that was written off by mistake. Expected
   * is zero, and the count records it as found.
   */
  async addLine(id, { variant_id, counted_qty, notes }) {
    const count = await db('stock_counts').where('id', id).first();
    if (!count) throw new AppError('Stock count not found', 404);
    if (count.status !== 'draft') throw new AppError('This count has been posted', 400);

    const existing = await db('stock_count_lines').where({ count_id: id, variant_id }).first();
    if (existing) throw new AppError('That item is already on this sheet', 409);

    const held = await db('inventory_items')
      .where({ variant_id, store_id: count.store_id, status: 'in_stock' })
      .count('id as n').first();

    await db('stock_count_lines').insert({
      id: generateUUID(),
      count_id: id,
      variant_id,
      expected_qty: Number(held.n) || 0,
      counted_qty: counted_qty ?? null,
      notes: notes || null,
    });
    return this.getById(id);
  }

  // ================================================================
  //  POST
  // ================================================================

  async post(id, userId) {
    let summary;

    await db.transaction(async (trx) => {
      const count = await trx('stock_counts').where('id', id).forUpdate().first();
      if (!count) throw new AppError('Stock count not found', 404);
      if (count.status === 'posted') throw new AppError('This count has already been posted', 400);
      if (count.status === 'cancelled') throw new AppError('This count was cancelled', 400);

      // Only lines somebody actually counted. A blank is "not counted", never "zero".
      const lines = await trx('stock_count_lines')
        .where('count_id', id)
        .whereNotNull('counted_qty');
      if (lines.length === 0) {
        throw new AppError('Nothing has been counted yet', 400);
      }

      let found = 0;
      let lost = 0;
      let matched = 0;
      let lostValue = 0;
      let foundValue = 0;

      for (const line of lines) {
        const variance = line.counted_qty - line.expected_qty;
        await trx('stock_count_lines').where('id', line.id).update({ variance });

        if (variance === 0) { matched++; continue; }

        if (variance < 0) {
          // Missing. Take the OLDEST pairs first, matching how the till hands them out,
          // so what is written off is what would have sold next.
          const doomed = await trx('inventory_items')
            .where({ variant_id: line.variant_id, store_id: count.store_id, status: 'in_stock' })
            .orderBy('created_at', 'asc')
            .limit(-variance)
            .forUpdate()
            .select('id', 'cost');

          if (doomed.length < -variance) {
            throw new AppError(
              `Only ${doomed.length} pair(s) are still in stock for one of these lines, `
              + `but the sheet says ${line.expected_qty}. Regenerate the count — the shelf `
              + 'has moved since this sheet was made.',
              409
            );
          }

          await trx('inventory_items')
            .whereIn('id', doomed.map((d) => d.id))
            .update({ status: 'lost', stock_count_id: id, updated_at: new Date() });

          lost += -variance;
          lostValue += doomed.reduce((n, d) => n + (Number(d.cost) || 0), 0);
        } else {
          // Found. Costed at what the rest of that variant costs in this branch; nobody
          // knows what these particular pairs cost, so it is flagged as an estimate and
          // healed by the next real invoice like any other guess.
          const sample = await trx('inventory_items')
            .where({ variant_id: line.variant_id, store_id: count.store_id })
            .orderBy('created_at', 'desc')
            .first('cost');
          const product = await trx('product_variants as pv')
            .join('products as p', 'p.id', 'pv.product_id')
            .where('pv.id', line.variant_id)
            .first('p.net_price');
          const cost = money(sample?.cost ?? product?.net_price ?? 0);

          const rows = [];
          for (let i = 0; i < variance; i++) {
            rows.push({
              id: generateUUID(),
              variant_id: line.variant_id,
              store_id: count.store_id,
              cost,
              cost_is_estimated: true,
              stock_count_id: id,
              source: 'manual',
              status: 'in_stock',
              notes: `Found during stock count ${count.count_number}`,
            });
          }
          await trx.batchInsert('inventory_items', rows, 500);
          found += variance;
          foundValue += cost * variance;
        }
      }

      await trx('stock_counts').where('id', id).update({
        status: 'posted',
        posted_by: userId,
        posted_at: new Date(),
        updated_at: new Date(),
      });

      summary = {
        counted_lines: lines.length,
        matched,
        found,
        lost,
        found_value: money(foundValue),
        lost_value: money(lostValue),
        net_value: money(foundValue - lostValue),
      };
    });

    const result = await this.getById(id);
    result.summary = summary;
    return result;
  }

  async cancel(id) {
    const count = await db('stock_counts').where('id', id).first();
    if (!count) throw new AppError('Stock count not found', 404);
    if (count.status === 'posted') {
      throw new AppError(
        'A posted count cannot be cancelled — the stock has already moved. '
        + 'Run another count to correct it.',
        400
      );
    }
    await db('stock_counts').where('id', id).update({ status: 'cancelled', updated_at: new Date() });
    return this.getById(id);
  }

  // ================================================================
  //  READ
  // ================================================================

  async list({ store_id, store_ids, status, limit } = {}) {
    const q = db('stock_counts as sc')
      .leftJoin('stores', 'stores.id', 'sc.store_id')
      .leftJoin('users as u', 'u.id', 'sc.created_by')
      .select('sc.*', 'stores.name as store_name', 'u.full_name as created_by_name')
      .orderBy('sc.created_at', 'desc')
      .limit(Math.min(200, parseInt(limit, 10) || 50));
    applyStoreScope(q, 'sc.store_id', { store_id, store_ids });
    if (status) q.where('sc.status', status);

    const rows = await q;
    if (rows.length === 0) return rows;

    const totals = await db('stock_count_lines')
      .whereIn('count_id', rows.map((r) => r.id))
      .groupBy('count_id')
      // All of it in one select(raw), not chained .count(raw(...)) — knex closes the
      // parenthesis for those itself, so a raw fragment carrying its own alias produces
      // `count(x) as y)` and the endpoint 500s. It has cost this codebase twice.
      .select(
        'count_id',
        db.raw('COUNT(id) as lines'),
        db.raw('COUNT(counted_qty) as counted'),
        db.raw('COALESCE(SUM(CASE WHEN variance < 0 THEN -variance ELSE 0 END), 0) as lost'),
        db.raw('COALESCE(SUM(CASE WHEN variance > 0 THEN variance ELSE 0 END), 0) as found')
      );

    const byId = new Map(totals.map((t) => [t.count_id, t]));
    for (const r of rows) {
      const t = byId.get(r.id);
      r.line_count = Number(t?.lines) || 0;
      r.counted_lines = Number(t?.counted) || 0;
      r.lost = Number(t?.lost) || 0;
      r.found = Number(t?.found) || 0;
    }
    return rows;
  }

  async getById(id, scope = {}) {
    const q = db('stock_counts as sc')
      .leftJoin('stores', 'stores.id', 'sc.store_id')
      .leftJoin('users as u', 'u.id', 'sc.created_by')
      .leftJoin('users as p', 'p.id', 'sc.posted_by')
      .leftJoin('product_categories as pc', 'pc.id', 'sc.category_id')
      .leftJoin('products as prod', 'prod.id', 'sc.product_id')
      .where('sc.id', id);
    applyStoreScope(q, 'sc.store_id', scope);

    const count = await q.first(
      'sc.*', 'stores.name as store_name', 'u.full_name as created_by_name',
      'p.full_name as posted_by_name', 'pc.name_en as category_name',
      'prod.model_name as product_name'
    );
    if (!count) throw new AppError('Stock count not found', 404);

    count.lines = await db('stock_count_lines as l')
      .join('product_variants as pv', 'pv.id', 'l.variant_id')
      .join('products as p', 'p.id', 'pv.product_id')
      .join('product_colors as pc', 'pc.id', 'pv.product_color_id')
      .leftJoin('product_categories as cat', 'cat.id', 'p.category_id')
      .leftJoin('size_scales as ss', 'ss.id', 'cat.size_scale_id')
      .leftJoin('size_scale_values as sv', function () {
        this.on('sv.scale_id', '=', 'ss.id').andOn('sv.value', '=', 'pv.size_eu');
      })
      .where('l.count_id', id)
      .orderBy('p.product_code')
      .orderBy('pc.color_name')
      .orderBy(['pv.size_sort', 'pv.size_eu'])
      .select(
        'l.*',
        'pv.sku', 'pv.size_eu', 'pv.barcode',
        'p.id as product_id', 'p.product_code', 'p.model_name as product_name',
        'pc.color_name', 'pc.is_placeholder as color_is_placeholder',
        'cat.has_sizes', 'ss.display_prefix as size_prefix',
        'sv.label_en as size_label_en', 'sv.label_ar as size_label_ar'
      );

    count.totals = count.lines.reduce((acc, l) => {
      const counted = l.counted_qty !== null && l.counted_qty !== undefined;
      const variance = counted ? l.counted_qty - l.expected_qty : 0;
      return {
        lines: acc.lines + 1,
        counted: acc.counted + (counted ? 1 : 0),
        expected: acc.expected + l.expected_qty,
        found: acc.found + (variance > 0 ? variance : 0),
        lost: acc.lost + (variance < 0 ? -variance : 0),
      };
    }, { lines: 0, counted: 0, expected: 0, found: 0, lost: 0 });

    return count;
  }
}

module.exports = new StockCountsService();
