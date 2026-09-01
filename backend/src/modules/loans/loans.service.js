const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const { toDateOnly, businessDayStart } = require('../../utils/dateRange');

/**
 * Money lent out, and what has come back.
 *
 * Two corrections shape this module:
 *
 * 1. STORE SCOPING. `list` took a caller-supplied store_id and applied no scope at all,
 *    so every user saw every store's loans and could target any store by hand. This is
 *    the same leak Phase 0 closed across the codebase; loans arrived later and were
 *    missed. Every read now goes through applyStoreScope.
 *
 * 2. A BORROWER NEED NOT BE A SYSTEM USER. The API demanded `borrower_user_id`, so a
 *    shop could not record lending to a customer, a driver or a relative — even though
 *    the table has always had a free-text `borrower_name` for exactly that. One of the
 *    two is now required, never both-or-nothing.
 *
 * `overdue` is DERIVED, never stored. A stored flag is wrong the morning after it is
 * written unless something sweeps the table; a comparison against CURRENT_DATE cannot
 * go stale. `status` keeps its three settled values (active / partial / paid) and
 * overdue is computed alongside it.
 */

const OVERDUE_SQL = `(loans.due_date IS NOT NULL
  AND loans.due_date < CURRENT_DATE
  AND loans.status <> 'paid')`;

const LOAN_SELECT = [
  'loans.*',
  'stores.name as store_name',
  'creator.full_name as created_by_name',
  'borrower.full_name as borrower_full_name',
  'borrower.username as borrower_username',
];

class LoansService {
  _base() {
    return db('loans')
      .leftJoin('stores', 'loans.store_id', 'stores.id')
      .leftJoin('users as creator', 'loans.created_by', 'creator.id')
      .leftJoin('users as borrower', 'loans.borrower_user_id', 'borrower.id');
  }

  async list({ store_id, store_ids, status, search, overdue_only, borrower_user_id } = {}) {
    const query = this._base()
      .select(
        ...LOAN_SELECT,
        db.raw(`${OVERDUE_SQL} as is_overdue`),
        db.raw('(loans.amount - loans.paid_amount) as remaining'),
        db.raw(`CASE WHEN loans.due_date IS NULL THEN NULL
                     ELSE (loans.due_date - CURRENT_DATE) END as days_to_due`)
      )
      // Overdue first, then soonest due, then newest. A list of debts is read for what
      // needs chasing, not for what was entered last.
      .orderByRaw(`${OVERDUE_SQL} DESC, loans.due_date ASC NULLS LAST, loans.created_at DESC`);

    // A loan with no store belongs to the business rather than a branch, so it stays
    // visible to anyone who can read loans at all. Scoping it away would hide it from
    // everyone except an admin — including whoever entered it. Branch separation is
    // what store scoping is for, and a loan attached to no branch is not branch data.
    if (store_id || Array.isArray(store_ids)) {
      query.where(function () {
        applyStoreScope(this, 'loans.store_id', { store_id, store_ids });
        this.orWhereNull('loans.store_id');
      });
    }

    if (status) query.where('loans.status', status);
    if (borrower_user_id) query.where('loans.borrower_user_id', borrower_user_id);
    if (overdue_only) query.whereRaw(OVERDUE_SQL);
    if (search) {
      const safe = String(search).replace(/[%_\\]/g, '\\$&');
      query.where(function () {
        this.where('loans.borrower_name', 'ilike', `%${safe}%`)
          .orWhere('loans.borrower_phone', 'ilike', `%${safe}%`)
          .orWhere('borrower.full_name', 'ilike', `%${safe}%`)
          .orWhere('borrower.username', 'ilike', `%${safe}%`);
      });
    }

    return query.limit(500);
  }

  async getById(id) {
    const loan = await this._base()
      .where('loans.id', id)
      .select(
        ...LOAN_SELECT,
        db.raw(`${OVERDUE_SQL} as is_overdue`),
        db.raw('(loans.amount - loans.paid_amount) as remaining')
      )
      .first();
    if (!loan) throw new AppError('Loan not found', 404);

    loan.payments = await db('loan_payments as lp')
      .leftJoin('users', 'lp.created_by', 'users.id')
      .where('lp.loan_id', id)
      .orderBy('lp.payment_date', 'desc')
      .select(
        'lp.*',
        'users.full_name as created_by_name',
        db.raw('(SELECT COUNT(*)::int FROM attached_images ai WHERE ai.entity_type = ? AND ai.entity_id = lp.id) as proof_count', ['loan_payment'])
      );

    loan.installments = await this.listInstallments(id);
    return loan;
  }

