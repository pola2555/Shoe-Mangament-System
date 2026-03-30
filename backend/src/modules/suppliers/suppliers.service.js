const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Suppliers service — CRUD + balance/statement.
 * 
 * A supplier's balance is computed dynamically:
 *   total_owed = sum of purchase_invoices.total_amount - sum of supplier_returns.total_amount
 *   total_paid = sum of supplier_payments.total_amount
 *   balance = total_owed - total_paid   (positive = you owe them)
 */
class SuppliersService {
  async list() {
    const suppliers = await db('suppliers').orderBy('name', 'asc').limit(500);

    // Compute balance for each supplier
    for (const s of suppliers) {
      const invoiceSum = await db('purchase_invoices')
        .where('supplier_id', s.id)
        .select(db.raw('SUM(total_amount - COALESCE(discount_amount, 0)) as total'))
        .first();
      const returnSum = await db('supplier_returns')
        .where('supplier_id', s.id)
        .sum('total_amount as total')
        .first();
      const paymentSum = await db('supplier_payments')
        .where('supplier_id', s.id)
        .where('type', 'payment')
        .sum('total_amount as total')
        .first();
      const withdrawalSum = await db('supplier_payments')
        .where('supplier_id', s.id)
        .where('type', 'withdrawal')
        .sum('total_amount as total')
        .first();

      s.total_invoiced = parseFloat(invoiceSum.total) || 0;
      s.total_returns = parseFloat(returnSum.total) || 0;
      s.total_paid = parseFloat(paymentSum.total) || 0;
      s.total_withdrawn = parseFloat(withdrawalSum.total) || 0;
      s.balance = s.total_invoiced - s.total_returns - s.total_paid + s.total_withdrawn;
    }

    return suppliers;
  }

  async getById(id) {
    const supplier = await db('suppliers').where('id', id).first();
    if (!supplier) throw new AppError('Supplier not found', 404);

    // Invoices
    supplier.invoices = await db('purchase_invoices')
      .where('supplier_id', id)
      .orderBy('invoice_date', 'desc');

    // Payments
    supplier.payments = await db('supplier_payments')
      .where('supplier_id', id)
      .orderBy('payment_date', 'desc');

    // Returns
    supplier.returns = await db('supplier_returns')
      .where('supplier_id', id)
      .orderBy('created_at', 'desc');

    // Balance
    const invoiceSum = supplier.invoices.reduce((sum, i) => sum + parseFloat(i.total_amount) - (parseFloat(i.discount_amount) || 0), 0);
    const returnSum = supplier.returns.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
    const paymentSum = supplier.payments.filter(p => p.type !== 'withdrawal').reduce((sum, p) => sum + parseFloat(p.total_amount), 0);
    const withdrawalSum = supplier.payments.filter(p => p.type === 'withdrawal').reduce((sum, p) => sum + parseFloat(p.total_amount), 0);
    supplier.total_invoiced = invoiceSum;
    supplier.total_returns = returnSum;
    supplier.total_paid = paymentSum;
    supplier.total_withdrawn = withdrawalSum;
    supplier.balance = invoiceSum - returnSum - paymentSum + withdrawalSum;

    return supplier;
  }

  async create(data) {
    const safeData = { id: generateUUID() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.email !== undefined) safeData.email = data.email;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.notes !== undefined) safeData.notes = data.notes;
    const [supplier] = await db('suppliers')
      .insert(safeData)
      .returning('*');
    return supplier;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.email !== undefined) safeData.email = data.email;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.notes !== undefined) safeData.notes = data.notes;
    if (data.is_active !== undefined) safeData.is_active = data.is_active;
    const [supplier] = await db('suppliers')
      .where('id', id).update(safeData).returning('*');
    if (!supplier) throw new AppError('Supplier not found', 404);
    return supplier;
  }

  async delete(id) {
    const invCount = await db('purchase_invoices').where('supplier_id', id).count('id as count').first();
    if (parseInt(invCount.count) > 0) {
      throw new AppError('Cannot delete supplier with existing invoices. Edit their info instead.', 400);
    }
    const count = await db('suppliers').where('id', id).del();
    if (!count) throw new AppError('Supplier not found', 404);
  }
}

module.exports = new SuppliersService();
