/**
 * Small shared pieces for the expenses screens.
 *
 * Kept out of the page components so the category picker, the recurring form and the
 * budget sheet all name a category the same way — "Utilities > Electricity", in the
 * user's own language — rather than each doing it slightly differently.
 */

/** The English or Arabic name of a row that carries both. */
export function catName(row, locale) {
  if (!row) return '';
  if (locale === 'ar') return row.name_ar || row.name_en || row.name || '';
  return row.name_en || row.name || row.name_ar || '';
}

/** "Utilities > Electricity" for a sub-category; just the name for a top-level one. */
export function catPath(row, locale, separator = ' › ') {
  if (!row) return '';
  const own = catName(row, locale);
  if (!row.parent_id) return own;
  const parent = locale === 'ar'
    ? (row.parent_name_ar || row.parent_name_en)
    : (row.parent_name_en || row.parent_name_ar);
  return parent ? `${parent}${separator}${own}` : own;
}

/** The same, for an EXPENSE row, whose category fields are prefixed. */
export function expenseCatPath(row, locale, t) {
  if (!row || !row.category_id) return t ? t('expenses.uncategorised') : '';
  const own = locale === 'ar'
    ? (row.category_name_ar || row.category_name_en)
    : (row.category_name_en || row.category_name_ar);
  const parent = locale === 'ar'
    ? (row.parent_name_ar || row.parent_name_en)
    : (row.parent_name_en || row.parent_name_ar);
  return parent ? `${parent} › ${own}` : own;
}

/**
 * Options for a category <select>, children indented under their parent.
 *
 * The list already arrives in parent-then-children order from the server, so this only
 * has to render it — no grouping pass, and the order cannot disagree with the table.
 */
export function categoryOptions(categories, locale, { includeBlank, blankLabel } = {}) {
  const opts = includeBlank ? [{ value: '', label: blankLabel || '—' }] : [];
  for (const c of categories) {
    opts.push({
      value: String(c.id),
      label: c.parent_id ? `   ${catName(c, locale)}` : catName(c, locale),
    });
  }
  return opts;
}

export const PAYMENT_METHODS = ['cash', 'bank', 'instapay', 'wallet', 'cheque', 'card', 'other'];

// Dates live in one place for the whole app — see utils/dates.js for why
// toISOString() is the wrong tool for a calendar date.
export { today, dateInput, monthInput, money } from '../../utils/dates';