  /**
   * A borrower is either a system user or a written name — one of the two, always.
   *
   * Picking a user wins and fills the name from their profile, so the name shown on a
   * loan cannot drift from the account it points at.
   */
  async _resolveBorrower(data, existing = null) {
    // '' arrives from a cleared dropdown; treat it as "no user", not as an id.
    const userId = data.borrower_user_id || null;
    const typed = (data.borrower_name || '').trim();

    if (userId) {
      const user = await db('users').where('id', userId).first();
      if (!user) throw new AppError('Borrower user not found', 404);
      return { borrower_user_id: user.id, borrower_name: user.full_name || user.username };
    }
    if (typed) return { borrower_user_id: null, borrower_name: typed };

    // Neither given. Only reachable when the caller is deliberately changing the
    // borrower, so keep the name already on the loan and drop the account link rather
    // than leaving the row nameless — borrower_name is NOT NULL.
    if (existing && existing.borrower_name) {
      return { borrower_user_id: null, borrower_name: existing.borrower_name };
    }
    throw new AppError('Choose a staff member, or type the borrower\'s name', 400);
  }

  async create(data, userId) {
    const borrower = await this._resolveBorrower(data);
    if (data.due_date && data.loan_date && new Date(data.due_date) < new Date(data.loan_date)) {
      throw new AppError('The due date cannot be before the loan date', 400);
    }

    return db.transaction(async (trx) => {
      const [loan] = await trx('loans')
        .insert({
          id: generateUUID(),
          ...borrower,
          borrower_phone: data.borrower_phone || null,
          amount: data.amount,
          loan_date: data.loan_date,
          due_date: data.due_date || null,
          notes: data.notes || null,
          store_id: data.store_id || null,
          created_by: userId,
          status: 'active',
          paid_amount: 0,
        })
        .returning('*');

      // An instalment plan asked for at creation time is generated here, inside the
      // same transaction, so a loan can never exist with half a schedule.
      if (data.installments && Number(data.installments) > 1) {
        await this._generateInstallments(trx, loan, Number(data.installments), data.installment_start || data.due_date || data.loan_date);
      }
      return loan;
    });
  }

  async update(id, data) {
    const existing = await db('loans').where('id', id).first();
    if (!existing) throw new AppError('Loan not found', 404);

    const safeData = { updated_at: new Date() };
    if (data.borrower_user_id !== undefined || data.borrower_name !== undefined) {
      Object.assign(safeData, await this._resolveBorrower(data, existing));
    }
    for (const f of ['borrower_phone', 'amount', 'loan_date', 'due_date', 'notes', 'store_id']) {
      if (data[f] !== undefined) safeData[f] = data[f];
    }

    const dueDate = safeData.due_date !== undefined ? safeData.due_date : existing.due_date;
    const loanDate = safeData.loan_date !== undefined ? safeData.loan_date : existing.loan_date;
    if (dueDate && loanDate && new Date(dueDate) < new Date(loanDate)) {
      throw new AppError('The due date cannot be before the loan date', 400);
    }

    // Lowering the amount below what has already been repaid would leave the loan
    // overpaid and the status meaningless.
    if (safeData.amount !== undefined && parseFloat(safeData.amount) < parseFloat(existing.paid_amount)) {
      throw new AppError(
        `${parseFloat(existing.paid_amount).toFixed(2)} has already been repaid, so the loan cannot be reduced below that`,
        400
      );
    }

    const [loan] = await db('loans').where('id', id).update(safeData).returning('*');
    if (safeData.amount !== undefined) await this._recomputeStatus(db, id);
    return loan;
  }

  async delete(id) {
    const paid = await db('loan_payments').where('loan_id', id).count('id as n').first();
    if (Number(paid.n) > 0) {
      throw new AppError(
        `This loan has ${paid.n} recorded payment(s). Delete those first if it really was entered by mistake.`,
        400
      );
    }
    const count = await db('loans').where('id', id).del();
    if (!count) throw new AppError('Loan not found', 404);
  }

  /** Re-derive status from the amounts, after either side of them changes. */
  async _recomputeStatus(conn, loanId) {
    const loan = await conn('loans').where('id', loanId).first();
    const paid = parseFloat(loan.paid_amount);
    const total = parseFloat(loan.amount);
    const status = paid <= 0 ? 'active' : paid >= total ? 'paid' : 'partial';
    if (status !== loan.status) {
      await conn('loans').where('id', loanId).update({ status, updated_at: new Date() });
    }
    return status;
  }

