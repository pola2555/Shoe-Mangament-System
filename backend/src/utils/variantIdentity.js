const AppError = require('./AppError');
const { generateUUID } = require('./generateCodes');
const { sizeSortOf } = require('./sizeSort');

/**
 * Resolving the colour and size a variant is created with, and the SKU that names it.
 *
 * This lives outside the products module because three call sites need identical
 * behaviour: products.createVariant, products.bulkCreateVariants and
 * purchases.completeBox (which auto-creates variants when stock is received). They
 * used to carry three slightly different copies of the SKU rule, and only one of them
 * handled collisions — which is how SKU generation drifts.
 *
 * THE INVARIANT (see the header of 20260901_002_product_categories.js): a variant
 * always has a real colour and a real, non-empty size. A category with has_colors =
 * false gets a placeholder colour row; a category with has_sizes = false resolves to
 * its scale's sole value, 'OS'. Nothing downstream ever sees a NULL, so none of the
 * ten INNER JOINs on product_colors had to change, and the barcode allocator needs no
 * special case: 'OS' takes an escape code exactly as 'M' would.
 */

/** Look up the category a product belongs to, with its size scale resolved. */
async function categoryOfProduct(trx, productId) {
  const row = await trx('products as p')
    .leftJoin('product_categories as c', 'c.id', 'p.category_id')
    .leftJoin('size_scales as s', 's.id', 'c.size_scale_id')
    .where('p.id', productId)
    .first(
      'c.id as category_id',
      'c.has_colors',
      'c.has_sizes',
      'c.placeholder_color_name',
      'c.size_scale_id',
      's.code as scale_code'
    );
  // A product with no category predates this feature — behave exactly as before:
  // colour and size are both required from the caller.
  if (!row || !row.category_id) {
    return { category_id: null, has_colors: true, has_sizes: true, size_scale_id: null };
  }
  return row;
}

/**
 * The single colour row a colourless product hangs everything off.
 *
 * Created on demand rather than only at product-create time, so a product that
 * predates its category's has_colors flag still works. The partial unique index
 * uq_product_colors_one_placeholder is what guarantees there is never more than one.
 */
async function ensurePlaceholderColor(trx, productId, category) {
  const existing = await trx('product_colors')
    .where({ product_id: productId, is_placeholder: true })
    .first();
  if (existing) return existing;

  const [created] = await trx('product_colors')
    .insert({
      id: generateUUID(),
      product_id: productId,
      color_name: category.placeholder_color_name || 'Standard',
      is_placeholder: true,
    })
    .returning('*');
  return created;
}

/**
 * Decide the colour and size for a new variant.
 *
 * @param {object}  opts
 * @param {boolean} opts.allowOffScale  accept a size the category does not list
 * @returns {{color, size_eu, size_sort, size_scale_value_id}}
 */
