/**
 * The single definition of a supplier's balance.
 *
 * Three call sites previously computed this three different ways — suppliers.list,
 * suppliers.getById and purchases.createInvoice agreed with each other, while the
 * financial report used `SUM(total_amount) - SUM(paid_amount)`, ignoring discounts,
 * returns and withdrawals. The suppliers page and the financial report therefore
 * reported different debt for the same supplier.
 *
 *   balance = invoiced(net of discount) - returns - payments + withdrawals
 *
 * Positive balance = we owe the supplier. Negative = the supplier holds our credit.
 */

/**
 * Correlated-subquery form: one row per supplier, no fan-out from joining several
 * one-to-many tables at once (which would multiply the sums).
 *
 * @param {import('knex')} db - knex instance or transaction
 * @param {string[]} [supplierIds] - restrict to these suppliers; omit for all
 * @returns {import('knex').Knex.QueryBuilder} rows of
 *   { id, name, total_invoiced, total_returns, total_paid, total_withdrawn, balance }
 */
function supplierBalanceQuery(db, supplierIds) {
  const q = db('suppliers')
    .select(
      'suppliers.id',
      'suppliers.name',
      db.raw(`COALESCE((
        SELECT SUM(pi.total_amount - COALESCE(pi.discount_amount, 0))
        FROM purchase_invoices pi WHERE pi.supplier_id = suppliers.id
      ), 0) as total_invoiced`),
      db.raw(`COALESCE((
        SELECT SUM(sr.total_amount)
        FROM supplier_returns sr WHERE sr.supplier_id = suppliers.id
      ), 0) as total_returns`),
      db.raw(`COALESCE((
        SELECT SUM(sp.total_amount)
        FROM supplier_payments sp
        WHERE sp.supplier_id = suppliers.id AND sp.type = 'payment'
      ), 0) as total_paid`),
      db.raw(`COALESCE((
        SELECT SUM(sp.total_amount)
        FROM supplier_payments sp
        WHERE sp.supplier_id = suppliers.id AND sp.type = 'withdrawal'
      ), 0) as total_withdrawn`)
    )
    .select(
      db.raw(`(
        COALESCE((SELECT SUM(pi.total_amount - COALESCE(pi.discount_amount, 0))
                  FROM purchase_invoices pi WHERE pi.supplier_id = suppliers.id), 0)
        - COALESCE((SELECT SUM(sr.total_amount)
                    FROM supplier_returns sr WHERE sr.supplier_id = suppliers.id), 0)
        - COALESCE((SELECT SUM(sp.total_amount) FROM supplier_payments sp
                    WHERE sp.supplier_id = suppliers.id AND sp.type = 'payment'), 0)
        + COALESCE((SELECT SUM(sp.total_amount) FROM supplier_payments sp
                    WHERE sp.supplier_id = suppliers.id AND sp.type = 'withdrawal'), 0)
      ) as balance`)
    );

  if (supplierIds?.length) q.whereIn('suppliers.id', supplierIds);
  return q;
}

/**
 * Suppliers who are currently owed money, most-owed first.
 *
 * Wraps supplierBalanceQuery in a subselect: `balance` is an output alias over
 * correlated subqueries, and Postgres allows neither WHERE nor HAVING to reference an
 * output alias — and there is no GROUP BY here for a HAVING to attach to.
 *
 * @param {import('knex')} db
 * @param {number} limit
 */
function suppliersWithOutstandingBalance(db, limit = 10) {
  return db
    .select('*')
    .from(supplierBalanceQuery(db).as('balances'))
    .where('balance', '>', 0)
    .orderBy('balance', 'desc')
    .limit(limit);
}

/**
 * Balance for one supplier, as a plain number.
 *
 * @param {import('knex')} db - knex instance or transaction
 * @param {string} supplierId
 * @param {object} [opts]
 * @param {string} [opts.excludeInvoiceId] - ignore this invoice, for computing the
 *   balance *before* an invoice that has already been inserted in this transaction.
 */
async function getSupplierBalance(db, supplierId, { excludeInvoiceId } = {}) {
  const exclusion = excludeInvoiceId ? 'AND pi.id <> ?' : '';
  const bindings = excludeInvoiceId
    ? [supplierId, excludeInvoiceId, supplierId, supplierId, supplierId]
    : [supplierId, supplierId, supplierId, supplierId];

  const row = await db
    .raw(
      `SELECT
        COALESCE((SELECT SUM(pi.total_amount - COALESCE(pi.discount_amount, 0))
                  FROM purchase_invoices pi WHERE pi.supplier_id = ? ${exclusion}), 0) as total_invoiced,
        COALESCE((SELECT SUM(sr.total_amount)
                  FROM supplier_returns sr WHERE sr.supplier_id = ?), 0) as total_returns,
        COALESCE((SELECT SUM(sp.total_amount) FROM supplier_payments sp
                  WHERE sp.supplier_id = ? AND sp.type = 'payment'), 0) as total_paid,
        COALESCE((SELECT SUM(sp.total_amount) FROM supplier_payments sp
                  WHERE sp.supplier_id = ? AND sp.type = 'withdrawal'), 0) as total_withdrawn`,
      bindings
    )
    .then((r) => r.rows[0]);

  const invoiced = parseFloat(row.total_invoiced) || 0;
  const returns = parseFloat(row.total_returns) || 0;
  const paid = parseFloat(row.total_paid) || 0;
  const withdrawn = parseFloat(row.total_withdrawn) || 0;

  return {
    total_invoiced: invoiced,
    total_returns: returns,
    total_paid: paid,
    total_withdrawn: withdrawn,
    balance: Math.round((invoiced - returns - paid + withdrawn) * 100) / 100,
  };
}

module.exports = { supplierBalanceQuery, suppliersWithOutstandingBalance, getSupplierBalance };
