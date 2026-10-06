const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');

/**
 * Dealers service — Wholesale B2B sales.
 * Mirror of suppliers but for outgoing wholesale: dealers owe US money.
 * Payments use FIFO allocation across outstanding wholesale invoices.
 */
class DealersService {
  async list() {
    const dealers = await db('dealers').orderBy('name', 'asc').limit(500);
    if (dealers.length === 0) return dealers;

    const ids = dealers.map((d) => d.id);

    // Two grouped aggregates instead of two queries per dealer.
    //
    // total_paid comes from dealer_payments, NOT from summing invoices.paid_amount.
    // paid_amount only ever holds what FIFO managed to allocate, so an overpayment
    // was invisible: the dealer's credit simply vanished from their balance. Summing
    // actual payments makes it surface as a negative balance, matching how supplier
    // balances already work.
    const [invoiceTotals, paymentTotals] = await Promise.all([
      db('wholesale_invoices').whereIn('dealer_id', ids)
        .groupBy('dealer_id').select('dealer_id').sum('total_amount as invoiced'),
      db('dealer_payments').whereIn('dealer_id', ids)
        .groupBy('dealer_id').select('dealer_id').sum('total_amount as paid'),
    ]);

    const invoicedBy = new Map(invoiceTotals.map((t) => [t.dealer_id, parseFloat(t.invoiced) || 0]));
    const paidBy = new Map(paymentTotals.map((t) => [t.dealer_id, parseFloat(t.paid) || 0]));

    for (const d of dealers) {
      d.total_invoiced = invoicedBy.get(d.id) || 0;
      d.total_paid = paidBy.get(d.id) || 0;
      // Positive = the dealer owes us. Negative = they are in credit with us.
      d.balance = Math.round((d.total_invoiced - d.total_paid) * 100) / 100;
    }
    return dealers;
  }

  async getById(id) {
    const dealer = await db('dealers').where('id', id).first();
    if (!dealer) throw new AppError('Dealer not found', 404);

    const [invoiceTotal, paymentTotal, invoices, payments] = await Promise.all([
      db('wholesale_invoices').where('dealer_id', id).sum('total_amount as invoiced').first(),
      // Actual payments, not invoices.paid_amount — see list() for why.
      db('dealer_payments').where('dealer_id', id).sum('total_amount as paid').first(),
      db('wholesale_invoices').where('dealer_id', id).orderBy('invoice_date', 'desc'),
      db('dealer_payments').where('dealer_id', id).orderBy('payment_date', 'desc'),
    ]);

    dealer.total_invoiced = parseFloat(invoiceTotal?.invoiced) || 0;
    dealer.total_paid = parseFloat(paymentTotal?.paid) || 0;
    dealer.balance = Math.round((dealer.total_invoiced - dealer.total_paid) * 100) / 100;
    dealer.invoices = invoices;
    dealer.payments = payments;

    // What each payment is currently settling, so the screen can warn with specifics
    // before deleting one. One grouped query, not one per payment.
    if (payments.length) {
      const allocs = await db('dealer_payment_allocations')
        .join('wholesale_invoices', 'dealer_payment_allocations.invoice_id', 'wholesale_invoices.id')
        .whereIn('dealer_payment_allocations.payment_id', payments.map((p) => p.id))
        .select('dealer_payment_allocations.payment_id',
          'dealer_payment_allocations.allocated_amount',
          'wholesale_invoices.invoice_number');
      const byPayment = new Map();
      for (const a of allocs) {
        if (!byPayment.has(a.payment_id)) byPayment.set(a.payment_id, []);
        byPayment.get(a.payment_id).push(a);
      }
      for (const p of payments) {
        p.allocations = byPayment.get(p.id) || [];
        const applied = p.allocations.reduce((s, a) => s + parseFloat(a.allocated_amount), 0);
        p.allocated_amount = Math.round(applied * 100) / 100;
        // Money that landed on no invoice is credit the dealer still holds. Shown so
        // deleting a payment that settled nothing reads differently from one that
        // settled four invoices.
        p.unallocated_amount = Math.round((parseFloat(p.total_amount) - applied) * 100) / 100;
      }
    }

    return dealer;
  }

