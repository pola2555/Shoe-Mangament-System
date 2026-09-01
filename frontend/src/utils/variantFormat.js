/**
 * How a variant's size and colour are written, anywhere they are shown.
 *
 * "EU" used to be hard-coded in sixteen places — labels, the POS, inventory, sales,
 * transfers, returns, the Word export, the thermal printer commands. That was fine
 * while the catalogue was shoes. A sock size now reads "Kids", a belt "95 cm", and a
 * bag has no size at all; printing "EU Kids" on a label is not a small mistake.
 *
 * Two things drive it, both coming from the product's category:
 *   size_prefix / size_suffix   'EU' + '42' -> "EU 42";  '95' + 'cm' -> "95 cm"
 *   color_is_placeholder        the row's colour stands in for "no colour"
 *
 * Every function tolerates a row that carries none of those fields and falls back to
 * exactly what the app printed before, so the frontend and backend can be deployed in
 * either order.
 */

/** Backend rows are flat; a product payload nests the same values under `category`. */
function scaleOf(row) {
  if (!row) return {};
  if (row.size_prefix !== undefined || row.size_suffix !== undefined) {
    return { prefix: row.size_prefix, suffix: row.size_suffix };
  }
  if (row.category) {
    return { prefix: row.category.display_prefix, suffix: row.category.display_suffix };
  }
  if (row.display_prefix !== undefined || row.display_suffix !== undefined) {
    return { prefix: row.display_prefix, suffix: row.display_suffix };
  }
  // Nothing known about the scale — this row predates the categories feature, and it
  // can only be a shoe, which is what the app used to assume unconditionally.
  return { prefix: 'EU', suffix: '', legacy: true };
}

/**
 * What the shop calls this size, falling back to how it is stored.
 *
 * A size list holds both: `value` is the code that goes into SKUs and barcodes and
 * must stay stable, `label_en`/`label_ar` is what a person reads. Storing 'KIDS' and
 * showing 'Kids' is the whole point of having both — so the label wins wherever the
 * API supplies one, and a list that sets no label (the shoe sizes, the belt lengths)
 * falls through to the value unchanged.
 */
function sizeText(row, locale) {
  const raw = row.size_eu ?? row.size ?? '';
  const localized = locale === 'ar' ? row.size_label_ar : row.size_label_en;
  return row.size_label || localized || row.size_label_en || String(raw ?? '');
}

/** The size as a person reads it: "EU 42", "Kids", "95 cm", "One size". */
export function formatSize(row, locale) {
  if (!row) return '';
  const raw = row.size_eu ?? row.size ?? '';
  if (raw === '' || raw === null || raw === undefined) return '';

  // A one-size product has a real stored value ('OS') so that SKUs and barcodes work,
  // but showing it to anyone would be noise.
  if (isOneSize(row)) return row.size_label || '';

  const { prefix, suffix } = scaleOf(row);
  return [prefix, sizeText(row, locale), suffix].filter(Boolean).join(' ');
}

/** Just the value, for tight cells and thermal labels: "42", "Kids", "95". */
export function formatSizeShort(row, locale) {
  if (!row) return '';
  if (isOneSize(row)) return row.size_label || '';
  return sizeText(row, locale);
}

/** True when the row's size is the "no size at all" sentinel. */
export function isOneSize(row) {
  if (!row) return false;
  if (row.has_sizes === false) return true;
  const raw = String(row.size_eu ?? row.size ?? '');
  // 'OS' is the seeded one-size value. Checked as a fallback only: has_sizes is
  // authoritative when the row carries it.
  return raw === 'OS' && (row.size_prefix === '' || row.size_prefix === undefined);
}

/** The colour name, or null when the row's colour is the "no colour" placeholder. */
export function formatColor(row) {
  if (!row) return null;
  if (row.color_is_placeholder || row.is_placeholder) return null;
  return row.color_name || null;
}

/** "Black · EU 42", dropping whichever half does not apply. */
export function variantLabel(row, separator = ' · ', locale) {
  return [formatColor(row), formatSize(row, locale)].filter(Boolean).join(separator);
}

/**
 * Sort comparator for sizes.
 *
 * Uses size_sort, the numeric key the server stores, which is what makes 9 come before
 * 10 and Kids before Adults. Falls back to a numeric parse for rows that predate it,
 * which is the behaviour the client-side sorts had before.
 */
export function compareSize(a, b) {
  const sa = a?.size_sort;
  const sb = b?.size_sort;
  if (sa !== undefined && sa !== null && sb !== undefined && sb !== null) {
    if (Number(sa) !== Number(sb)) return Number(sa) - Number(sb);
  }
  const na = parseFloat(a?.size_eu ?? a?.size);
  const nb = parseFloat(b?.size_eu ?? b?.size);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a?.size_eu ?? a?.size ?? '').localeCompare(String(b?.size_eu ?? b?.size ?? ''));
}

/** Sort a plain list of size strings using a lookup of value -> sort_order. */
export function compareSizeValue(a, b, sortByValue = {}) {
  const sa = sortByValue[a];
  const sb = sortByValue[b];
  if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * The Arabic or English name of a row that carries both.
 *
 * Category and size-list names live in the database, not in the translation files,
 * because a shop adds its own. `t()` cannot reach them.
 */
export function localizedName(row, language) {
  if (!row) return '';
  if (language === 'ar') return row.name_ar || row.name_en || '';
  return row.name_en || row.name_ar || '';
}

/** The label for one size-list value, falling back to the raw value. */
export function sizeValueLabel(value, language) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const label = language === 'ar' ? value.label_ar : value.label_en;
  return label || value.value || '';
}
