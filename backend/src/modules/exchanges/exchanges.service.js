const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const salesService = require('../sales/sales.service');
const returnsService = require('../returns/returns.service');

/**
 * Exchanges — a customer brings something back and takes something else.
 *
 * WHY THIS IS NOT A NEW KIND OF DOCUMENT
 *
 * An exchange really is two things that already exist: a return (goods come back, stock
 * goes back on the shelf, the original sale is credited) and a sale (goods go out, cost
 * is captured, profit is recorded). Writing a third path for stock movement would mean
 * a third place that has to remember the price band, the cost snapshot, the shift link
 * and the void rules — and this codebase has already paid for that mistake once, with
 * three disagreeing definitions of "supplier balance".
 *
 * So `exchanges` is a LINK over the two, plus the money difference. Both run inside one
 * transaction, so a customer can never end up refunded but not re-served, or re-served
 * but not refunded.
 *
 * A DIFFERENT SIZE OR A COMPLETELY DIFFERENT PRODUCT
 *
 * Both, with no special case: the outgoing side is an ordinary list of inventory items.
 * Swapping a 42 for a 43 and swapping a shoe for a belt are the same operation with
 * different rows.
 *
 * THE DIFFERENCE
 *
 *     difference = value going out − value coming back
 *
 * Positive, the customer pays; negative, they are owed. Zero is the common case and
 * needs no money to move at all, which is why `settlement` may be 'none'.
 *
 * A reason is optional on purpose. Most exchanges are "wrong size" and forcing a
 * dropdown produces a column full of whatever was first in the list.
 */

const SETTLEMENTS = ['cash', 'card', 'bank_transfer', 'instapay', 'vodafone_cash', 'account', 'none'];
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

class ExchangesService {
  async create(data, user) {
    const exchangeId = generateUUID();
    let result;

    await db.transaction(async (trx) => {
      const original = await trx('sales').where('id', data.original_sale_id).forUpdate().first();
      if (!original) throw new AppError('The original sale was not found', 404);
      if (original.voided_at) {
        throw new AppError('That sale was cancelled, so there is nothing to exchange', 400);
      }

      // ---- 1. what comes back -------------------------------------------------
      // Refund value defaults to what the line was actually sold for, net of any
      // discount already allocated to it. Taking sale_price alone would refund more
      // than the customer paid on a discounted sale.
      const lines = await trx('sale_items')
        .whereIn('id', data.returned.map((r) => r.sale_item_id))
        .where('sale_id', original.id);
      if (lines.length !== data.returned.length) {
        throw new AppError('One of the returned items does not belong to that sale', 400);
      }

      const saleTotal = money(original.total_amount);
      const saleDiscount = money(original.discount_amount);
      const byId = new Map(lines.map((l) => [l.id, l]));

      const returnItems = data.returned.map((r) => {
        const line = byId.get(r.sale_item_id);
        const gross = money(line.sale_price);
        // Pro-rata share of the sale-level discount, the same allocation the profit
        // expressions use — so a refund and a report never disagree about what a line
        // was worth.
        const share = saleTotal > 0 ? money((saleDiscount * gross) / saleTotal) : 0;
        const suggested = money(gross - share);
        const amount = r.refund_amount !== undefined && r.refund_amount !== null
          ? money(r.refund_amount)
          : suggested;
        if (amount < 0) throw new AppError('A refund amount cannot be negative', 400);
        if (amount > suggested + 0.01) {
          throw new AppError(
            `That line was sold for ${suggested} EGP after its share of the discount; `
            + `${amount} cannot be refunded against it.`,
            400
          );
        }
        return { sale_item_id: r.sale_item_id, refund_amount: amount };
      });

      const returnedValue = money(returnItems.reduce((n, r) => n + r.refund_amount, 0));

      const ret = await returnsService.createCustomerReturn({
        sale_id: original.id,
        store_id: data.store_id,
        // The refund is settled inside the exchange, so the return itself moves no
        // money on its own — 'exchange' is the honest method name for that.
        refund_method: 'exchange',
        reason: data.reason || 'Exchange',
        notes: data.notes || null,
        items: returnItems,
        created_by: user.id,
      }, trx);

      // ---- 2. what goes out ---------------------------------------------------
      // The ordinary checkout path: stock lock, price band, who-may-price, cost
      // snapshot, shift link. Nothing about exchanges is special here.
      const newSale = await salesService.create({
        store_id: data.store_id,
        customer_id: original.customer_id || data.customer_id || null,
        items: data.new_items,
        discount_amount: 0,
        discount_request_id: data.discount_request_id,
        seller_code: data.seller_code,
        sold_by: data.sold_by,
        notes: `Exchange against ${original.sale_number}`,
        // Payments are attached below, once the difference is known, so the sale total
        // and what changed hands cannot disagree.
        payments: [],
      }, user, trx, { settledByCaller: true });

      const created = await trx('sales').where('id', newSale.id).first();
      const newValue = money(created.final_amount);
      const difference = money(newValue - returnedValue);

      // ---- 3. the money -------------------------------------------------------
      // The customer pays the difference now, or takes the goods on account. The
      // walk-in rule that applies to any credit sale applies here too.
      if (difference > 0.01) {
        const settlement = data.settlement || 'cash';
        if (settlement === 'account') {
          if (!created.customer_id) {
            throw new AppError(
              'A walk-in must pay the difference. Add the customer to put it on account.',
              400
            );
          }
        } else {
          if (!SETTLEMENTS.includes(settlement) || settlement === 'none') {
            throw new AppError('Choose how the difference is being paid', 400);
          }
          await trx('sale_payments').insert({
            id: generateUUID(),
            sale_id: created.id,
            amount: difference,
            payment_method: settlement,
            notes: `Exchange difference against ${original.sale_number}`,
          });
        }
      } else if (difference < -0.01) {
        // We owe the customer. Recorded against the ORIGINAL sale's return, because
        // that is the transaction the money is coming back out of.
        await trx('customer_returns').where('id', ret.id).update({
          refund_method: data.settlement && data.settlement !== 'none' ? data.settlement : 'cash',
          notes: `${data.notes ? data.notes + ' — ' : ''}Refund of ${money(-difference)} EGP on exchange`,
        });
      } else {
        // An even swap. The new sale is fully covered by the goods coming back, and no
        // cash moves — but the sale must still show as settled, or it sits in the
        // customer's balance forever as an unpaid debt.
        await trx('sale_payments').insert({
          id: generateUUID(),
          sale_id: created.id,
          amount: newValue,
          payment_method: 'exchange',
          notes: `Settled by goods returned on ${original.sale_number}`,
        });
      }

      // A positive difference settled by cash covers only the difference, so the rest
      // of the new sale is covered by the returned goods. Same reasoning as above.
      if (difference > 0.01) {
        const covered = money(newValue - difference);
        if (covered > 0.01) {
          await trx('sale_payments').insert({
            id: generateUUID(),
            sale_id: created.id,
            amount: covered,
            payment_method: 'exchange',
            notes: `Settled by goods returned on ${original.sale_number}`,
          });
        }
      }

      const number = await generateDocumentNumber('EX', trx, 'exchanges', 'exchange_number');
      await trx('exchanges').insert({
        id: exchangeId,
        exchange_number: number,
        store_id: data.store_id,
        original_sale_id: original.id,
        return_id: ret.id,
        new_sale_id: created.id,
        returned_value: returnedValue,
        new_value: newValue,
        difference,
        settlement: data.settlement || (Math.abs(difference) <= 0.01 ? 'none' : 'cash'),
        reason: data.reason || null,
        created_by: user.id,
      });

      result = { id: exchangeId, exchange_number: number, difference };
    });

    return this.getById(exchangeId);
  }