  async create(data) {
    const safeData = {
      id: generateUUID(),
      is_active: true,
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      notes: data.notes || null,
    };
    const [dealer] = await db('dealers').insert(safeData).returning('*');
    return dealer;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.name !== undefined) safeData.name = data.name;
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.email !== undefined) safeData.email = data.email;
    if (data.address !== undefined) safeData.address = data.address;
    if (data.notes !== undefined) safeData.notes = data.notes;
    const [dealer] = await db('dealers').where('id', id).update(safeData).returning('*');
    if (!dealer) throw new AppError('Dealer not found', 404);
    return dealer;
  }

  async delete(id) {
    const invCount = await db('wholesale_invoices').where('dealer_id', id).count('id as count').first();
    if (parseInt(invCount.count) > 0) {
      throw new AppError('Cannot delete dealer with existing invoices. Edit their info instead.', 400);
    }
    const count = await db('dealers').where('id', id).del();
    if (!count) throw new AppError('Dealer not found', 404);
  }

  // --- Wholesale Invoices ---
  async createInvoice(data, userId) {
    const invoiceId = generateUUID();
    const { boxes, ...invoiceData } = data;

    await db.transaction(async (trx) => {
      const invoiceNumber = await generateDocumentNumber('WI', trx, 'wholesale_invoices', 'invoice_number');
      await trx('wholesale_invoices').insert({
        id: invoiceId,
        invoice_number: invoiceNumber,
        dealer_id: invoiceData.dealer_id,
        total_amount: invoiceData.total_amount,
        invoice_date: invoiceData.invoice_date,
        notes: invoiceData.notes || null,
        paid_amount: 0,
        status: 'pending',
        created_by: userId,
      });

      if (boxes && boxes.length > 0) {
        for (const box of boxes) {
          const totalItems = Object.values(box.size_quantities).reduce((s, q) => s + q, 0);
          await trx('wholesale_invoice_boxes').insert({
            id: generateUUID(),
            invoice_id: invoiceId,
            product_id: box.product_id,
            product_color_id: box.product_color_id,
            size_quantities: JSON.stringify(box.size_quantities),
            price_per_item: box.price_per_item,
            total_items: totalItems,
            total_price: totalItems * box.price_per_item,
          });
        }
      }
    });

    return this.getInvoiceById(invoiceId);
  }

  async getInvoiceById(id) {
    const invoice = await db('wholesale_invoices')
      .leftJoin('dealers', 'wholesale_invoices.dealer_id', 'dealers.id')
      .where('wholesale_invoices.id', id)
      .select('wholesale_invoices.*', 'dealers.name as dealer_name')
      .first();
    if (!invoice) throw new AppError('Invoice not found', 404);

    invoice.boxes = await db('wholesale_invoice_boxes')
      .leftJoin('products', 'wholesale_invoice_boxes.product_id', 'products.id')
      .leftJoin('product_colors', 'wholesale_invoice_boxes.product_color_id', 'product_colors.id')
      .where('invoice_id', id)
      .select('wholesale_invoice_boxes.*', 'products.model_name as product_name', 'products.product_code', 'product_colors.color_name');

    invoice.allocations = await db('dealer_payment_allocations')
      .join('dealer_payments', 'dealer_payment_allocations.payment_id', 'dealer_payments.id')
      .where('invoice_id', id)
      .select('dealer_payment_allocations.*', 'dealer_payments.payment_method', 'dealer_payments.payment_date');

    return invoice;
  }

  // --- Dealer Payments (FIFO) ---

  /**
   * What an invoice's status is, given what has been paid against it.
   *
   * One definition, because three code paths now decide it — taking a payment,
   * editing one and deleting one — and a disagreement between them would show as an
   * invoice that says "paid" while still owing money.
   */
  static _statusFor(paid, total) {
    const p = Math.round(paid * 100) / 100;
    const t = Math.round(total * 100) / 100;
    if (p <= 0) return 'pending';
    return p >= t ? 'paid' : 'partial';
  }

  /**
   * Spread money across this dealer's unpaid invoices, oldest first.
   *
   * Returns whatever could not be placed, which is the dealer's credit toward invoices
   * they have not been sent yet.
   */
  async _allocateFifo(trx, { paymentId, dealerId, amount }) {
    let remaining = Math.round(parseFloat(amount) * 100) / 100;

    const invoices = await trx('wholesale_invoices')
      .where('dealer_id', dealerId)
      .whereIn('status', ['pending', 'partial'])
      // Same order as _reverseAllocations locks in, so two payments being settled at
      // once can never take the same two invoices in opposite orders and deadlock.
      .orderBy([{ column: 'invoice_date', order: 'asc' }, { column: 'id', order: 'asc' }])
      .forUpdate();

    for (const invoice of invoices) {
      if (remaining <= 0) break;
      const total = Math.round(parseFloat(invoice.total_amount) * 100) / 100;
      const owed = Math.round((total - parseFloat(invoice.paid_amount)) * 100) / 100;
      if (owed <= 0) continue;
      const alloc = Math.round(Math.min(remaining, owed) * 100) / 100;

      await trx('dealer_payment_allocations').insert({
        id: generateUUID(), payment_id: paymentId, invoice_id: invoice.id, allocated_amount: alloc,
      });

      const newPaid = Math.round((parseFloat(invoice.paid_amount) + alloc) * 100) / 100;
      await trx('wholesale_invoices').where('id', invoice.id).update({
        paid_amount: newPaid,
        status: DealersService._statusFor(newPaid, total),
        updated_at: new Date(),
      });
      remaining = Math.round((remaining - alloc) * 100) / 100;
    }

    return Math.max(0, remaining);
  }

  /**
   * Take a payment back off every invoice it was applied to.
   *
   * THE REASON THIS EXISTS AT ALL: `dealer_payment_allocations` cascades when the
   * payment row is deleted, so a plain `DELETE FROM dealer_payments` removes the
   * allocation rows and leaves `wholesale_invoices.paid_amount` still counting money
   * that is no longer recorded anywhere. The invoice would read "paid" forever while
   * the dealer's balance said they still owed it, and nothing on any screen would
   * explain the difference. The allocations have to be unwound BEFORE the payment goes.
   */
  async _reverseAllocations(trx, paymentId) {
    const allocations = await trx('dealer_payment_allocations')
      .join('wholesale_invoices', 'dealer_payment_allocations.invoice_id', 'wholesale_invoices.id')
      .where('dealer_payment_allocations.payment_id', paymentId)
      .orderBy([{ column: 'wholesale_invoices.invoice_date', order: 'asc' },
        { column: 'wholesale_invoices.id', order: 'asc' }])
      .select('dealer_payment_allocations.id', 'dealer_payment_allocations.invoice_id',
        'dealer_payment_allocations.allocated_amount');

    for (const a of allocations) {
      const invoice = await trx('wholesale_invoices').where('id', a.invoice_id).forUpdate().first();
      if (!invoice) continue;   // the invoice itself was deleted; its allocations went with it
      const total = Math.round(parseFloat(invoice.total_amount) * 100) / 100;
      // Clamped at zero. Arithmetic says it cannot go negative, but a negative
      // paid_amount would be an invoice that owes less than nothing, and no amount of
      // confidence in the arithmetic is worth writing that into the ledger.
      const newPaid = Math.max(0, Math.round((parseFloat(invoice.paid_amount) - parseFloat(a.allocated_amount)) * 100) / 100);
      await trx('wholesale_invoices').where('id', invoice.id).update({
        paid_amount: newPaid,
        status: DealersService._statusFor(newPaid, total),
        updated_at: new Date(),
      });
    }

    await trx('dealer_payment_allocations').where('payment_id', paymentId).del();
    return allocations.length;
  }

  async createPayment(data, userId) {
    const paymentId = generateUUID();
    let unallocated = 0;

    await db.transaction(async (trx) => {
      await trx('dealer_payments').insert({
        id: paymentId,
        dealer_id: data.dealer_id,
        total_amount: data.total_amount,
        payment_method: data.payment_method,
        payment_date: data.payment_date,
        reference_no: data.reference_no || null,
        notes: data.notes || null,
        created_by: userId,
      });

      // Whatever FIFO could not place is the dealer's credit toward future invoices.
      // It used to be dropped on the floor with no record of it anywhere.
      unallocated = await this._allocateFifo(trx, {
        paymentId, dealerId: data.dealer_id, amount: data.total_amount,
      });
    });

    const payment = await db('dealer_payments').where('id', paymentId).first();
    return { ...payment, unallocated_credit: unallocated };
  }

  /**
   * Change a recorded payment — most often because the amount was typed wrong.
   *
   * The money is un-applied and re-applied rather than adjusted in place, because
   * where it lands depends on what is outstanding NOW. An invoice may have been raised
   * or settled since, so re-running FIFO is the only way to get an allocation that
   * matches the books as they currently stand. The old split is not preserved and
   * should not be: it described a situation that no longer exists.
   */
  async updatePayment(id, data) {
    let unallocated = 0;

    await db.transaction(async (trx) => {
      const payment = await trx('dealer_payments').where('id', id).forUpdate().first();
      if (!payment) throw new AppError('Payment not found', 404);

      await this._reverseAllocations(trx, id);

      const next = {
        total_amount: data.total_amount !== undefined ? data.total_amount : payment.total_amount,
        payment_method: data.payment_method !== undefined ? data.payment_method : payment.payment_method,
        payment_date: data.payment_date !== undefined ? data.payment_date : payment.payment_date,
        reference_no: data.reference_no !== undefined ? (data.reference_no || null) : payment.reference_no,
        notes: data.notes !== undefined ? (data.notes || null) : payment.notes,
      };
      await trx('dealer_payments').where('id', id).update(next);

      unallocated = await this._allocateFifo(trx, {
        paymentId: id, dealerId: payment.dealer_id, amount: next.total_amount,
      });
    });

    const payment = await db('dealer_payments').where('id', id).first();
    return { ...payment, unallocated_credit: unallocated };
  }

  /** Remove a payment, putting back everything it had settled. */
  async deletePayment(id) {
    return db.transaction(async (trx) => {
      const payment = await trx('dealer_payments').where('id', id).forUpdate().first();
      if (!payment) throw new AppError('Payment not found', 404);

      const reopened = await this._reverseAllocations(trx, id);
      await trx('dealer_payments').where('id', id).del();
      return { id, dealer_id: payment.dealer_id, reopened_invoices: reopened };
    });
  }

  /**
   * One payment with the invoices it is currently settling.
   *
   * The screen needs this to warn with specifics before deleting — "this will reopen
   * 2 invoices" is a question somebody can answer, where "are you sure?" is not.
   */
  async getPaymentById(id) {
    const payment = await db('dealer_payments').where('id', id).first();
    if (!payment) throw new AppError('Payment not found', 404);
    payment.allocations = await db('dealer_payment_allocations')
      .join('wholesale_invoices', 'dealer_payment_allocations.invoice_id', 'wholesale_invoices.id')
      .where('dealer_payment_allocations.payment_id', id)
      .select('dealer_payment_allocations.allocated_amount',
        'wholesale_invoices.id as invoice_id', 'wholesale_invoices.invoice_number',
        'wholesale_invoices.status');
    return payment;
  }
}

module.exports = new DealersService();
