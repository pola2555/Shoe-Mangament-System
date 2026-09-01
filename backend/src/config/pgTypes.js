/**
 * How Postgres types arrive in JavaScript.
 *
 * THE BUG THIS FIXES
 *
 * node-postgres parses a `date` column into a JS Date at LOCAL midnight. A date has no
 * time and no timezone — it is a square on a calendar — so the moment it becomes an
 * instant it acquires both, and every conversion afterwards can move it:
 *
 *   stored          2026-07-01
 *   parsed          Wed Jul 01 2026 00:00:00 GMT+0300
 *   JSON response   "2026-06-30T21:00:00.000Z"     <- a day earlier
 *
 * Egypt runs at UTC+2/+3, so the API was sending every calendar date one day BEHIND
 * what the database holds, to every client that reads the date part of that string.
 * The old screens happened to survive it by parsing the instant back into local time,
 * which cancelled the shift — but anything that read the string directly, or did date
 * arithmetic on it, was quietly off by one. A rent template due on the 29th advanced to
 * the 28th, and lost another day every month it was posted.
 *
 * The fix is to stop converting at all: hand back the 'YYYY-MM-DD' string Postgres
 * sent. Timestamps are NOT touched — those genuinely are instants, and turning them
 * into strings would break every duration and ordering that depends on them.
 *
 * Affects: expenses.expense_date, expense_recurring.next_date/end_date,
 * expense_budgets.period_month, loans.loan_date/due_date, loan_payments.payment_date,
 * loan_installments.due_date, purchase_invoices.invoice_date,
 * wholesale_invoices.invoice_date, supplier_payments.payment_date,
 * dealer_payments.payment_date.
 */
const pg = require('pg');

// 1082 = DATE. Deliberately not 1114 (timestamp) or 1184 (timestamptz).
const PG_DATE_OID = 1082;

pg.types.setTypeParser(PG_DATE_OID, (value) => value);

module.exports = { PG_DATE_OID };
