const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');

/**
 * The "cash with no cash-up" filter, in ONE place so the till strip, the shift report
 * and the reports-page insight all mean the same thing by it.
 *
 * A cash payment counts as unassigned only when it is:
 *   - cash, and                               (card/transfer never sits in the drawer)
 *   - on a live (non-voided) sale, and
 *   - not linked to a shift, and
 *   - taken on or after that branch's FIRST cash-up.
 *
 * The last clause is the important one. Before a branch ever opened a shift there was
 * no cash-up for a sale to belong to, so "no shift" there is history, not a hole. The
 * correlated subquery returns NULL for a branch that has never opened a shift, and
 * `created_at >= NULL` is never true, so such a branch contributes nothing — which is
 * correct: it is not yet doing cash-ups, so there is nothing to reconcile against.
 *
 * Expects `sales` to be joined to the query already.
 */
function applyUnassignedCash(q) {
  return q
    .where('sale_payments.payment_method', 'cash')
    .whereNull('sales.shift_id')
    .whereNull('sales.voided_at')
    .whereRaw(
      'sales.created_at >= (SELECT MIN(opened_at) FROM shifts WHERE shifts.store_id = sales.store_id)'
    );
}

/**
 * Shifts — opening the till, and counting it at the end.
 *
 * WHAT THIS IS FOR
 *
 * A shop's cash is the one number nothing else can check. Stock has a count, the bank
 * has a statement, but the drawer only tells the truth if somebody counts it and
 * compares. Without that, a shortfall is invisible: it looks exactly like a slow day.
 *
 * THE SHAPE
 *
 * A shift belongs to a BRANCH, not a person — one drawer, whoever is standing at it.
 * The database allows exactly one open shift per store
 * (`uq_shifts_one_open_per_store`), because two open shifts would split one till's cash
 * across two counts and neither would balance.
 *
 * EXPECTED CASH — every way money moves in or out of a drawer
 *
 *     opening float
 *   + cash taken on sales          (sale_payments.payment_method = 'cash')
 *   - cash refunded on returns     (customer_returns.refund_method = 'cash')
 *   - expenses paid from the till  (expenses.paid_from_drawer)
 *   - money the owner took out     (cash_movements 'owner_take' / 'drop')
 *   + float added mid-shift        (cash_movements 'float_in')
 *
 * Card, transfer and on-account money is deliberately absent: none of it is in the
 * drawer, so counting it would guarantee a difference every single time.
 *
 * Voided sales are excluded, because the money went back.
 *
 * WHY BOTH NUMBERS ARE STORED AT CLOSE
 *
 * `counted_cash` and `expected_cash` are both written when the shift closes. Recomputing
 * "expected" on demand would look tidier and would be wrong: void a sale next week and
 * last Tuesday's shortfall silently changes, after somebody has already investigated it
 * and written down what they found.
 */

const MOVEMENT_TYPES = ['owner_take', 'drop', 'float_in', 'correction'];
// Types that REMOVE cash from the drawer. 'float_in' is the only one that adds.
const OUTFLOW_TYPES = ['owner_take', 'drop'];

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

class ShiftsService {
  /** The shift a sale, refund or drawer-paid expense should attach itself to. */
  async openShiftFor(storeId, trx = db) {
    if (!storeId) return null;
    return trx('shifts').where({ store_id: storeId, status: 'open' }).first();
  }

  // ================================================================
  //  OPEN / CLOSE
  // ================================================================

  async open({ store_id, opening_float, notes }, userId) {
    const float = money(opening_float);
    if (float < 0) throw new AppError('The opening float cannot be negative', 400);

    const id = generateUUID();
    try {
      await db.transaction(async (trx) => {
        const number = await generateDocumentNumber('SH', trx, 'shifts', 'shift_number');
        await trx('shifts').insert({
          id,
          shift_number: number,
          store_id,
          opened_by: userId,
          opening_float: float,
          status: 'open',
          open_notes: notes || null,
        });
      });
    } catch (err) {
      // The partial unique index is the guard, so two people pressing "open" at the
      // same moment cannot both succeed — one gets this instead of a second drawer.
      if (err.code === '23505') {
        throw new AppError('This branch already has a shift open. Close it before starting another.', 409);
      }
      throw err;
    }
    return this.getById(id);
  }

