const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const { capabilities } = require('../../utils/schemaCapabilities');

/**
 * Inventory service — view, filter, and manually add inventory items.
 * 
 * Every physical shoe is one row in inventory_items.
 * Items are auto-created when boxes are marked complete (see purchases service).
 * This module provides manual entry for legacy/pre-system stock and viewing/filtering.
 */
// One summary row = one (product, colour, size, store) combination, so the ceiling
// has to be well above the product count. Bounded purely to stop a pathological
// query, not to paginate.
const SUMMARY_MAX_ROWS = 10000;

/**
 * Clamp a caller-supplied limit so a client can never ask for the whole table.
 */
function clampLimit(limit, max) {
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return max;
  return Math.min(parsed, max);
}

/**
 * A list as a query string can actually carry it: a real array (?v=a&v=b), a single
 * value, or one comma-joined string — which is what the frontend sends.
 */
function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Size filtering, for scales that are numbers and scales that are words.
 *
 * Two filters, because one cannot do both jobs:
 *
 *   size_values   exact match against the size as stored ('Kids', 'M', '95', 'OS').
 *                 The only filter a non-numeric scale can use at all.
 *   size_min/max  numeric comparison. size_eu is a varchar, so a plain `>=` is
 *                 lexical and '9' >= '10' is true; the cast fixes that.
 *
 * A size that is not a number yields NULL from the cast, and `NULL >= 38` is NULL, so
 * a numeric range excludes it. That is the right reading of "sizes 38 to 46" — but the
 * range used to be the ONLY size filter in the app, which meant a shop selling socks
 * could not filter them at all AND every numeric range made them silently vanish from
 * inventory. size_values is the missing half; the UI offers whichever control the
 * selected category's scale can actually use, and never a numeric range for words.
 */
function applySizeFilter(qb, { size_min, size_max, size_values } = {}) {
  const values = asList(size_values);
  if (values.length) qb.whereIn('product_variants.size_eu', values);

  // Extract the FIRST number rather than stripping non-digits. Stripping turned a
  // range label like '36.5-37.5' into '36.537.5', which is not valid numeric and
  // aborted the entire query, and turned '38-39' into 3839, which sorted nonsensically.
  // No '?' in the pattern — knex treats it as a bind placeholder inside raw SQL.
  const numericSize = "NULLIF(substring(product_variants.size_eu from '[0-9]+[.]{0,1}[0-9]*'), '')::numeric";
  const min = parseFloat(size_min);
  const max = parseFloat(size_max);
  if (Number.isFinite(min)) qb.whereRaw(`${numericSize} >= ?`, [min]);
  if (Number.isFinite(max)) qb.whereRaw(`${numericSize} <= ?`, [max]);
  return qb;
}

/**
 * Colour filtering, by name rather than by product_colors.id.
 *
 * A colour row belongs to one product: "Black" on a Nike and "Black" on an Adidas are
 * two different rows with two different ids. Filtering by id would therefore mean
 * "black, but only this one product's black", which is not what anybody picking a
 * colour chip means. Names are what the shop actually uses — they are typed once into
 * the colour presets and reused — so the filter matches on the name, case-insensitively.
 *
 * The placeholder colour is never offered as a choice (see variantIdentity.js): it is
 * the stand-in for "this category has no colours", not a colour.
 */
function applyColorFilter(qb, { colors } = {}) {
  const values = asList(colors);
  if (!values.length) return qb;
  qb.whereRaw(
    `LOWER(product_colors.color_name) = ANY(?::text[])`,
    [values.map((v) => v.toLowerCase())]
  );
  qb.where('product_colors.is_placeholder', false);
  return qb;
}

/**
 * LATERAL lookup of one representative image per product colour.
 * Selects thumb_url only when the column exists, so the query still runs on a
 * database where migration 20260814_002 has not been applied yet.
 */
function colorImageLateral(hasThumbs) {
  const thumbCol = hasThumbs ? 'pci.thumb_url' : 'NULL::text as thumb_url';
  return `LEFT JOIN LATERAL (
    SELECT pci.image_url, ${thumbCol}
    FROM product_color_images pci
    WHERE pci.product_color_id = product_colors.id
    ORDER BY pci.is_primary DESC, pci.created_at ASC
    LIMIT 1
  ) color_img ON TRUE`;
}

