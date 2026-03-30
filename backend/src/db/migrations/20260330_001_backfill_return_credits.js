/**
 * One-time backfill: Apply supplier return credits to unpaid invoices.
 *
 * Before this fix, creating a new invoice didn't account for return credits
 * when auto-applying supplier credit. This migration retroactively fixes
 * existing invoices by calculating each supplier's unaccounted return credit
 * and applying it (FIFO) to their unpaid/partial invoices.
 */
exports.up = async function (knex) {
  // Get all suppliers that have returns
  const suppliers = await knex('suppliers').select('id');

  for (const supplier of suppliers) {
    const sid = supplier.id;

    // Total invoiced (net of discount)
    const invoiceSum = await knex('purchase_invoices')
      .where('supplier_id', sid)
      .select(knex.raw('COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0) as total'))
      .first();

    // Total returns
    const returnSum = await knex('supplier_returns')
      .where('supplier_id', sid)
      .sum('total_amount as total')
      .first();

    // Total payments
    const paymentSum = await knex('supplier_payments')
      .where('supplier_id', sid)
      .where('type', 'payment')
      .sum('total_amount as total')
      .first();

    // Total withdrawals
    const withdrawalSum = await knex('supplier_payments')
      .where('supplier_id', sid)
      .where('type', 'withdrawal')
      .sum('total_amount as total')
      .first();

    const totalInvoiced = parseFloat(invoiceSum.total) || 0;
    const totalReturns = parseFloat(returnSum.total) || 0;
    const totalPayments = parseFloat(paymentSum.total) || 0;
    const totalWithdrawals = parseFloat(withdrawalSum.total) || 0;

    // Current balance: positive = we owe supplier, negative = supplier has credit
    const balance = totalInvoiced - totalReturns - totalPayments + totalWithdrawals;

    // Sum of all invoice paid_amounts
    const paidOnInvoices = await knex('purchase_invoices')
      .where('supplier_id', sid)
      .sum('paid_amount as total')
      .first();
    const totalPaidOnInvoices = parseFloat(paidOnInvoices.total) || 0;

    // How much SHOULD be paid on invoices = totalPayments - totalWithdrawals + totalReturns
    // (capped at totalInvoiced)
    const shouldBePaid = Math.min(totalInvoiced, totalPayments - totalWithdrawals + totalReturns);
    const missingCredit = Math.round((shouldBePaid - totalPaidOnInvoices) * 100) / 100;

    if (missingCredit <= 0) continue;

    console.log(`Supplier ${sid}: missing ${missingCredit} credit on invoices. Backfilling...`);

    // Get unpaid/partial invoices (FIFO)
    const invoices = await knex('purchase_invoices')
      .where('supplier_id', sid)
      .whereIn('status', ['pending', 'partial'])
      .orderBy('invoice_date', 'asc')
      .orderBy('created_at', 'asc');

    let remaining = missingCredit;

    for (const invoice of invoices) {
      if (remaining <= 0) break;

      const netTotal = parseFloat(invoice.total_amount) - (parseFloat(invoice.discount_amount) || 0);
      const currentPaid = parseFloat(invoice.paid_amount) || 0;
      const owed = Math.round((netTotal - currentPaid) * 100) / 100;

      if (owed <= 0) continue;

      const toApply = Math.round(Math.min(remaining, owed) * 100) / 100;
      const newPaidAmount = Math.round((currentPaid + toApply) * 100) / 100;
      const newStatus = newPaidAmount >= netTotal ? 'paid' : 'partial';

      await knex('purchase_invoices')
        .where('id', invoice.id)
        .update({
          paid_amount: newPaidAmount,
          status: newStatus,
          updated_at: new Date(),
        });

      console.log(`  Invoice ${invoice.invoice_number}: +${toApply} credit → paid_amount=${newPaidAmount}, status=${newStatus}`);
      remaining = Math.round((remaining - toApply) * 100) / 100;
    }
  }
};

exports.down = async function () {
  // This is a data backfill — no automatic rollback.
  // Manual correction would be needed if reverted.
};