  /**
   * What the drawer should hold right now, and everything that put it there.
   *
   * Used live while the shift is open (so a cashier can check mid-day) and again at
   * close. One query set, one definition.
   */
  async cashPosition(shiftId, trx = db) {
    const shift = await trx('shifts').where('id', shiftId).first();
    if (!shift) throw new AppError('Shift not found', 404);

    const [sales, refunds, expenses, movements, nonCash] = await Promise.all([
      // Cash actually taken. A part-cash, part-card sale contributes only its cash line.
      trx('sale_payments')
        .join('sales', 'sales.id', 'sale_payments.sale_id')
        .where('sales.shift_id', shiftId)
        .whereNull('sales.voided_at')
        .where('sale_payments.payment_method', 'cash')
        .sum('sale_payments.amount as total')
        .count('sale_payments.id as n')
        .first(),

      trx('customer_returns')
        .where('shift_id', shiftId)
        .where('refund_method', 'cash')
        .sum('total_refund_amount as total')
        .count('id as n')
        .first(),

      trx('expenses')
        .where('shift_id', shiftId)
        .where('paid_from_drawer', true)
        .sum('amount as total')
        .count('id as n')
        .first(),

      trx('cash_movements').where('shift_id', shiftId).select('type').sum('amount as total').groupBy('type'),

      // Not in the drawer, but worth showing: it explains why takings and cash differ.
      trx('sale_payments')
        .join('sales', 'sales.id', 'sale_payments.sale_id')
        .where('sales.shift_id', shiftId)
        .whereNull('sales.voided_at')
        .whereNot('sale_payments.payment_method', 'cash')
        .sum('sale_payments.amount as total')
        .first(),
    ]);

    const byType = Object.fromEntries(movements.map((m) => [m.type, money(m.total)]));
    const takenOut = OUTFLOW_TYPES.reduce((n, t) => n + (byType[t] || 0), 0);
    const floatIn = byType.float_in || 0;
    const corrections = byType.correction || 0;

    const cashSales = money(sales.total);
    const cashRefunds = money(refunds.total);
    const drawerExpenses = money(expenses.total);

    const expected = money(
      money(shift.opening_float) + cashSales + floatIn + corrections
      - cashRefunds - drawerExpenses - takenOut
    );

    return {
      shift_id: shiftId,
      opening_float: money(shift.opening_float),
      cash_sales: cashSales,
      cash_sales_count: Number(sales.n) || 0,
      cash_refunds: cashRefunds,
      cash_refunds_count: Number(refunds.n) || 0,
      drawer_expenses: drawerExpenses,
      drawer_expenses_count: Number(expenses.n) || 0,
      float_in: floatIn,
      corrections,
      taken_out: money(takenOut),
      by_movement_type: byType,
      expected_cash: expected,
      // Context, not part of the count.
      non_cash_taken: money(nonCash?.total),
    };
  }

  /**
   * Close the shift against a counted drawer.
   *
   * `counted_cash` is required and is never defaulted to the expected figure. A
   * cash-up that pre-fills the answer is not a count — it is a rubber stamp, and it
   * would report a perfect drawer every night while money walked out of it.
   */
  async close(id, { counted_cash, notes }, userId) {
    const counted = money(counted_cash);
    if (counted_cash === undefined || counted_cash === null || Number.isNaN(counted)) {
      throw new AppError('Count the drawer and enter what is actually in it', 400);
    }
    if (counted < 0) throw new AppError('The counted amount cannot be negative', 400);

    await db.transaction(async (trx) => {
      const shift = await trx('shifts').where('id', id).forUpdate().first();
      if (!shift) throw new AppError('Shift not found', 404);
      if (shift.status !== 'open') throw new AppError('This shift is already closed', 400);

      const position = await this.cashPosition(id, trx);
      await trx('shifts').where('id', id).update({
        status: 'closed',
        closed_by: userId,
        closed_at: new Date(),
        counted_cash: counted,
        expected_cash: position.expected_cash,
        difference: money(counted - position.expected_cash),
        close_notes: notes || null,
        updated_at: new Date(),
      });
    });

    return this.getById(id);
  }

  /**
   * Correct a drawer count that was typed wrong.
   *
   * NOT a reopen. The shift stays closed, nothing new can land in it, and
   * `expected_cash` is left exactly as it was recorded at close — recomputing it here
   * would let a void or a late expense silently rewrite a shortfall that had already
   * been investigated, which is the one thing the close-time snapshot exists to
   * prevent.
   *
   * The first count is preserved for good. A recount that erased what was originally
   * counted would make "we were 400 short, then we weren't" unanswerable.
   */
  async recount(id, { counted_cash, reason }, userId) {
    const counted = money(counted_cash);
    if (counted_cash === undefined || counted_cash === null || Number.isNaN(counted)) {
      throw new AppError('Enter what you counted', 400);
    }
    if (counted < 0) throw new AppError('The counted amount cannot be negative', 400);

    await db.transaction(async (trx) => {
      const shift = await trx('shifts').where('id', id).forUpdate().first();
      if (!shift) throw new AppError('Shift not found', 404);
      if (shift.status !== 'closed') {
        throw new AppError('Only a closed shift can be recounted. This one is still open.', 400);
      }

      const expected = money(shift.expected_cash);
      const previous = money(shift.counted_cash);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const line = `[recount ${stamp}] ${previous} -> ${counted}`
        + `${reason ? ` (${reason})` : ''}`;

      await trx('shifts').where('id', id).update({
        counted_cash: counted,
        difference: money(counted - expected),
        // Written once. A second recount must not overwrite the first count with the
        // second, or the original number is gone.
        counted_cash_original: shift.counted_cash_original === null
          || shift.counted_cash_original === undefined
          ? previous
          : shift.counted_cash_original,
        recount_count: (shift.recount_count || 0) + 1,
        recounted_at: new Date(),
        recounted_by: userId,
        close_notes: shift.close_notes ? `${shift.close_notes}
${line}` : line,
        updated_at: new Date(),
      });
    });

    return this.getById(id);
  }