class InventoryService {
  async list({ store_id, store_ids, product_id, variant_id, category_id, status, source, search, size_min, size_max, size_values, colors, supplier_id, limit } = {}) {
    const { productImageThumbs: hasThumbs } = await capabilities();
    let query = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      // Advisory join, and LEFT by design: size_scale_value_id may be null for a
      // variant created before the categories feature, and an inner join here would
      // silently drop it from stock. See the doctrine note in variantIdentity.js.
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .join('stores', 'inventory_items.store_id', 'stores.id')
      .leftJoin('store_product_prices', function() {
        this.on('store_product_prices.product_id', '=', 'products.id')
            .andOn('store_product_prices.store_id', '=', 'inventory_items.store_id');
      })
      .joinRaw(colorImageLateral(hasThumbs))
      .select(
        'inventory_items.*',
        'product_variants.sku',
        'product_variants.barcode',
        'product_variants.size_eu',
        'product_variants.size_us',
        'product_variants.size_uk',
        'product_variants.size_cm',
        'product_variants.product_color_id',
        // summary() has always returned product_id; list() did not, so a caller with a
        // row in hand could not ask anything else about its product without a lookup.
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.default_selling_price',
        'products.min_selling_price',
        'products.max_selling_price',
        'store_product_prices.selling_price as store_selling_price',
        'store_product_prices.min_selling_price as store_min_selling_price',
        'store_product_prices.max_selling_price as store_max_selling_price',
        'product_colors.color_name',
        'product_colors.hex_code',
        // How this row's size is written, and whether its colour is the "no colour"
        // placeholder. See frontend/src/utils/variantFormat.js.
        'product_colors.is_placeholder as color_is_placeholder',
        'product_variants.size_sort',
        'products.category_id',
        'pcat.has_sizes',
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'stores.name as store_name',
        // LATERAL instead of two correlated subqueries: one lookup per row for both
        // columns, and it can use an index on product_color_id.
        'color_img.image_url as color_image_url',
        db.raw('COALESCE(color_img.thumb_url, color_img.image_url) as color_image_thumb_url')
      )
      .orderBy('inventory_items.created_at', 'desc');

    applyStoreScope(query, 'inventory_items.store_id', { store_id, store_ids });
    if (variant_id) query = query.where('inventory_items.variant_id', variant_id);
    if (status) query = query.where('inventory_items.status', status);
    if (source) query = query.where('inventory_items.source', source);
    if (product_id) query = query.where('products.id', product_id);
    if (category_id) query = query.where('products.category_id', category_id);
    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('product_variants.sku', 'ilike', `%${safeSearch}%`)
          .orWhere('product_variants.barcode', 'ilike', `%${safeSearch}%`)
          .orWhere('products.model_name', 'ilike', `%${safeSearch}%`)
          .orWhere('products.product_code', 'ilike', `%${safeSearch}%`)
          .orWhere('products.brand', 'ilike', `%${safeSearch}%`);
      });
    }
    applySizeFilter(query, { size_min, size_max, size_values });
    applyColorFilter(query, { colors });
    if (supplier_id) {
      query = query
        .join('purchase_invoice_boxes', 'inventory_items.invoice_box_id', 'purchase_invoice_boxes.id')
        .join('purchase_invoices', 'purchase_invoice_boxes.invoice_id', 'purchase_invoices.id')
        .where('purchase_invoices.supplier_id', supplier_id);
    }

    return query.limit(clampLimit(limit, 500));
  }

  /**
   * Get a summary of inventory: grouped by product variant + store with counts.
   */
  async summary({ store_id, store_ids, category_id, search, size_min, size_max, size_values, colors, limit } = {}) {
    const { productImageThumbs: hasThumbs } = await capabilities();
    let query = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      // Advisory join, and LEFT by design: size_scale_value_id may be null for a
      // variant created before the categories feature, and an inner join here would
      // silently drop it from stock. See the doctrine note in variantIdentity.js.
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .join('stores', 'inventory_items.store_id', 'stores.id')
      .leftJoin('store_product_prices', function() {
        this.on('store_product_prices.product_id', '=', 'products.id')
            .andOn('store_product_prices.store_id', '=', 'inventory_items.store_id');
      })
      .joinRaw(colorImageLateral(hasThumbs))
      .where('inventory_items.status', 'in_stock')
      .select(
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.net_price',
        'products.default_selling_price',
        'products.min_selling_price',
        'products.max_selling_price',
        'store_product_prices.selling_price as store_selling_price',
        'store_product_prices.min_selling_price as store_min_selling_price',
        'store_product_prices.max_selling_price as store_max_selling_price',
        'product_colors.color_name',
        'product_colors.hex_code',
        'product_variants.id as variant_id',
        'product_variants.size_eu',
        'product_variants.size_sort',
        'product_variants.sku',
        'product_variants.barcode',
        'product_colors.is_placeholder as color_is_placeholder',
        'products.category_id',
        'pcat.has_sizes',
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'stores.id as store_id',
        'stores.name as store_name',
        db.raw('COUNT(inventory_items.id) as quantity'),
        db.raw('AVG(inventory_items.cost) as avg_cost'),
        // Scoped to the row's own colour. The old subquery matched on product_id, so
        // every colour of a product showed whichever colour's image happened to sort
        // first — unlike list(), which scoped correctly to product_color_id.
        'color_img.image_url as product_image',
        db.raw('COALESCE(color_img.thumb_url, color_img.image_url) as product_image_thumb')
      )
      .groupBy(
        'products.id', 'products.product_code', 'products.model_name', 'products.brand',
        'products.net_price',
        'products.default_selling_price', 'products.min_selling_price', 'products.max_selling_price',
        'store_product_prices.selling_price', 'store_product_prices.min_selling_price', 'store_product_prices.max_selling_price',
        'product_colors.color_name', 'product_colors.hex_code',
        'product_colors.is_placeholder',
        'products.category_id', 'pcat.has_sizes',
        'sscale.display_prefix', 'sscale.display_suffix',
        'ssv.label_en', 'ssv.label_ar',
        'product_variants.id', 'product_variants.size_eu', 'product_variants.size_sort',
        'product_variants.sku', 'product_variants.barcode',
        'stores.id', 'stores.name',
        // Selected from the LATERAL join, so they must be grouped too.
        'color_img.image_url', 'color_img.thumb_url'
      )
      .orderBy(['products.product_code', 'product_colors.color_name',
        'product_variants.size_sort', 'product_variants.size_eu']);

    applyStoreScope(query, 'inventory_items.store_id', { store_id, store_ids });
    if (category_id) query = query.where('products.category_id', category_id);

    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('products.model_name', 'ilike', `%${safeSearch}%`)
          .orWhere('products.product_code', 'ilike', `%${safeSearch}%`)
          .orWhere('products.brand', 'ilike', `%${safeSearch}%`)
          .orWhere('product_colors.color_name', 'ilike', `%${safeSearch}%`)
          .orWhere('product_variants.sku', 'ilike', `%${safeSearch}%`)
          .orWhere('product_variants.barcode', 'ilike', `%${safeSearch}%`)
          .orWhere(db.raw('CAST(product_variants.size_eu AS TEXT)'), 'ilike', `%${safeSearch}%`)
          .orWhere(db.raw('CAST(inventory_items.cost AS TEXT)'), 'ilike', `%${safeSearch}%`);
      });
    }

    applySizeFilter(query, { size_min, size_max, size_values });
    applyColorFilter(query, { colors });

    // Previously unbounded: the POS calls this on every search and could pull the
    // entire in-stock table, each row carrying a correlated image subquery.
    //
    // The cap is high because a row here is one (product, colour, size, store)
    // combination — a few hundred products easily exceeds 500 rows, and the
    // inventory tree and Word export both need the full set. Callers that only
    // need a page of results (the POS search) pass their own smaller limit.
    return query.limit(clampLimit(limit, SUMMARY_MAX_ROWS));
  }



  /**
   * One row per product, for the till's product grid.
   *
   * The grid draws a card per product, but it was being fed `summary()`, which returns
   * one row per (product, colour, size, store) and carries an image, a price band, a
   * SKU and a barcode on every one of them. Measured on this catalogue: **58 rows and
   * 49 KB to draw 13 cards**. The row count grows as products x colours x sizes while
   * the card count grows as products, so a real catalogue — 500 products, 4 colours,
   * 8 sizes — is 16,000 rows. The till asked for 5000 of them on every search, which
   * both moved megabytes and, worse, *silently truncated the catalogue*: stock past the
   * cap simply did not appear, with nothing on screen to say so.
   *
   * This aggregates in SQL instead. The cap now bounds products, which is what the grid
   * actually shows, so hitting it means "too many products to display", not "some of
   * your stock is invisible".
   *
   * Colours and sizes are deliberately NOT returned. The cashier picks those in the
   * product modal, which fetches them for the one product it needs.
   */
  async productGrid({ store_id, store_ids, category_id, search, size_min, size_max,
    size_values, colors, limit } = {}) {
    const { productImageThumbs: hasThumbs } = await capabilities();

    // The filters decide which VARIANTS count, then the aggregate rolls them up to
    // products. A product is listed when at least one of its variants survives the
    // filter — which is what "show me shoes in size 42" means.
    const base = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('store_product_prices', function () {
        this.on('store_product_prices.product_id', '=', 'products.id')
          .andOn('store_product_prices.store_id', '=', 'inventory_items.store_id');
      })
      .where('inventory_items.status', 'in_stock');

    applyStoreScope(base, 'inventory_items.store_id', { store_id, store_ids });
    if (category_id) base.where('products.category_id', category_id);
    if (search) {
      const safeSearch = String(search).replace(/[%_\\]/g, '\\$&');
      base.where(function () {
        this.where('products.model_name', 'ilike', `%${safeSearch}%`)
          .orWhere('products.product_code', 'ilike', `%${safeSearch}%`)
          .orWhere('products.brand', 'ilike', `%${safeSearch}%`)
          .orWhere('product_colors.color_name', 'ilike', `%${safeSearch}%`)
          .orWhere('product_variants.sku', 'ilike', `%${safeSearch}%`)
          .orWhere('product_variants.barcode', 'ilike', `%${safeSearch}%`)
          .orWhere(db.raw('CAST(product_variants.size_eu AS TEXT)'), 'ilike', `%${safeSearch}%`);
      });
    }
    applySizeFilter(base, { size_min, size_max, size_values });
    applyColorFilter(base, { colors });

    // MIN over the per-store price: a product is one card, and store_product_prices is
    // unique per (store, product), so within one store this is that single value.
    // Across several stores it is the lowest, which is the honest thing to show on a
    // card that is not store-specific.
    const rows = await base
      .select(
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.category_id',
        db.raw('COUNT(inventory_items.id)::int as quantity'),
        db.raw('COUNT(DISTINCT product_variants.id)::int as variant_count'),
        db.raw('MIN(COALESCE(store_product_prices.selling_price, products.default_selling_price)) as price_from'),
        db.raw('MAX(COALESCE(store_product_prices.selling_price, products.default_selling_price)) as price_to'),
        db.raw('MIN(products.default_selling_price) as default_selling_price'),
        db.raw('MIN(store_product_prices.selling_price) as store_selling_price')
      )
      .groupBy('products.id', 'products.product_code', 'products.model_name',
        'products.brand', 'products.category_id')
      .orderBy('products.model_name')
      .limit(clampLimit(limit, 200));

    if (!rows.length) return rows;

    // One image per product, fetched for the page of products actually being shown
    // rather than carried on every variant row. A LATERAL keeps it to one lookup per
    // product and lets it use the index on product_color_id.
    const thumbCol = hasThumbs ? 'pci.thumb_url' : 'NULL::text';
    const images = await db('products')
      .whereIn('products.id', rows.map((r) => r.product_id))
      .joinRaw(`LEFT JOIN LATERAL (
        SELECT pci.image_url, ${thumbCol} as thumb_url
        FROM product_colors pc
        JOIN product_color_images pci ON pci.product_color_id = pc.id
        WHERE pc.product_id = products.id
        ORDER BY pci.is_primary DESC, pci.created_at ASC
        LIMIT 1
      ) img ON TRUE`)
      .select('products.id', 'img.image_url', 'img.thumb_url');

    const imageById = new Map(images.map((i) => [i.id, i]));
    return rows.map((r) => {
      const img = imageById.get(r.product_id);
      return {
        ...r,
        product_image: img?.image_url || null,
        product_image_thumb: img?.thumb_url || img?.image_url || null,
      };
    });
  }

  /**
   * What is actually on the shelves, as a set of filter chips.
   *
   * The till used to build its size chips from the chosen category's whole size list,
   * which offers EU 30 to EU 50 for a shop that stocks 40 to 45 — most of the buttons
   * find nothing, and a cashier learns to distrust them. These come from stock: every
   * chip returned has at least one pair behind it, and the count is on the chip.
   *
   * It also replaces a much worse habit. The POS asked for 5000 summary rows on every
   * search partly so it could see what colours and sizes existed; three grouped counts
   * are a fraction of that, and they do not grow with the catalogue.
   *
   * **Each facet is computed with every filter EXCEPT its own.** Otherwise picking
   * "Black" removes every other colour from the colour row, and there is no way back
   * to a different colour without clearing the filter — a dead end that reads as a
   * broken screen rather than as a filter doing its job.
   */
  async facets({ store_id, store_ids, category_id, search, size_values, colors } = {}) {
    const base = (opts) => {
      const q = db('inventory_items')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
        .where('inventory_items.status', 'in_stock');
      applyStoreScope(q, 'inventory_items.store_id', { store_id, store_ids });
      if (opts.category !== false && category_id) q.where('products.category_id', category_id);
      if (search) {
        const safe = String(search).replace(/[%_\\]/g, '\\$&');
        q.where(function () {
          this.where('products.model_name', 'ilike', `%${safe}%`)
            .orWhere('products.product_code', 'ilike', `%${safe}%`)
            .orWhere('products.brand', 'ilike', `%${safe}%`)
            .orWhere('product_colors.color_name', 'ilike', `%${safe}%`)
            .orWhere('product_variants.sku', 'ilike', `%${safe}%`);
        });
      }
      if (opts.size !== false) applySizeFilter(q, { size_values });
      if (opts.color !== false) applyColorFilter(q, { colors });
      return q;
    };

    // Colours: every colour but its own filter. Placeholder rows are excluded — a
    // knife's stand-in colour is not a colour anybody wants to filter by.
    const colorsQ = base({ color: false })
      .where('product_colors.is_placeholder', false)
      .select(
        db.raw('MIN(product_colors.color_name) as name'),
        db.raw('MIN(product_colors.hex_code) as hex_code'),
        db.raw('COUNT(inventory_items.id)::int as count')
      )
      .groupByRaw('LOWER(product_colors.color_name)')
      .orderByRaw('COUNT(inventory_items.id) DESC, MIN(product_colors.color_name)')
      .limit(60);

    // Sizes carry their scale's wording, so the chips read "80 cm" and "Kids" rather
    // than the raw stored value — the same formatSize the rest of the app uses.
    const sizesQ = base({ size: false })
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .select(
        'product_variants.size_eu as value',
        db.raw('MIN(product_variants.size_sort) as size_sort'),
        db.raw('MIN(ssv.label_en) as size_label_en'),
        db.raw('MIN(ssv.label_ar) as size_label_ar'),
        db.raw('MIN(sscale.display_prefix) as size_prefix'),
        db.raw('MIN(sscale.display_suffix) as size_suffix'),
        db.raw('bool_or(COALESCE(pcat.has_sizes, true)) as has_sizes'),
        db.raw('COUNT(inventory_items.id)::int as count')
      )
      .groupBy('product_variants.size_eu')
      .orderByRaw('MIN(product_variants.size_sort), product_variants.size_eu')
      .limit(120);

    const categoriesQ = base({ category: false })
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .select(
        db.raw('pcat.id as category_id'),
        db.raw("COALESCE(pcat.name_en, 'Uncategorised') as name_en"),
        'pcat.name_ar',
        db.raw('COUNT(inventory_items.id)::int as count')
      )
      .groupBy('pcat.id', 'pcat.name_en', 'pcat.name_ar')
      .orderByRaw('COUNT(inventory_items.id) DESC');

    const [colorRows, sizeRows, categoryRows] = await Promise.all([colorsQ, sizesQ, categoriesQ]);

    return {
      colors: colorRows,
      // A one-size product has nothing worth putting on a chip.
      sizes: sizeRows.filter((r) => r.has_sizes !== false),
      categories: categoryRows,
    };
  }

  /**
   * Manually add inventory items (for legacy/pre-system stock).
   * Creates N items with source='manual'.
   */
  async manualEntry({ variant_id, store_id, cost, quantity, notes }) {
    // Validate variant and store exist
    const variant = await db('product_variants').where('id', variant_id).first();
    if (!variant) throw new AppError('Product variant not found', 404);

    const store = await db('stores').where('id', store_id).first();
    if (!store) throw new AppError('Store not found', 404);

    const items = [];
    for (let i = 0; i < quantity; i++) {
      items.push({
        id: generateUUID(),
        variant_id,
        store_id,
        cost,
        source: 'manual',
        status: 'in_stock',
        notes: notes || 'Manual entry — pre-existing stock',
      });
    }

    await db('inventory_items').insert(items);
    return { created: items.length, variant_sku: variant.sku, store_name: store.name };
  }

  /**
   * Mark an inventory item as damaged.
   */
  async markDamaged(itemId, notes) {
    const [item] = await db('inventory_items')
      .where('id', itemId)
      .where('status', 'in_stock')
      .update({ status: 'damaged', notes, updated_at: new Date() })
      .returning('*');

    if (!item) throw new AppError('Item not found or not in stock', 404);
    return item;
  }
}

module.exports = new InventoryService();
// Shared so the sale detail can show the same picture the inventory list does,
// without a second copy of the query drifting from this one.
module.exports.colorImageLateral = colorImageLateral;