  // ================================================================
  //  PAYMENTS
  // ================================================================

  async addPayment(loanId, data, userId) {
    const paymentId = generateUUID();

    await db.transaction(async (trx) => {
      // Read and lock inside the transaction. Reading the loan outside it meant two
      // concurrent payments could both measure the same remaining balance and together
      // overpay the loan.
      const loan = await trx('loans').where('id', loanId).forUpdate().first();
      if (!loan) throw new AppError('Loan not found', 404);

      const remaining = Math.round((parseFloat(loan.amount) - parseFloat(loan.paid_amount)) * 100) / 100;
      if (parseFloat(data.amount) > remaining) {
        throw new AppError(`Payment exceeds remaining balance (${remaining.toFixed(2)})`, 400);
      }

      await trx('loan_payments').insert({
        id: paymentId,
        loan_id: loanId,
        amount: data.amount,
        payment_method: data.payment_method || 'cash',
        payment_date: data.payment_date,
        notes: data.notes || null,
        created_by: userId,
      });

      // parseFloat on both sides: a string amount would otherwise concatenate.
      const newPaid = Math.round((parseFloat(loan.paid_amount) + parseFloat(data.amount)) * 100) / 100;
      const newStatus = newPaid >= parseFloat(loan.amount) ? 'paid' : 'partial';

      await trx('loans').where('id', loanId).update({
        paid_amount: newPaid,
        status: newStatus,
        updated_at: new Date(),
      });
    });

    return { loan: await this.getById(loanId), payment_id: paymentId };
  }

  async deletePayment(loanId, paymentId) {
    await db.transaction(async (trx) => {
      // Locked and read inside the transaction so a concurrent delete of the same
      // payment cannot subtract its amount from the loan twice.
      const loan = await trx('loans').where('id', loanId).forUpdate().first();
      if (!loan) throw new AppError('Loan not found', 404);

      const payment = await trx('loan_payments').where({ id: paymentId, loan_id: loanId }).first();
      if (!payment) throw new AppError('Payment not found', 404);

      await trx('attached_images').where({ entity_type: 'loan_payment', entity_id: paymentId }).del();
      await trx('loan_payments').where('id', paymentId).del();
      const newPaid = Math.max(0, Math.round((parseFloat(loan.paid_amount) - parseFloat(payment.amount)) * 100) / 100);
      const newStatus = newPaid <= 0 ? 'active' : newPaid >= parseFloat(loan.amount) ? 'paid' : 'partial';
      await trx('loans').where('id', loanId).update({ paid_amount: newPaid, status: newStatus, updated_at: new Date() });
    });

    return this.getById(loanId);
  }

  // ================================================================
  //  PAYMENT PROOF  (attached_images, entity_type = 'loan_payment')
  // ================================================================

  async listPaymentProof(paymentId) {
    return db('attached_images')
      .where({ entity_type: 'loan_payment', entity_id: paymentId })
      .orderBy('created_at', 'asc')
      .select('id', 'image_url', 'thumb_url', 'original_name', 'created_at');
  }

  async addPaymentProof(loanId, paymentId, { image_url, thumb_url, original_name }) {
    const payment = await db('loan_payments').where({ id: paymentId, loan_id: loanId }).first();
    if (!payment) throw new AppError('Payment not found', 404);
    const [row] = await db('attached_images')
      .insert({
        id: generateUUID(),
        entity_type: 'loan_payment',
        entity_id: paymentId,
        image_url,
        thumb_url: thumb_url || null,
        original_name: original_name || null,
      })
      .returning('*');
    return row;
  }

  // ================================================================
  //  INSTALMENTS
  // ================================================================