  /** Reopen a shift closed by mistake. The count is cleared: it has to be redone. */
  async reopen(id, userId) {
    await db.transaction(async (trx) => {
      const shift = await trx('shifts').where('id', id).forUpdate().first();
      if (!shift) throw new AppError('Shift not found', 404);
      if (shift.status === 'open') throw new AppError('This shift is already open', 400);

      const other = await trx('shifts')
        .where({ store_id: shift.store_id, status: 'open' }).first();
      if (other) {
        throw new AppError(
          `${other.shift_number} is open at this branch. Close it first.`, 409
        );
      }
      await trx('shifts').where('id', id).update({
        status: 'open',
        closed_by: null,
        closed_at: null,
        // Deliberately wiped. A reopened shift keeps trading, so the old count no
        // longer describes the drawer and leaving it would be a lie with a timestamp.
        counted_cash: null,
        expected_cash: null,
        difference: null,
        close_notes: shift.close_notes
          ? `${shift.close_notes}\n[reopened by ${userId}]`
          : `[reopened by ${userId}]`,
        updated_at: new Date(),
      });
    });
    return this.getById(id);
  }

  // ================================================================
  //  CASH MOVEMENTS — the owner taking the takings, mostly
  // ================================================================

  async addMovement({ store_id, type, amount, reason }, userId) {
    if (!MOVEMENT_TYPES.includes(type)) throw new AppError('Unknown cash movement type', 400);
    const value = money(amount);
    if (!(value > 0)) throw new AppError('Enter an amount greater than zero', 400);

    return db.transaction(async (trx) => {
      const shift = await this.openShiftFor(store_id, trx);
      // Allowed with no shift open — the owner may collect at any hour — but then it
      // belongs to no cash-up, and the shift report says so rather than hiding it.
      if (shift && OUTFLOW_TYPES.includes(type)) {
        const position = await this.cashPosition(shift.id, trx);
        if (value > position.expected_cash + 0.001) {
          throw new AppError(
            `There should only be ${position.expected_cash} EGP in the drawer. `
            + 'Count it and record a correction if that is wrong.',
            400
          );
        }
      }

      const [row] = await trx('cash_movements').insert({
        id: generateUUID(),
        shift_id: shift ? shift.id : null,
        store_id,
        type,
        amount: value,
        reason: reason || null,
        created_by: userId,
      }).returning('*');
      return row;
    });
  }

  async listMovements({ store_id, store_ids, shift_id, type, from, to, limit } = {}) {
    const q = db('cash_movements as cm')
      .leftJoin('users as u', 'u.id', 'cm.created_by')
      .leftJoin('shifts as s', 's.id', 'cm.shift_id')
      .leftJoin('stores', 'stores.id', 'cm.store_id')
      .select('cm.*', 'u.full_name as created_by_name', 's.shift_number', 'stores.name as store_name')
      .orderBy('cm.created_at', 'desc')
      .limit(Math.min(500, parseInt(limit, 10) || 100));
    applyStoreScope(q, 'cm.store_id', { store_id, store_ids });
    if (shift_id) q.where('cm.shift_id', shift_id);
    if (type) q.where('cm.type', type);
    if (from) q.where('cm.created_at', '>=', from);
    if (to) q.where('cm.created_at', '<=', `${String(to).slice(0, 10)} 23:59:59`);
    return q;
  }

  // ================================================================
  //  READ
  // ================================================================

