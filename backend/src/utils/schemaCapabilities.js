const db = require('../config/database');

/**
 * Runtime schema capability detection.
 *
 * The thumbnail work adds `thumb_url` columns via migration 20260814_002, but the
 * application code must keep working on a database where that migration has not run
 * yet — code and schema are deployed separately here, and the app should not hard-fail
 * on a column it can degrade without.
 *
 * Each capability is probed once against information_schema and cached for the life of
 * the process. When absent, callers fall back to the full-size image URL.
 */

let cache = null;
let inFlight = null;

/**
 * Every column the code can run without, as `table.column`, mapped to the capability
 * name callers ask for. One probe covers all of them — adding a column here costs
 * nothing at runtime.
 */
const OPTIONAL_COLUMNS = {
  'product_color_images.thumb_url': 'productImageThumbs',
  'attached_images.thumb_url': 'attachedImageThumbs',
  'expense_recurring.anchor_day': 'recurringAnchorDay',
  'inventory_items.cost_is_estimated': 'estimatedCostTracking',
};

async function probe() {
  const wanted = Object.keys(OPTIONAL_COLUMNS).map((k) => k.split('.'));

  const rows = await db('information_schema.columns')
    .where('table_schema', db.raw('current_schema()'))
    .whereIn('table_name', [...new Set(wanted.map(([t]) => t))])
    .whereIn('column_name', [...new Set(wanted.map(([, c]) => c))])
    .select('table_name', 'column_name');

  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return Object.fromEntries(
    Object.entries(OPTIONAL_COLUMNS).map(([key, name]) => [name, present.has(key)])
  );
}

/**
 * Resolve the capability set, probing at most once even under concurrent callers.
 * A probe failure degrades to "no thumbnails" rather than taking the request down.
 */
async function capabilities() {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = probe()
      .then((result) => { cache = result; return result; })
      .catch((error) => {
        console.error('[schema] capability probe failed, assuming none present:', error.message);
        cache = Object.fromEntries(Object.values(OPTIONAL_COLUMNS).map((n) => [n, false]));
        return cache;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Clear the cache — used by tests and after running migrations in-process. */
function resetCapabilities() {
  cache = null;
  inFlight = null;
}

module.exports = { capabilities, resetCapabilities };