  /**
   * Each instalment carries what has been paid against it, oldest payment first.
   *
   * Payments are NOT tied to a particular instalment — a shop pays what it pays. The
   * schedule is settled in order, which is how anyone reading it expects arrears to
   * work: the oldest unpaid instalment is the one in arrears.
   */
  async listInstallments(loanId) {
    const rows = await db('loan_installments')
      .where('loan_id', loanId)
      .orderBy('seq');
    if (!rows.length) return [];

    const loan = await db('loans').where('id', loanId).first();
    let credit = parseFloat(loan.paid_amount) || 0;
    // The business day, not the UTC one: at 01:00 in Cairo the UTC date is still
    // yesterday, and an instalment would read as not-yet-due for three hours a day.
    const today = businessDayStart();

    return rows.map((r) => {
      const amount = parseFloat(r.amount);
      const paid = Math.min(credit, amount);
      credit = Math.round((credit - paid) * 100) / 100;
      const due = toDateOnly(r.due_date);
      const settled = paid >= amount - 0.001;
      return {
        ...r,
        amount,
        paid: Math.round(paid * 100) / 100,
        remaining: Math.round((amount - paid) * 100) / 100,
        is_settled: settled,
        is_overdue: !settled && due < today,
      };
    });
  }

  /** Split the loan into n equal instalments, the rounding remainder on the first. */
  async _generateInstallments(conn, loan, count, startDate) {
    const total = Math.round(parseFloat(loan.amount) * 100);
    const each = Math.floor(total / count);
    const remainder = total - each * count;
    // Anchored at UTC midnight so the month arithmetic below cannot shift a day.
    const start = new Date(`${toDateOnly(startDate) || toDateOnly(loan.loan_date)}T00:00:00Z`);
    const startDay = start.getUTCDate();

    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const due = new Date(start);
      due.setUTCMonth(due.getUTCMonth() + i);
      // A plan starting on the 31st has no 31st in February; clamp to the month's last
      // day rather than letting it roll into March.
      if (due.getUTCDate() !== startDay) due.setUTCDate(0);
      rows.push({
        id: generateUUID(),
        loan_id: loan.id,
        seq: i + 1,
        due_date: due.toISOString().slice(0, 10),
        // The remainder rides on the first instalment so the schedule always sums to
        // the loan exactly, and the shortfall is paid earliest rather than last.
        amount: ((each + (i === 0 ? remainder : 0)) / 100).toFixed(2),
      });
    }
    await conn('loan_installments').insert(rows);
    return rows;
  }

  async setInstallments(loanId, { count, start_date }) {
    return db.transaction(async (trx) => {
      const loan = await trx('loans').where('id', loanId).forUpdate().first();
      if (!loan) throw new AppError('Loan not found', 404);
      await trx('loan_installments').where('loan_id', loanId).del();
      if (!count || Number(count) < 2) return [];
      if (Number(count) > 60) throw new AppError('A plan cannot run past 60 instalments', 400);
      return this._generateInstallments(trx, loan, Number(count), start_date || loan.due_date || loan.loan_date);
    });
  }

  // ================================================================
  //  TOTALS
  // ================================================================

  /** Total outstanding, split by store and by whether it is overdue. */
  async outstanding({ store_id, store_ids } = {}) {
    const query = db('loans')
      .whereIn('status', ['active', 'partial'])
      .select(
        db.raw('COALESCE(SUM(loans.amount - loans.paid_amount), 0) as total'),
        db.raw(`COALESCE(SUM(CASE WHEN ${OVERDUE_SQL} THEN loans.amount - loans.paid_amount ELSE 0 END), 0) as overdue`),
        db.raw('COUNT(*)::int as count'),
        db.raw(`COUNT(*) FILTER (WHERE ${OVERDUE_SQL})::int as overdue_count`)
      );
    if (store_id || Array.isArray(store_ids)) {
      query.where(function () {
        applyStoreScope(this, 'loans.store_id', { store_id, store_ids });
        this.orWhereNull('loans.store_id');
      });
    }
    const row = await query.first();
    return {
      total: parseFloat(row.total) || 0,
      overdue: parseFloat(row.overdue) || 0,
      count: row.count || 0,
      overdue_count: row.overdue_count || 0,
    };
  }

  /** Kept for the dashboard, which asks only for a single figure. */
  async totalOutstanding(filters = {}) {
    return (await this.outstanding(filters)).total;
  }

  /**
   * Everything needed to print a borrower's statement: the loan, what was paid, and
   * what is still owed, in one call so the page does not stitch three together.
   */
  async statement(loanId) {
    const loan = await this.getById(loanId);
    const totalPaid = loan.payments.reduce((n, p) => n + parseFloat(p.amount), 0);
    return {
      loan,
      totals: {
        amount: parseFloat(loan.amount),
        paid: Math.round(totalPaid * 100) / 100,
        remaining: Math.round((parseFloat(loan.amount) - totalPaid) * 100) / 100,
        payments: loan.payments.length,
      },
    };
  }
}

module.exports = new LoansService();