  async list({ store_id, store_ids, status, from, to, page, limit } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const base = () => {
      const q = db('shifts as sh')
        .leftJoin('stores', 'stores.id', 'sh.store_id')
        .leftJoin('users as o', 'o.id', 'sh.opened_by')
        .leftJoin('users as c', 'c.id', 'sh.closed_by');
      applyStoreScope(q, 'sh.store_id', { store_id, store_ids });
      if (status) q.where('sh.status', status);
      if (from) q.where('sh.opened_at', '>=', from);
      if (to) q.where('sh.opened_at', '<=', `${String(to).slice(0, 10)} 23:59:59`);
      return q;
    };

    const [{ count }] = await base().count('sh.id as count');
    const rows = await base()
      .select(
        'sh.*',
        'stores.name as store_name',
        'o.full_name as opened_by_name',
        'c.full_name as closed_by_name'
      )
      .orderBy('sh.opened_at', 'desc')
      .limit(size)
      .offset((p - 1) * size);

    return { data: rows, total: Number(count), page: p, limit: size };
  }

  async getById(id, scope = {}) {
    const q = db('shifts as sh')
      .leftJoin('stores', 'stores.id', 'sh.store_id')
      .leftJoin('users as o', 'o.id', 'sh.opened_by')
      .leftJoin('users as c', 'c.id', 'sh.closed_by')
      .where('sh.id', id);
    applyStoreScope(q, 'sh.store_id', scope);

    const shift = await q.first(
      'sh.*', 'stores.name as store_name',
      'o.full_name as opened_by_name', 'c.full_name as closed_by_name'
    );
    if (!shift) throw new AppError('Shift not found', 404);

    // A closed shift reports what was recorded at the time. An open one is computed
    // live, because there is nothing recorded yet.
    shift.position = shift.status === 'open'
      ? await this.cashPosition(id)
      : {
        ...(await this.cashPosition(id)),
        expected_cash: money(shift.expected_cash),
        counted_cash: money(shift.counted_cash),
        difference: money(shift.difference),
      };

    const [movements, expenses, sellers] = await Promise.all([
      this.listMovements({ shift_id: id, limit: 200 }),
      db('expenses as e')
        .leftJoin('expense_categories as c', 'c.id', 'e.category_id')
        .leftJoin('users as u', 'u.id', 'e.created_by')
        .where('e.shift_id', id)
        .select('e.id', 'e.amount', 'e.description', 'e.paid_from_drawer', 'e.expense_date',
          'c.name as category_name', 'u.full_name as created_by_name')
        .orderBy('e.created_at', 'desc'),
      // Who sold what during the shift — the reason `sold_by` exists.
      db('sales')
        .leftJoin('users as sb', 'sb.id', db.raw('COALESCE(sales.sold_by, sales.created_by)'))
        .where('sales.shift_id', id)
        .whereNull('sales.voided_at')
        .groupBy('sb.id', 'sb.full_name')
        .select(db.raw('COALESCE(sb.full_name, \'—\') as seller'))
        .count('sales.id as sales_count')
        .sum('sales.final_amount as revenue')
        .orderByRaw('SUM(sales.final_amount) DESC'),
    ]);

    shift.movements = movements;
    shift.expenses = expenses;
    shift.sellers = sellers.map((s) => ({
      seller: s.seller,
      sales_count: Number(s.sales_count),
      revenue: money(s.revenue),
    }));

    return shift;
  }

  /** The open shift for a branch, or null. Drives the POS banner. */
  async current(storeId) {
    const shift = await db('shifts').where({ store_id: storeId, status: 'open' }).first();
    if (!shift) return null;
    return this.getById(shift.id);
  }

  /**
   * Cash taken while NO shift was open.
   *
   * Selling without an open shift is allowed — refusing would stop a shop trading
   * because of paperwork — but that money belongs to no count, so it has to be
   * visible somewhere or it is simply missing.
   *
   * BUT ONLY once a branch is actually running cash-ups. Every sale rung before the
   * shift feature existed has no shift for the obvious reason that there were no shifts
   * yet — that is history, not loose cash, and counting it produced a frightening
   * number that was mostly the past. So the anomaly is scoped per branch to cash taken
   * on or after that branch FIRST opened a cash-up; see `unassignedCashPredicate`.
   */
  async unassignedCash({ store_id, store_ids, from, to } = {}) {
    const q = db('sale_payments')
      .join('sales', 'sales.id', 'sale_payments.sale_id');
    applyUnassignedCash(q);
    applyStoreScope(q, 'sales.store_id', { store_id, store_ids });
    if (from) q.where('sales.created_at', '>=', from);
    if (to) q.where('sales.created_at', '<=', `${String(to).slice(0, 10)} 23:59:59`);

    const row = await q.sum('sale_payments.amount as total').count('sale_payments.id as n').first();
    return { amount: money(row.total), payments: Number(row.n) || 0 };
  }
}

module.exports = new ShiftsService();
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
// Shared with reports.getInsights so the insight and the till strip cannot disagree.
module.exports.applyUnassignedCash = applyUnassignedCash;