async function resolveVariantTarget(trx, product, data, category, opts = {}) {
  const cat = category || (await categoryOfProduct(trx, product.id));

  // ---- colour ----
  let color;
  if (data.product_color_id) {
    color = await trx('product_colors')
      .where({ id: data.product_color_id, product_id: product.id })
      .first();
    if (!color) throw new AppError('Color not found for this product', 404);
  } else if (!cat.has_colors) {
    color = await ensurePlaceholderColor(trx, product.id, cat);
  } else {
    throw new AppError('A colour is required for this product', 400);
  }

  // ---- size ----
  let sizeEu = data.size_eu === undefined || data.size_eu === null ? null : String(data.size_eu).trim();
  if (!sizeEu) {
    if (cat.has_sizes) throw new AppError('A size is required for this product', 400);
    // No sizes: take the scale's only value rather than inventing one, so the label
    // and the barcode both resolve through the same row as everything else.
    const sole = await trx('size_scale_values')
      .where('scale_id', cat.size_scale_id)
      .orderBy('sort_order')
      .first();
    if (!sole) {
      throw new AppError('This category has no sizes configured, so a variant cannot be created', 400);
    }
    sizeEu = sole.value;
  }

  // Link to the scale value when the size is one of them. That link is advisory — it
  // exists so sort keys can be re-derived if the scale is reordered — and its absence
  // only costs a digit-derived fallback ordering.
  const scaleValue = cat.size_scale_id
    ? await trx('size_scale_values').where({ scale_id: cat.size_scale_id, value: sizeEu }).first()
    : null;

  // The category owns the size list, so a size that is not on it is a typo, and a typo
  // that reaches the catalogue becomes a real size with real stock behind it. Receiving
  // stock is the deliberate exception (allowOffScale): refusing a delivery at the loading
  // bay over a mistyped size is worse than accepting it and sorting it out later.
  if (!scaleValue && cat.size_scale_id && !opts.allowOffScale) {
    const allowed = await trx('size_scale_values')
      .where({ scale_id: cat.size_scale_id, is_active: true })
      .orderBy('sort_order')
      .pluck('value');
    throw new AppError(
      `"${sizeEu}" is not one of this category's sizes (${allowed.join(', ')}). `
      + 'Add it to the size list first if it should be.',
      400
    );
  }

  return {
    color,
    size_eu: sizeEu,
    size_sort: scaleValue ? scaleValue.sort_order : sizeSortOf(sizeEu),
    size_scale_value_id: scaleValue ? scaleValue.id : null,
  };
}

/**
 * Three letters that stand for a colour, inside a SKU.
 *
 * Taking the first three letters put "Black" and "Black and White" both at BLA. Two
 * colours of one product then wanted the same SKU for the same size, and before SKU
 * generation was shared (three copies of it, only one handling collisions) that
 * surfaced to the user as "a record with this value already exists" the moment they
 * added sizes to the second colour.
 *
 *   one word      first three letters      Black           -> BLA
 *   two or more   first letter, then the   Black and White -> BWH
 *                 first two of the LAST    Red Wine        -> RWI
 *                 word, which is the one   Light Blue      -> LBL
 *                 that actually varies     Light Green     -> LGR
 *
 * Single-word colours are deliberately unchanged, so this does not reshape the SKUs
 * a catalogue already has. The numeric suffix below stays regardless: a product code
 * can be edited and a colour renamed, so uniqueness must never rest on an
 * abbreviation.
 */
function colorAbbr(colorName) {
  const words = String(colorName || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'STD';
  const abbr = words.length === 1
    ? words[0].slice(0, 3)
    : words[0].slice(0, 1) + words[words.length - 1].slice(0, 2);
  return abbr.toUpperCase();
}

/**
 * PRODUCT_CODE-COL-SIZE, guaranteed unique and within varchar(50).
 *
 * The size segment is never empty, which is what keeps two colours of the same product
 * from generating the same SKU. The collision suffix still exists because product codes
 * can be edited and colours renamed.
 */
async function generateSku(trx, product, color, sizeEu) {
  const code = product.product_code || 'NOCODE';
  const abbr = colorAbbr(color.color_name);
  const base = `${code}-${abbr}-${sizeEu}`.substring(0, 50);

  const existing = await trx('product_variants').where('sku', base).first('id');
  if (!existing) return base;

  // Escape the LIKE wildcards: '_' matches any character, so a code containing one
  // would count unrelated SKUs and pick a suffix that is itself taken.
  const escaped = base.replace(/[%_\\]/g, '\\$&');
  const { cnt } = await trx('product_variants')
    .where('sku', 'like', `${escaped}%`)
    .count('id as cnt')
    .first();

  for (let n = Number(cnt) + 1; n < Number(cnt) + 50; n++) {
    const suffix = `-${n}`;
    const candidate = base.substring(0, 50 - suffix.length) + suffix;
    const taken = await trx('product_variants').where('sku', candidate).first('id');
    if (!taken) return candidate;
  }
  throw new AppError(`Could not generate a unique SKU for ${base}`, 409);
}

module.exports = {
  categoryOfProduct,
  ensurePlaceholderColor,
  resolveVariantTarget,
  generateSku,
  colorAbbr,
};
