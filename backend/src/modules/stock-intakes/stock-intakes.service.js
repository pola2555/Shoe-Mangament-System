const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const {
  categoryOfProduct,
  ensurePlaceholderColor,
  resolveVariantTarget,
  generateSku,
} = require('../../utils/variantIdentity');
const { revertCostCorrection } = require('../../utils/costCorrection');
const barcodesService = require('../barcodes/barcodes.service');

/**
 * Stock intakes — putting stock into a shop without inventing a supplier invoice.
 *
 * A shop adopting the system already owns what is on its shelves. Typing years of
 * purchase invoices to describe stock that is already there is not practical, and the
 * invoices would be fiction: they would create supplier debts that were never owed.
 *
 * So an intake creates stock and nothing else. No payable, no supplier balance, no
 * effect on purchase reports. The supplier on the sheet is a note about where the goods
 * are believed to have come from, and is used to find a better cost estimate.
 *
 * DRAFT / POSTED
 *
 * A sheet is typed as a draft and changes nothing. Posting is the moment stock exists.
 * The split is what makes a 300-pair count reviewable before it lands, and it is why
 * `post` is a separate call rather than a side effect of saving.
 *
 * REVERSING
 *
 * A posted sheet can be reversed only while every pair it created is still in stock in
 * the shop it was posted to. Once one has been sold or moved, reversing would have to
 * unpick a sale, which is what `sales.void` is for.
 *
 * THE VARIANT PATH IS THE SAME ONE PURCHASES USE
 *
 * `resolveVariantTarget` / `generateSku` / `ensurePlaceholderColor` / barcode minting —
 * all shared with `purchases.completeBox`, so a pair that arrives on an intake is
 * indistinguishable from one that arrived on an invoice. Anything else and a colourless
 * knife or a word-sized sock would behave differently depending on how it got here.
 */

const REASONS = ['opening', 'count', 'found', 'damaged'];
const MAX_PAGE_SIZE = 200;

class StockIntakesService {
  // ================================================================
  //  READ
  // ================================================================

  _baseQuery({ store_id, store_ids, status, reason, from, to, search }) {
    const q = db('stock_intakes as si')
      .leftJoin('stores', 'stores.id', 'si.store_id')
      .leftJoin('suppliers', 'suppliers.id', 'si.supplier_id')
      .leftJoin('users as creator', 'creator.id', 'si.created_by');

    applyStoreScope(q, 'si.store_id', { store_id, store_ids });
    if (status) q.where('si.status', status);
    if (reason) q.where('si.reason', reason);
    if (from) q.where('si.intake_date', '>=', from);
    if (to) q.where('si.intake_date', '<=', to);
    if (search) {
      q.where((b) => b
        .where('si.intake_number', 'ilike', `%${search}%`)
        .orWhere('si.notes', 'ilike', `%${search}%`)
        .orWhere('suppliers.name', 'ilike', `%${search}%`));
    }
    return q;
  }

