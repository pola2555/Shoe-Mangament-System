const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { supplierBalanceQuery, getSupplierBalance } = require('../../utils/supplierBalance');

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
    if (suppliers.length === 0) return suppliers;

    // One query for every balance, instead of four queries per supplier
    // (500 suppliers used to mean 2000 round-trips on a single page load).
    const balances = await supplierBalanceQuery(db, suppliers.map((s) => s.id));
    const byId = new Map(balances.map((b) => [b.id, b]));

    for (const s of suppliers) {
      const b = byId.get(s.id);
      s.total_invoiced = parseFloat(b?.total_invoiced) || 0;
      s.total_returns = parseFloat(b?.total_returns) || 0;
      s.total_paid = parseFloat(b?.total_paid) || 0;
      s.total_withdrawn = parseFloat(b?.total_withdrawn) || 0;
      s.balance = parseFloat(b?.balance) || 0;
    }

    return suppliers;
  }

  async getById(id) {
    const supplier = await db('suppliers').where('id', id).first();
    if (!supplier) throw new AppError('Supplier not found', 404);

    const [invoices, payments, returns, balance] = await Promise.all([
      db('purchase_invoices').where('supplier_id', id).orderBy('invoice_date', 'desc'),
      db('supplier_payments').where('supplier_id', id).orderBy('payment_date', 'desc'),
      db('supplier_returns').where('supplier_id', id).orderBy('created_at', 'desc'),
      // Same formula as the list and the financial report, rather than a third
      // hand-rolled reduce that could drift from them.
      getSupplierBalance(db, id),
    ]);

    supplier.invoices = invoices;
    supplier.payments = payments;
    supplier.returns = returns;
    Object.assign(supplier, balance);

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
