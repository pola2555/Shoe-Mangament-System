/**
 * How a variant's size and colour are written in output the SERVER renders.
 *
 * Almost every screen formats these on the client, in
 * `frontend/src/utils/variantFormat.js` — that file is the canonical rule and this one
 * mirrors it. The exception is the spreadsheet export, which is built here and would
 * otherwise ship the raw stored values: a sock as "KIDS", a knife's stand-in colour as
 * "Standard", and every non-shoe with no unit at all.
 *
 * Keep the two in step. The rules are three lines each and both are covered by
 * `scripts/check-filters.js`.
 *
 * Every function tolerates a row carrying none of the category fields and falls back
 * to what the app printed before categories existed, so it is safe on a row that
 * predates the feature.
 */

/** True when the row's size is the "no size at all" sentinel. */
function isOneSize(row) {
  if (!row) return false;
  if (row.has_sizes === false) return true;
  // 'OS' is the seeded one-size value, checked only as a fallback: has_sizes is
  // authoritative whenever the row carries it.
  return String(row.size_eu ?? row.size ?? '') === 'OS' && !row.size_prefix;
}

/**
 * The size as a person reads it: "EU 42", "Kids", "95 cm", or '' for a one-size item.
 *
 * A size list holds both a `value` (the code that goes into SKUs and barcodes, which
 * must stay stable) and a label. The label wins wherever there is one; a list that
 * sets none — the shoe sizes, the belt lengths — falls through to the value.
 */
function formatSize(row, locale) {
  if (!row) return '';
  const raw = row.size_eu ?? row.size ?? '';
  if (raw === '' || raw === null || raw === undefined) return '';
  if (isOneSize(row)) return '';

  const localized = locale === 'ar' ? row.size_label_ar : row.size_label_en;
  const text = localized || row.size_label_en || String(raw);

  // No category on the row means it predates this feature, and back then every
  // product was a shoe — which is exactly what the app used to print.
  const hasScale = row.size_prefix !== undefined || row.size_suffix !== undefined;
  const prefix = hasScale ? row.size_prefix : 'EU';
  const suffix = hasScale ? row.size_suffix : '';

  return [prefix, text, suffix].filter(Boolean).join(' ');
}

/** The colour name, or '' when the row's colour is the "no colour" placeholder. */
function formatColor(row) {
  if (!row) return '';
  if (row.color_is_placeholder || row.is_placeholder) return '';
  return row.color_name || '';
}

module.exports = { formatSize, formatColor, isOneSize };
