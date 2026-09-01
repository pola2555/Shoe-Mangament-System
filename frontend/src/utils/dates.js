/**
 * Calendar dates in the browser.
 *
 * `new Date(...).toISOString().split('T')[0]` is the wrong tool for a calendar date and
 * it is used in a dozen places. toISOString converts to UTC, so in Egypt (UTC+2/+3):
 *
 *   new Date()                       at 01:00 on the 5th  ->  "...-04"   yesterday
 *   new Date(2026, 8, 1)             the 1st of September ->  "2026-08-31"
 *
 * The second one is the damaging case: it is how the reports page built "This Month",
 * so every monthly report silently began on the last day of the previous month.
 *
 * A date has no timezone. Read the local calendar fields and format them.
 */

/** 'YYYY-MM-DD' from a Date's own calendar fields — never through UTC. */
export function toLocalDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today, in the browser's own calendar. */
export function today() {
  return toLocalDate(new Date());
}

/**
 * A DATE from the API as 'YYYY-MM-DD', for an <input type="date">.
 *
 * The server now sends calendar dates as plain strings (see config/pgTypes.js), so the
 * common case is a slice. A Date is still handled for anything that has been through
 * `new Date()` on the way here.
 */
export function dateInput(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return toLocalDate(new Date(value));
}

/** First day of the month, for an <input type="month">. */
export function monthInput(value) {
  return dateInput(value).slice(0, 7);
}

/** Start and end of the month `d` falls in, as calendar dates. */
export function monthRange(d = new Date()) {
  return {
    start: toLocalDate(new Date(d.getFullYear(), d.getMonth(), 1)),
    end: toLocalDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

/** Start and end of the year `d` falls in. */
export function yearRange(d = new Date()) {
  return {
    start: toLocalDate(new Date(d.getFullYear(), 0, 1)),
    end: toLocalDate(new Date(d.getFullYear(), 11, 31)),
  };
}

/** Start of the week (Sunday) `d` falls in. */
export function weekStart(d = new Date()) {
  const start = new Date(d);
  start.setDate(start.getDate() - start.getDay());
  return toLocalDate(start);
}

export function money(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${currency ? ' ' + currency : ''}`;
}