  async list(filters = {}) {
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(filters.limit, 10) || 50));

    const [{ count }] = await this._baseQuery(filters).clone().count('si.id as count');

    const rows = await this._baseQuery(filters)
      .select(
        'si.*',
        'stores.name as store_name',
        'suppliers.name as supplier_name',
        'creator.full_name as created_by_name'
      )
      .orderBy('si.intake_date', 'desc')
      .orderBy('si.created_at', 'desc')
      .limit(limit)
      .offset((page - 1) * limit);

    // One grouped aggregate rather than two queries per sheet.
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const totals = await db('stock_intake_lines')
        .whereIn('intake_id', ids)
        .groupBy('intake_id')
        .select(
          'intake_id',
          db.raw('SUM(quantity) as units'),
          db.raw('SUM(quantity * unit_cost) as value'),
          db.raw('SUM(CASE WHEN cost_is_estimated THEN quantity ELSE 0 END) as estimated_units')
        );
      const byId = new Map(totals.map((t) => [t.intake_id, t]));
      for (const r of rows) {
        const t = byId.get(r.id);
        r.total_units = Number(t?.units) || 0;
        r.total_value = Math.round((Number(t?.value) || 0) * 100) / 100;
        r.estimated_units = Number(t?.estimated_units) || 0;
      }
    }

    return { data: rows, total: Number(count), page, limit };
  }

  async getById(id, { store_id, store_ids } = {}) {
    const q = db('stock_intakes as si')
      .leftJoin('stores', 'stores.id', 'si.store_id')
      .leftJoin('suppliers', 'suppliers.id', 'si.supplier_id')
      .leftJoin('users as creator', 'creator.id', 'si.created_by')
      .leftJoin('users as poster', 'poster.id', 'si.posted_by')
      .where('si.id', id);
    applyStoreScope(q, 'si.store_id', { store_id, store_ids });

    const intake = await q.first(
      'si.*',
      'stores.name as store_name',
      'suppliers.name as supplier_name',
      'creator.full_name as created_by_name',
      'poster.full_name as posted_by_name'
    );
    if (!intake) throw new AppError('Stock intake not found', 404);

    intake.lines = await db('stock_intake_lines as l')
      .leftJoin('products', 'products.id', 'l.product_id')
      .leftJoin('product_colors', 'product_colors.id', 'l.product_color_id')
      .leftJoin('product_categories as pc', 'pc.id', 'products.category_id')
      .leftJoin('size_scales as ss', 'ss.id', 'pc.size_scale_id')
      .leftJoin('size_scale_values as sv', function () {
        this.on('sv.scale_id', '=', 'ss.id').andOn('sv.value', '=', 'l.size_eu');
      })
      .where('l.intake_id', id)
      .orderBy('products.product_code')
      .orderBy('product_colors.color_name')
      .orderBy('l.created_at')
      .select(
        'l.*',
        'products.product_code',
        'products.model_name as product_name',
        'products.default_selling_price',
        'product_colors.color_name',
        'product_colors.is_placeholder as color_is_placeholder',
        'pc.has_sizes',
        'pc.name_en as category_name_en',
        'ss.display_prefix as size_prefix',
        'sv.label_en as size_label_en',
        'sv.label_ar as size_label_ar'
      );

    intake.total_units = intake.lines.reduce((n, l) => n + Number(l.quantity), 0);
    intake.total_value = Math.round(
      intake.lines.reduce((n, l) => n + Number(l.quantity) * Number(l.unit_cost), 0) * 100
    ) / 100;
    intake.estimated_units = intake.lines
      .filter((l) => l.cost_is_estimated)
      .reduce((n, l) => n + Number(l.quantity), 0);

    return intake;
  }

  // ================================================================
  //  WRITE — the sheet
  // ================================================================

  async create(data, userId) {
    if (!REASONS.includes(data.reason || 'opening')) {
      throw new AppError('Unknown intake reason', 400);
    }
    const id = generateUUID();
    await db.transaction(async (trx) => {
      const number = await generateDocumentNumber('SI', trx, 'stock_intakes', 'intake_number');
      await trx('stock_intakes').insert({
        id,
        intake_number: number,
        store_id: data.store_id,
        supplier_id: data.supplier_id || null,
        reason: data.reason || 'opening',
        status: 'draft',
        intake_date: data.intake_date,
        notes: data.notes || null,
        created_by: userId,
      });
      if (data.lines?.length) await this._replaceLines(trx, id, data.lines);
    });
    return this.getById(id);
  }

  async update(id, data) {
    const intake = await db('stock_intakes').where('id', id).first();
    if (!intake) throw new AppError('Stock intake not found', 404);
    if (intake.status !== 'draft') {
      throw new AppError(
        `This sheet is ${intake.status} and can no longer be edited. Reverse it first if it is wrong.`,
        400
      );
    }
    if (data.reason && !REASONS.includes(data.reason)) {
      throw new AppError('Unknown intake reason', 400);
    }

    await db.transaction(async (trx) => {
      const safe = { updated_at: new Date() };
      for (const f of ['store_id', 'supplier_id', 'reason', 'intake_date', 'notes']) {
        if (data[f] !== undefined) safe[f] = data[f] || null;
      }
      await trx('stock_intakes').where('id', id).update(safe);
      // A whole-set replace, like setBoxItems: reordering and removing lines is then one
      // transaction rather than a diff the client has to compute.
      if (data.lines !== undefined) await this._replaceLines(trx, id, data.lines);
    });
    return this.getById(id);
  }

  async _replaceLines(trx, intakeId, lines) {
    await trx('stock_intake_lines').where('intake_id', intakeId).del();
    if (!lines.length) return;

    const rows = lines.map((l) => {
      const quantity = parseInt(l.quantity, 10);
      if (!Number.isFinite(quantity) || quantity < 1) {
        throw new AppError('Every line needs a quantity of at least 1', 400);
      }
      const unitCost = Number(l.unit_cost);
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new AppError('Every line needs a cost. Use the margin fill if you are estimating.', 400);
      }
      return {
        id: generateUUID(),
        intake_id: intakeId,
        product_id: l.product_id,
        product_color_id: l.product_color_id || null,
        size_eu: l.size_eu || null,
        quantity,
        unit_cost: Math.round(unitCost * 100) / 100,
        // Defaults to a guess. The owner ticks the ones they actually know, and those
        // are then treated exactly like an invoiced cost — never healed, never restated.
        cost_is_estimated: l.cost_is_estimated !== false,
        notes: l.notes || null,
      };
    });
    await trx.batchInsert('stock_intake_lines', rows, 500);
  }

  async delete(id) {
    const intake = await db('stock_intakes').where('id', id).first();
    if (!intake) throw new AppError('Stock intake not found', 404);
    if (intake.status !== 'draft') {
      throw new AppError('Only a draft can be deleted. Reverse a posted sheet instead.', 400);
    }
    await db('stock_intakes').where('id', id).del();
  }

  // ================================================================
  //  POST — the moment stock exists
  // ================================================================

  async post(id, userId) {
    await db.transaction(async (trx) => {
      // Locked and re-read inside the transaction: two people pressing Post at the same
      // moment would otherwise both pass the status check and create the stock twice —
      // the exact failure `purchases.completeBox` was fixed for.
      const intake = await trx('stock_intakes').where('id', id).forUpdate().first();
      if (!intake) throw new AppError('Stock intake not found', 404);
      if (intake.status === 'posted') throw new AppError('This sheet has already been posted', 400);
      if (intake.status === 'cancelled') throw new AppError('This sheet was cancelled', 400);

      const lines = await trx('stock_intake_lines').where('intake_id', id);
      if (lines.length === 0) throw new AppError('Add at least one line before posting', 400);

      const inventoryRows = [];
      const productCache = new Map();
      const categoryCache = new Map();

      for (const line of lines) {
        if (!productCache.has(line.product_id)) {
          const p = await trx('products').where('id', line.product_id).first();
          if (!p) throw new AppError('A product on this sheet no longer exists', 400);
          productCache.set(line.product_id, p);
          categoryCache.set(line.product_id, await categoryOfProduct(trx, line.product_id));
        }
        const product = productCache.get(line.product_id);
        const category = categoryCache.get(line.product_id);

        let colorId = line.product_color_id;
        if (!colorId) {
          if (category.has_colors) {
            throw new AppError(`${product.product_code}: pick a colour before posting`, 400);
          }
          colorId = (await ensurePlaceholderColor(trx, line.product_id, category)).id;
        }

        // allowOffScale, for the same reason receiving stock allows it: refusing to
        // record stock that is physically on the shelf because its size is not on a
        // list helps nobody.
        const target = await resolveVariantTarget(
          trx, product, { product_color_id: colorId, size_eu: line.size_eu }, category,
          { allowOffScale: true }
        );

        let variant = await trx('product_variants')
          .where({
            product_id: line.product_id,
            product_color_id: target.color.id,
            size_eu: target.size_eu,
          })
          .first();

        if (!variant) {
          const sku = await generateSku(trx, product, target.color, target.size_eu);
          [variant] = await trx('product_variants').insert({
            id: generateUUID(),
            product_id: line.product_id,
            product_color_id: target.color.id,
            size_eu: target.size_eu,
            size_sort: target.size_sort,
            size_scale_value_id: target.size_scale_value_id,
            sku,
          }).returning('*');
        }

        // Old stock needs labels more than new stock does — it has never had any.
        await barcodesService.assignForVariant(variant.id, trx);

        await trx('stock_intake_lines').where('id', line.id).update({ variant_id: variant.id });

        for (let i = 0; i < line.quantity; i++) {
          inventoryRows.push({
            id: generateUUID(),
            variant_id: variant.id,
            store_id: intake.store_id,
            cost: line.unit_cost,
            cost_is_estimated: line.cost_is_estimated,
            intake_id: intake.id,
            source: 'manual',
            status: 'in_stock',
          });
        }
      }

      await trx.batchInsert('inventory_items', inventoryRows, 500);

      await trx('stock_intakes').where('id', id).update({
        status: 'posted',
        posted_by: userId,
        posted_at: new Date(),
        updated_at: new Date(),
      });
    });

    return this.getById(id);
  }

  /**
   * Undo a posted sheet.
   *
   * Only while every pair it created is untouched. A sheet whose stock has started
   * selling cannot be unwound here without unpicking sales, and `sales.void` is the
   * tool for that — so this refuses and says how many have gone.
   *
   * `reopen` decides where it lands: false retires the sheet (cancelled); true removes
   * the stock but keeps the typed lines and returns it to an editable DRAFT, so a wrong
   * quantity or cost can be corrected and the sheet posted again instead of retyped.
   */
  async reverse(id, reason, userId, reopen = false) {
    await db.transaction(async (trx) => {
      const intake = await trx('stock_intakes').where('id', id).forUpdate().first();
      if (!intake) throw new AppError('Stock intake not found', 404);
      if (intake.status !== 'posted') {
        throw new AppError('Only a posted sheet can be reversed', 400);
      }

      const items = await trx('inventory_items').where('intake_id', id).forUpdate();
      const moved = items.filter((i) => i.status !== 'in_stock' || i.store_id !== intake.store_id);
      if (moved.length) {
        throw new AppError(
          `${moved.length} of the ${items.length} pairs on this sheet have already been sold, transferred or written off. `
          + 'Void those sales first, or leave the sheet as it is.',
          400
        );
      }

      // A pair that was sold and then VOIDED is back in stock, so the check above lets
      // it through — but the voided sale still has a line pointing at it, deliberately,
      // as the record of what happened. Deleting the pair would either orphan that line
      // or be refused by the database with a bare foreign-key error. Refuse here
      // instead, and say why.
      if (items.length) {
        const onASale = await trx('sale_items')
          .whereIn('inventory_item_id', items.map((i) => i.id))
          .countDistinct('inventory_item_id as n')
          .first();
        if (Number(onASale.n) > 0) {
          throw new AppError(
            `${onASale.n} pair(s) from this sheet appear on a sale, including cancelled ones. `
            + 'That sale is a record of what happened and still refers to them, so the sheet '
            + 'can no longer be reversed.',
            400
          );
        }
      }

      // A corrected pair means a reported month has already moved because of this
      // stock. Deleting it would leave the correction log pointing at nothing.
      const corrected = await trx('cost_corrections')
        .whereIn('inventory_item_id', items.map((i) => i.id))
        .whereNull('reverted_at')
        .first();
      if (corrected) {
        throw new AppError(
          'The costs on this sheet have since been corrected by a real invoice. '
          + 'Undo that correction first if this sheet is wrong.',
          400
        );
      }

      if (items.length) {
        await trx('inventory_items').whereIn('id', items.map((i) => i.id)).del();
      }

      if (reopen) {
        // Back to a draft, lines intact: it can be corrected and posted again.
        await trx('stock_intakes').where('id', id).update({
          status: 'draft',
          posted_by: null,
          posted_at: null,
          updated_at: new Date(),
        });
      } else {
        await trx('stock_intakes').where('id', id).update({
          status: 'cancelled',
          cancelled_by: userId,
          cancelled_at: new Date(),
          cancel_reason: reason || null,
          updated_at: new Date(),
        });
      }
    });

    return this.getById(id);
  }

  // ================================================================
  //  COSTING HELP
  // ================================================================

  /**
   * The best cost we can offer for a product, and where it came from.
   *
   * In order of trustworthiness:
   *   1. a completed purchase box — a real invoiced cost for this exact product
   *   2. products.net_price — the last invoiced cost the catalogue recorded
   *   3. nothing, and the caller falls back to the margin fill
   *
   * A number from a real invoice beats any guess from a selling price, which is why
   * this is asked for first and the margin is only the fallback.
   */
  async costHint(productId, { store_id, store_ids } = {}) {
    const product = await db('products').where('id', productId).first(
      'id', 'product_code', 'model_name', 'net_price', 'default_selling_price'
    );
    if (!product) throw new AppError('Product not found', 404);

    const boxQuery = db('purchase_invoice_boxes as b')
      .join('purchase_invoices as pi', 'pi.id', 'b.invoice_id')
      .where('b.product_id', productId)
      .where('b.detail_status', 'complete')
      .whereNotNull('b.cost_per_item')
      .orderBy('pi.invoice_date', 'desc')
      .orderBy('b.created_at', 'desc');
    applyStoreScope(boxQuery, 'b.destination_store_id', { store_id, store_ids });

    const lastBox = await boxQuery.first(
      'b.cost_per_item', 'pi.invoice_number', 'pi.invoice_date'
    );

    if (lastBox) {
      return {
        product_id: productId,
        unit_cost: Number(lastBox.cost_per_item),
        cost_is_estimated: false,
        source: 'purchase',
        source_label: lastBox.invoice_number,
        invoice_date: lastBox.invoice_date,
        default_selling_price: product.default_selling_price,
      };
    }

    if (product.net_price != null && Number(product.net_price) > 0) {
      return {
        product_id: productId,
        unit_cost: Number(product.net_price),
        cost_is_estimated: false,
        source: 'catalogue',
        source_label: product.product_code,
        default_selling_price: product.default_selling_price,
      };
    }

    return {
      product_id: productId,
      unit_cost: null,
      cost_is_estimated: true,
      source: 'none',
      default_selling_price: product.default_selling_price,
    };
  }

  // ================================================================
  //  WHAT IS STILL A GUESS
  // ================================================================

  /**
   * Products still carrying guessed costs.
   *
   * Some old stock is discontinued and will never be bought again, so its guess is
   * permanent — this is the screen that stops those quietly disappearing from view.
   * Sold pairs are counted too: their guess is already inside a reported profit figure.
   */
  async estimatedSummary({ store_id, store_ids } = {}) {
    const q = db('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .join('products as p', 'p.id', 'pv.product_id')
      .where('ii.cost_is_estimated', true)
      .groupBy('p.id', 'p.product_code', 'p.model_name', 'p.brand', 'p.default_selling_price')
      .select(
        'p.id as product_id',
        'p.product_code',
        'p.model_name as product_name',
        'p.brand',
        'p.default_selling_price'
      )
      .count('ii.id as pairs')
      .sum('ii.cost as guessed_value')
      .min('ii.cost as min_cost')
      .max('ii.cost as max_cost')
      .countDistinct('ii.store_id as stores')
      .orderByRaw('COUNT(ii.id) DESC')
      .limit(500);
    applyStoreScope(q, 'ii.store_id', { store_id, store_ids });

    const rows = await q;

    // How many of each product's guessed pairs have already gone out the door — those
    // are the ones sitting inside a profit figure the owner has already read.
    const soldQ = db('sale_items as si')
      .join('inventory_items as ii', 'ii.id', 'si.inventory_item_id')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .join('sales as s', 's.id', 'si.sale_id')
      .where('si.cost_is_estimated', true)
      .whereNull('s.voided_at')
      .groupBy('pv.product_id')
      .select('pv.product_id')
      .count('si.id as sold_pairs');
    applyStoreScope(soldQ, 's.store_id', { store_id, store_ids });

    const sold = new Map((await soldQ).map((r) => [r.product_id, Number(r.sold_pairs)]));

    return rows.map((r) => ({
      ...r,
      pairs: Number(r.pairs),
      stores: Number(r.stores),
      guessed_value: Math.round((Number(r.guessed_value) || 0) * 100) / 100,
      min_cost: Number(r.min_cost),
      max_cost: Number(r.max_cost),
      sold_pairs: sold.get(r.product_id) || 0,
    }));
  }

  /**
   * Set a guessed cost by hand.
   *
   * For stock that will never be bought again, this is the only way the guess ever
   * improves. Marking it "known" retires it from healing altogether — from then on it
   * is history like any invoiced cost.
   */
  async recost(productId, { unit_cost, still_estimated = true, store_id, store_ids }, userId) {
    const cost = Number(unit_cost);
    if (!Number.isFinite(cost) || cost < 0) throw new AppError('A cost is required', 400);

    return db.transaction(async (trx) => {
      const q = trx('inventory_items as ii')
        .join('product_variants as pv', 'pv.id', 'ii.variant_id')
        .where('pv.product_id', productId)
        .where('ii.cost_is_estimated', true);
      applyStoreScope(q, 'ii.store_id', { store_id, store_ids });

      const pairs = await q.forUpdate('ii').select('ii.id', 'ii.cost');
      if (pairs.length === 0) {
        throw new AppError('This product has no pairs with a guessed cost', 404);
      }

      const ids = pairs.map((p) => p.id);
      const soldLines = await trx('sale_items')
        .join('sales', 'sales.id', 'sale_items.sale_id')
        .whereIn('sale_items.inventory_item_id', ids)
        .select(
          'sale_items.id',
          'sale_items.cost_at_sale',
          'sale_items.inventory_item_id',
          trx.raw('sales.created_at::date as sale_date')
        );

      // Logged like any other correction, because it moves the same reported figures —
      // and so it can be undone the same way.
      const batchId = generateUUID();
      const log = [];
      const linesByPair = new Map();
      for (const l of soldLines) {
        if (!linesByPair.has(l.inventory_item_id)) linesByPair.set(l.inventory_item_id, []);
        linesByPair.get(l.inventory_item_id).push(l);
      }
      for (const pair of pairs) {
        const lines = linesByPair.get(pair.id) || [];
        const base = {
          batch_id: batchId,
          inventory_item_id: pair.id,
          product_id: productId,
          new_cost: cost,
          source_invoice_number: 'manual re-cost',
          applied_by: userId,
        };
        if (lines.length === 0) {
          log.push({ id: generateUUID(), ...base, sale_item_id: null, old_cost: pair.cost, sale_date: null });
        } else {
          for (const l of lines) {
            log.push({
              id: generateUUID(), ...base,
              sale_item_id: l.id, old_cost: l.cost_at_sale, sale_date: l.sale_date,
            });
          }
        }
      }
      await trx.batchInsert('cost_corrections', log, 500);

      await trx('inventory_items').whereIn('id', ids).update({
        cost, cost_is_estimated: !!still_estimated, updated_at: new Date(),
      });
      if (soldLines.length) {
        await trx('sale_items').whereIn('id', soldLines.map((l) => l.id)).update({
          cost_at_sale: cost, cost_is_estimated: !!still_estimated,
        });
      }

      return {
        batch_id: batchId,
        pairs: pairs.length,
        sold_pairs: soldLines.length,
        new_cost: cost,
        still_estimated: !!still_estimated,
      };
    });
  }

  // ================================================================
  //  CORRECTIONS
  // ================================================================

  /** Correction batches, newest first, so a notification has somewhere to link to. */
  async listCorrections({ product_id, limit } = {}) {
    const q = db('cost_corrections as cc')
      .leftJoin('products as p', 'p.id', 'cc.product_id')
      .leftJoin('users as u', 'u.id', 'cc.applied_by')
      .groupBy('cc.batch_id', 'p.product_code', 'p.model_name', 'u.full_name')
      .select(
        'cc.batch_id',
        'p.product_code',
        'p.model_name as product_name',
        'u.full_name as applied_by_name'
      )
      .min('cc.applied_at as applied_at')
      .max('cc.reverted_at as reverted_at')
      .min('cc.old_cost as old_cost_min')
      .max('cc.old_cost as old_cost_max')
      .max('cc.new_cost as new_cost')
      .max('cc.source_invoice_number as source_invoice_number')
      .countDistinct('cc.inventory_item_id as pairs')
      .count('cc.sale_item_id as sold_pairs')
      .min('cc.sale_date as first_sale_date')
      .max('cc.sale_date as last_sale_date')
      .orderByRaw('MIN(cc.applied_at) DESC')
      .limit(Math.min(200, parseInt(limit, 10) || 50));

    if (product_id) q.where('cc.product_id', product_id);

    return (await q).map((r) => ({
      ...r,
      pairs: Number(r.pairs),
      sold_pairs: Number(r.sold_pairs),
      old_cost_min: Number(r.old_cost_min),
      old_cost_max: Number(r.old_cost_max),
      new_cost: Number(r.new_cost),
      reverted: !!r.reverted_at,
    }));
  }

  async revertCorrection(batchId, userId) {
    const any = await db('cost_corrections').where('batch_id', batchId).first();
    if (!any) throw new AppError('Correction not found', 404);
    return db.transaction((trx) => revertCostCorrection(trx, batchId, userId));
  }
}

module.exports = new StockIntakesService();
module.exports.REASONS = REASONS;
