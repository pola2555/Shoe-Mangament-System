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

async function probe() {
  const rows = await db('information_schema.columns')
    .where('table_schema', db.raw('current_schema()'))
    .whereIn('table_name', ['product_color_images', 'attached_images'])
    .where('column_name', 'thumb_url')
    .select('table_name');

  const tables = new Set(rows.map((r) => r.table_name));
  return {
    productImageThumbs: tables.has('product_color_images'),
    attachedImageThumbs: tables.has('attached_images'),
  };
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
        console.error('[schema] capability probe failed, assuming no thumbnails:', error.message);
        cache = { productImageThumbs: false, attachedImageThumbs: false };
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