  async list({ store_id, store_ids, from, to, limit } = {}) {
    const q = db('exchanges as x')
      .leftJoin('stores', 'stores.id', 'x.store_id')
      .leftJoin('sales as os', 'os.id', 'x.original_sale_id')
      .leftJoin('sales as ns', 'ns.id', 'x.new_sale_id')
      .leftJoin('users as u', 'u.id', 'x.created_by')
      .select(
        'x.*', 'stores.name as store_name',
        'os.sale_number as original_sale_number',
        'ns.sale_number as new_sale_number',
        'u.full_name as created_by_name'
      )
      .orderBy('x.created_at', 'desc')
      .limit(Math.min(500, parseInt(limit, 10) || 100));
    applyStoreScope(q, 'x.store_id', { store_id, store_ids });
    if (from) q.where('x.created_at', '>=', from);
    if (to) q.where('x.created_at', '<=', `${String(to).slice(0, 10)} 23:59:59`);
    return q;
  }

  async getById(id, scope = {}) {
    const q = db('exchanges as x')
      .leftJoin('stores', 'stores.id', 'x.store_id')
      .leftJoin('sales as os', 'os.id', 'x.original_sale_id')
      .leftJoin('sales as ns', 'ns.id', 'x.new_sale_id')
      .leftJoin('users as u', 'u.id', 'x.created_by')
      .where('x.id', id);
    applyStoreScope(q, 'x.store_id', scope);

    const row = await q.first(
      'x.*', 'stores.name as store_name',
      'os.sale_number as original_sale_number',
      'ns.sale_number as new_sale_number',
      'u.full_name as created_by_name'
    );
    if (!row) throw new AppError('Exchange not found', 404);

    const [returned, taken] = await Promise.all([
      db('customer_return_items as ri')
        .join('sale_items as si', 'si.id', 'ri.sale_item_id')
        .join('inventory_items as ii', 'ii.id', 'si.inventory_item_id')
        .join('product_variants as pv', 'pv.id', 'ii.variant_id')
        .join('products as p', 'p.id', 'pv.product_id')
        .join('product_colors as pc', 'pc.id', 'pv.product_color_id')
        .where('ri.return_id', row.return_id)
        .select('ri.refund_amount', 'p.product_code', 'p.model_name as product_name',
          'pc.color_name', 'pc.is_placeholder as color_is_placeholder', 'pv.size_eu', 'pv.sku'),
      db('sale_items as si')
        .join('inventory_items as ii', 'ii.id', 'si.inventory_item_id')
        .join('product_variants as pv', 'pv.id', 'ii.variant_id')
        .join('products as p', 'p.id', 'pv.product_id')
        .join('product_colors as pc', 'pc.id', 'pv.product_color_id')
        .where('si.sale_id', row.new_sale_id)
        .select('si.sale_price', 'p.product_code', 'p.model_name as product_name',
          'pc.color_name', 'pc.is_placeholder as color_is_placeholder', 'pv.size_eu', 'pv.sku'),
    ]);

    row.returned_items = returned;
    row.new_items = taken;
    return row;
  }
}

module.exports = new ExchangesService();
module.exports.SETTLEMENTS = SETTLEMENTS;
