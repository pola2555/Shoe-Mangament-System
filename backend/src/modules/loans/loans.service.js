const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class LoansService {
  async list({ store_id, status, search } = {}) {
    let query = db('loans')
      .leftJoin('stores', 'loans.store_id', 'stores.id')
      .leftJoin('users', 'loans.created_by', 'users.id')
      .select(
        'loans.*',
        'stores.name as store_name',
        'users.full_name as created_by_name'
      )
      .orderBy('loans.created_at', 'desc');

    if (store_id) query = query.where('loans.store_id', store_id);
    if (status) query = query.where('loans.status', status);
    if (search) {
      const safe = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('loans.borrower_name', 'ilike', `%${safe}%`)
          .orWhere('loans.borrower_phone', 'ilike', `%${safe}%`);
      });
    }

    return query.limit(500);
  }

  async getById(id) {
    const loan = await db('loans')
      .leftJoin('stores', 'loans.store_id', 'stores.id')
      .leftJoin('users', 'loans.created_by', 'users.id')
      .where('loans.id', id)
      .select('loans.*', 'stores.name as store_name', 'users.full_name as created_by_name')
      .first();
    if (!loan) throw new AppError('Loan not found', 404);

    loan.payments = await db('loan_payments')
      .where('loan_id', id)
      .orderBy('payment_date', 'desc');

    return loan;
  }

  async create(data, userId) {
    const [loan] = await db('loans')
      .insert({
        id: generateUUID(),
        borrower_name: data.borrower_name,
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
    return loan;
  }

  async update(id, data) {
    const existing = await db('loans').where('id', id).first();
    if (!existing) throw new AppError('Loan not found', 404);

    const safeData = { updated_at: new Date() };
    if (data.borrower_name !== undefined) safeData.borrower_name = data.borrower_name;
    if (data.borrower_phone !== undefined) safeData.borrower_phone = data.borrower_phone;
    if (data.amount !== undefined) safeData.amount = data.amount;
    if (data.loan_date !== undefined) safeData.loan_date = data.loan_date;
    if (data.due_date !== undefined) safeData.due_date = data.due_date;
    if (data.notes !== undefined) safeData.notes = data.notes;
    if (data.store_id !== undefined) safeData.store_id = data.store_id;

    const [loan] = await db('loans').where('id', id).update(safeData).returning('*');
    return loan;
  }

  async delete(id) {
    const count = await db('loans').where('id', id).del();
    if (!count) throw new AppError('Loan not found', 404);
  }

  async addPayment(loanId, data, userId) {
    const loan = await db('loans').where('id', loanId).first();
    if (!loan) throw new AppError('Loan not found', 404);

    const remaining = parseFloat(loan.amount) - parseFloat(loan.paid_amount);
    if (data.amount > remaining) {
      throw new AppError(`Payment exceeds remaining balance (${remaining.toFixed(2)})`, 400);
    }

    const paymentId = generateUUID();
    await db.transaction(async (trx) => {
      await trx('loan_payments').insert({
        id: paymentId,
        loan_id: loanId,
        amount: data.amount,
        payment_method: data.payment_method || 'cash',
        payment_date: data.payment_date,
        notes: data.notes || null,
        created_by: userId,
      });

      const newPaid = Math.round((parseFloat(loan.paid_amount) + data.amount) * 100) / 100;
      const newStatus = newPaid >= parseFloat(loan.amount) ? 'paid' : 'partial';

      await trx('loans').where('id', loanId).update({
        paid_amount: newPaid,
        status: newStatus,
        updated_at: new Date(),
      });
    });

    return this.getById(loanId);
  }

  async deletePayment(loanId, paymentId) {
    const payment = await db('loan_payments').where({ id: paymentId, loan_id: loanId }).first();
    if (!payment) throw new AppError('Payment not found', 404);

    await db.transaction(async (trx) => {
      await trx('loan_payments').where('id', paymentId).del();
      const loan = await trx('loans').where('id', loanId).first();
      const newPaid = Math.max(0, Math.round((parseFloat(loan.paid_amount) - parseFloat(payment.amount)) * 100) / 100);
      const newStatus = newPaid <= 0 ? 'active' : newPaid >= parseFloat(loan.amount) ? 'paid' : 'partial';
      await trx('loans').where('id', loanId).update({ paid_amount: newPaid, status: newStatus, updated_at: new Date() });
    });

    return this.getById(loanId);
  }

  /** Total outstanding loans, optionally filtered by store */
  async totalOutstanding({ store_id } = {}) {
    let query = db('loans').whereIn('status', ['active', 'partial'])
      .select(db.raw('COALESCE(SUM(amount - paid_amount), 0) as total'));
    if (store_id) query = query.where('store_id', store_id);
    const result = await query.first();
    return parseFloat(result.total) || 0;
  }
}

module.exports = new LoansService();
