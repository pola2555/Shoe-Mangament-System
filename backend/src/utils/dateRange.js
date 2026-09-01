/**
 * Date range helpers for reporting.
 *
 * Two bugs these exist to prevent:
 *
 *   1. `new Date().toISOString().split('T')[0]` yields the *UTC* date. For a store in
 *      Egypt (UTC+2/+3) the dashboard's "today" began at 02:00/03:00 local time, so
 *      early-morning sales were counted against the previous day.
 *
 *   2. `where(col, '<=', endDate + ' 23:59:59')` silently drops anything in the final
 *      second of the day (23:59:59.001–23:59:59.999). Use a half-open interval instead:
 *      `>= start AND < end + 1 day`.
 */

// Business timezone. Egypt has no DST at present, but going through Intl rather than a
// fixed offset means this keeps working if that changes or the business relocates.
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Africa/Cairo';

/**
 * Today's date in the business timezone, as 'YYYY-MM-DD'.
 * @param {Date} [now]
 */
function businessDayStart(now = new Date()) {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly what Postgres wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The exact instant a business day begins, as a Date.
 *
 * Returning the 'YYYY-MM-DD' string alone is not enough: Postgres interprets a bare
 * date literal in the *server's* timezone when comparing against a timestamptz. With
 * the server on UTC, '2026-08-15' means 03:00 Cairo — so a "today" snapshot read zero
 * for the first three hours of every local day.
 *
 * @param {string} dateStr - 'YYYY-MM-DD' in the business timezone
 * @returns {Date} the UTC instant of local midnight on that date
 */
function businessDayBoundary(dateStr) {
  // Probe midnight UTC on the target date, measure the zone's offset at that instant,
  // then shift by it. Two passes settle any DST transition near midnight.
  let guess = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const offsetMs = offsetAt(guess);
    guess = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
  }
  return guess;
}

/**
 * The business timezone's UTC offset, in milliseconds, at a given instant.
 */
function offsetAt(instant) {
  // 'en-US' + longOffset yields e.g. "GMT+03:00"; parse it rather than assuming +02.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * ((Number(match[2]) * 60 + Number(match[3])) * 60 * 1000);
}

/**
 * A DATE column's value as 'YYYY-MM-DD'.
 *
 * node-postgres hands back a `date` as a JS Date at LOCAL midnight. Calling
 * toISOString() on it converts to UTC and moves the day BACKWARDS for every timezone
 * east of Greenwich — which includes Egypt at UTC+2/+3, the timezone this system runs
 * in. A rent template due on the 29th was therefore read as the 28th, advanced to the
 * 28th of the next month, and lost another day every time it was posted.
 *
 * Read the local calendar fields instead; they are what the database meant.
 */
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Add N days to a 'YYYY-MM-DD' string, returning the same format.
 * Uses UTC arithmetic on a date-only value, so no DST edge cases apply.
 */
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Apply a half-open date range to a knex query builder.
 *
 * @param {import('knex').Knex.QueryBuilder} qb
 * @param {string} column - fully qualified, e.g. 'sales.created_at'
 * @param {{ startDate?: string, endDate?: string }} range - 'YYYY-MM-DD' values
 */
function applyDateRange(qb, column, { startDate, endDate } = {}) {
  // Bind real instants, not bare date strings, so the boundary lands on local
  // midnight regardless of the database server's timezone.
  //
  // Both sides are validated: several callers (e.g. /api/audit-log) have no Joi
  // schema, and an unparseable value would otherwise bind an Invalid Date and 500.
  const start = normalizeDate(startDate);
  if (start) qb.where(column, '>=', businessDayBoundary(start));

  const end = normalizeDate(endDate);
  if (end) {
    const exclusiveEnd = addDays(end, 1);
    // `< end + 1 day` rather than `<= end 23:59:59`, so the last second isn't lost.
    if (exclusiveEnd) qb.where(column, '<', businessDayBoundary(exclusiveEnd));
  }
  return qb;
}

/**
 * Accept only a well-formed calendar date, returning 'YYYY-MM-DD' or null.
 * Rejects both malformed strings and real-looking-but-invalid dates (2026-02-30).
 */
function normalizeDate(value) {
  if (!value) return null;
  const str = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip check catches overflow like 2026-02-30 -> 2026-03-02.
  return d.toISOString().slice(0, 10) === str ? str : null;
}

/**
 * Default window for reports called with no explicit range.
 * Without this, every dashboard load scans the full sales history.
 */
function defaultRange(range = {}, days = 90) {
  // An explicit all-time request must not be silently narrowed. The reports UI has an
  // "All Time" option that sends no dates at all, which is indistinguishable from a
  // caller that simply forgot one — so it sets this flag to say the omission is
  // deliberate.
  if (range.all_time === '1' || range.all_time === true || range.all_time === 'true') {
    return {};
  }
  if (range.startDate || range.endDate) return range;
  const end = businessDayStart();
  return { startDate: addDays(end, -days), endDate: end };
}

module.exports = {
  toDateOnly,
  BUSINESS_TIMEZONE,
  businessDayStart,
  businessDayBoundary,
  normalizeDate,
  addDays,
  applyDateRange,
  defaultRange,
};
