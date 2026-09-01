const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const inventoryService = require('../inventory/inventory.service');
const { encodePriceCode } = require('../../utils/priceCode');
const {
  buildVariantBarcode,
  parseVariantBarcode,
  isValidEan13,
  isInternalBarcode,
  normalizeScan,
  sizeToCode,
  ESCAPE_SIZE_CODE_MIN,
  ESCAPE_SIZE_CODE_MAX,
} = require('../../utils/ean13');

/**
 * Barcode service — internal EAN-13 per product variant (product + colour + size).
 *
 * Allocation is idempotent everywhere: calling assign twice returns the same barcode
 * rather than minting a second one. Every allocation path locks its own row first, so
 * two concurrent requests for the same product/colour/variant cannot both take a number.
 */
class BarcodesService {
  // ---------------------------------------------------------------- allocation

  /**
   * Product number, from the global sequence. Locks the product row so concurrent
   * callers serialise rather than both calling nextval and one overwriting the other.
   */
  async _allocateProductSeq(trx, productId) {
    const product = await trx('products')
      .where('id', productId)
      .forUpdate()
      .first('id', 'barcode_seq');
    if (!product) throw new AppError('Product not found', 404);
    if (product.barcode_seq) return product.barcode_seq;

    const { rows } = await trx.raw("SELECT nextval('product_barcode_seq')::int AS seq");
    const seq = rows[0].seq;
    await trx('products').where('id', productId).update({ barcode_seq: seq });
    return seq;
  }

  /**
   * Colour number within the product, from the product's high-water mark.
   *
   * The mark lives on products and only ever increments. Deriving it from
   * MAX(color_seq) instead would re-issue a deleted colour's number, and every label
   * already printed for that colour would then scan as the new one.
   */
  async _allocateColorSeq(trx, productId, colorId) {
    const color = await trx('product_colors')
      .where('id', colorId)
      .forUpdate()
      .first('id', 'product_id', 'color_seq');
    if (!color) throw new AppError('Product colour not found', 404);
    if (color.color_seq) return color.color_seq;

    // Atomic bump; the UPDATE takes the product row lock for us.
    const { rows } = await trx.raw(
      'UPDATE products SET color_seq_hwm = color_seq_hwm + 1 WHERE id = ? RETURNING color_seq_hwm',
      [productId]
    );
    const seq = rows[0].color_seq_hwm;
    if (seq > 99) {
      throw new AppError(
        'This product has used all 99 colour slots its barcode format allows.',
        400
      );
    }
    await trx('product_colors').where('id', colorId).update({ color_seq: seq });
    return seq;
  }

  /**
   * Size code. Plain numbers encode directly as size x 2; anything else (a range like
   * '36-37', or a letter size) gets an escape code from the 900-999 band.
   */
  async _allocateSizeCode(trx, sizeEu) {
    const direct = sizeToCode(sizeEu);
    if (direct !== null) return direct;

    const key = String(sizeEu == null ? '' : sizeEu).trim();
    if (!key) throw new AppError('Variant has no size, so no barcode can be generated', 400);

    const existing = await trx('size_codes').where('size_eu', key).first('code');
    if (existing) return existing.code;

    // Serialise escape allocation; released on commit or rollback.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['barcode:sizecode']);

    // Re-check: another transaction may have inserted it while we waited for the lock.
    const again = await trx('size_codes').where('size_eu', key).first('code');
    if (again) return again.code;

    const max = await trx('size_codes').max('code as m').first();
    const next = max && max.m != null ? Number(max.m) + 1 : ESCAPE_SIZE_CODE_MIN;
    if (next > ESCAPE_SIZE_CODE_MAX) {
      throw new AppError('All 100 non-numeric size codes are in use', 400);
    }

    await trx('size_codes').insert({ code: next, size_eu: key });
    return next;
  }

  /**
   * Mint (or return the existing) barcode for one variant.
   * Idempotent, and safe to call inside a caller's transaction.
   */
  async assignForVariant(variantId, trx = db) {
    const run = async (t) => {
      const variant = await t('product_variants')
        .where('id', variantId)
        .forUpdate()
        .first('id', 'product_id', 'product_color_id', 'size_eu', 'barcode', 'barcode_source');
      if (!variant) throw new AppError('Variant not found', 404);
      if (variant.barcode) {
        return { barcode: variant.barcode, source: variant.barcode_source, created: false };
      }

      const productSeq = await this._allocateProductSeq(t, variant.product_id);
      const colorSeq = await this._allocateColorSeq(t, variant.product_id, variant.product_color_id);
      const sizeCode = await this._allocateSizeCode(t, variant.size_eu);

      const barcode = buildVariantBarcode({ productSeq, colorSeq, sizeCode });

      await t('product_variants')
        .where('id', variantId)
        .update({ barcode, barcode_source: 'generated' });

      return { barcode, source: 'generated', created: true };
    };

    return trx === db ? db.transaction(run) : run(trx);
  }

  /** Mint barcodes for every variant of a product that does not have one yet. */
  async assignForProduct(productId) {
    const variants = await db('product_variants')
      .where('product_id', productId)
      .orderBy('product_color_id')
      .orderBy(['size_sort', 'size_eu'])
      .select('id');
    if (!variants.length) throw new AppError('This product has no variants yet', 400);

    const results = [];
    // One transaction for the whole product: a half-numbered product would leave the
    // colour high-water mark advanced with nothing to show for it.
    await db.transaction(async (trx) => {
      for (const v of variants) {
        results.push({ variant_id: v.id, ...(await this.assignForVariant(v.id, trx)) });
      }
    });

    return {
      product_id: productId,
      total: results.length,
      created: results.filter((r) => r.created).length,
      already_had: results.filter((r) => !r.created).length,
      variants: results,
    };
  }

  /** Mint barcodes for an explicit set of variants. */
  async assignForVariants(variantIds) {
    const results = [];
    await db.transaction(async (trx) => {
      for (const id of variantIds) {
        results.push({ variant_id: id, ...(await this.assignForVariant(id, trx)) });
      }
    });
    return {
      total: results.length,
      created: results.filter((r) => r.created).length,
      already_had: results.filter((r) => !r.created).length,
      variants: results,
    };
  }

  // ---------------------------------------------------------------- manufacturer

  /**
   * Attach a barcode already printed on the manufacturer's box to a variant, so that
   * stock needs no label of our own. Rejects our own 2-prefix range: those are ours to
   * allocate and letting one be typed in by hand would collide with a future mint.
   */
  async linkManufacturerBarcode(variantId, rawCode) {
    const code = normalizeScan(rawCode);
    if (!isValidEan13(code)) {
      throw new AppError('That is not a valid EAN-13 barcode (check digit failed)', 400);
    }
    if (isInternalBarcode(code)) {
      throw new AppError(
        'Codes starting with 2 are reserved for in-store barcodes this system generates. Enter the manufacturer code from the box.',
        400
      );
    }

    return db.transaction(async (trx) => {
      const variant = await trx('product_variants').where('id', variantId).forUpdate().first();
      if (!variant) throw new AppError('Variant not found', 404);

      const clash = await trx('product_variants')
        .where('barcode', code)
        .whereNot('id', variantId)
        .first('id', 'sku');
      if (clash) {
        throw new AppError(`That barcode is already assigned to ${clash.sku}`, 409);
      }

      await trx('product_variants')
        .where('id', variantId)
        .update({ barcode: code, barcode_source: 'manufacturer' });

      return { variant_id: variantId, barcode: code, source: 'manufacturer' };
    });
  }

  /** Clear a variant's barcode so it can be re-minted or re-linked. */
  async clearBarcode(variantId) {
    const updated = await db('product_variants')
      .where('id', variantId)
      .update({ barcode: null, barcode_source: 'generated' });
    if (!updated) throw new AppError('Variant not found', 404);
    return { variant_id: variantId, barcode: null };
  }

  // ---------------------------------------------------------------- lookup (POS)

  /**
   * Resolve a scan to a concrete sellable pair.
   *
   * Always a database lookup — the digits are never decoded to find the variant. That
   * keeps an edited size or a re-pointed variant a cosmetic mismatch rather than a
   * mis-sale.
   */
  async lookup({ code: rawCode, store_id, store_ids, exclude_ids = [] }) {
    const code = normalizeScan(rawCode);

    if (!code) throw new AppError('No barcode was scanned', 400);
    if (!/^[0-9]+$/.test(code)) {
      throw new AppError('That scan is not a barcode. Check the scanner is not in keyboard-layout mode.', 400);
    }
    if (code.length !== 13) {
      throw new AppError(`Expected a 13-digit barcode but got ${code.length} digits`, 400);
    }
    if (!isValidEan13(code)) {
      throw new AppError('Barcode check digit failed — please rescan', 400);
    }

    const variant = await db('product_variants')
      .join('products', 'product_variants.product_id', 'products.id')
      .where('product_variants.barcode', code)
      .first(
        'product_variants.id',
        'product_variants.sku',
        'product_variants.size_eu',
        'product_variants.is_active',
        'products.model_name as product_name',
        'products.is_active as product_active'
      );

    if (!variant) {
      // Decode advisory info purely to make the error useful to a human.
      const parsed = parseVariantBarcode(code);
      throw new AppError(
        parsed
          ? 'This is one of our barcodes, but no product uses it. It may have been cleared or the label is out of date.'
          : 'Unknown barcode. Link it to a product first from the product page.',
        404
      );
    }
    if (variant.is_active === false || variant.product_active === false) {
      throw new AppError(`${variant.product_name} (${variant.sku}) is no longer active`, 400);
    }

    // Reuse inventory.list so the row shape matches exactly what the POS cart already
    // consumes — same pricing fallbacks, same image/thumbnail handling.
    const items = await inventoryService.list({
      variant_id: variant.id,
      status: 'in_stock',
      store_id,
      store_ids,
      limit: 500,
    });

    if (!items.length) {
      throw new AppError(
        `${variant.product_name} — size ${variant.size_eu} is out of stock in this store`,
        404
      );
    }

    const excluded = new Set(exclude_ids || []);
    // Oldest first: sell the pair that has been sitting longest. list() sorts newest
    // first, so reverse the comparison here rather than re-querying.
    const available = items
      .filter((i) => !excluded.has(i.id))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!available.length) {
      throw new AppError(
        `All ${items.length} pair(s) of ${variant.product_name} size ${variant.size_eu} in stock are already in the cart`,
        409
      );
    }

    return {
      item: available[0],
      barcode: code,
      variant_id: variant.id,
      available_count: available.length,
      in_cart_count: items.length - available.length,
    };
  }

  // ---------------------------------------------------------------- labels

  /**
   * Label payloads. One row per variant; the caller decides how many copies to print.
   * `price_code` is computed here so there is a single implementation of the price
   * obfuscation rather than one on each side of the wire.
   */
  async labels({ variant_ids, product_id, invoice_box_id, store_id, store_ids }) {
    let q = db('product_variants')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('store_product_prices', function () {
        this.on('store_product_prices.product_id', '=', 'products.id').andOn(
          'store_product_prices.store_id',
          '=',
          db.raw('?', [store_id || null])
        );
      })
      .select(
        'product_variants.id as variant_id',
        'product_variants.sku',
        'product_variants.size_eu',
        'product_variants.barcode',
        'product_variants.barcode_source',
        'products.id as product_id',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'products.default_selling_price',
        'store_product_prices.selling_price as store_selling_price',
        'product_colors.color_name',
        'product_colors.hex_code',
        'product_colors.is_placeholder as color_is_placeholder',
        'product_variants.size_sort',
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        // A label prints what the shop calls the size, not the code it is stored as.
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes'
      );

    if (variant_ids && variant_ids.length) {
      q = q.whereIn('product_variants.id', variant_ids);
    } else if (product_id) {
      q = q.where('products.id', product_id);
    } else if (invoice_box_id) {
      // One label per pair actually received into stock from this box.
      const variantIds = db('inventory_items')
        .where('invoice_box_id', invoice_box_id)
        .distinct('variant_id');
      q = q.whereIn('product_variants.id', variantIds);
    } else {
      throw new AppError('Specify variant_ids, product_id or invoice_box_id', 400);
    }

    // size_sort is the stored numeric sort key. It replaces a regex cast over size_eu,
    // which could only order sizes that were numeric in the first place.
    const rows = await q
      .orderBy('products.model_name')
      .orderBy('product_colors.color_name')
      .orderBy(['product_variants.size_sort', 'product_variants.size_eu']);

    // How many pairs of each variant are actually in stock, so the print dialog can
    // default to "one label per pair on hand" instead of making the user count.
    const counts = await this._stockCounts(
      rows.map((r) => r.variant_id),
      { store_id, store_ids, invoice_box_id }
    );

    return rows.map((r) => {
      const price = r.store_selling_price ?? r.default_selling_price;
      return {
        ...r,
        price: price == null ? null : parseFloat(price),
        price_code: encodePriceCode(price),
        stock_count: counts.get(r.variant_id) || 0,
      };
    });
  }

  async _stockCounts(variantIds, { store_id, store_ids, invoice_box_id }) {
    if (!variantIds.length) return new Map();
    let q = db('inventory_items')
      .whereIn('variant_id', variantIds)
      .where('status', 'in_stock')
      .groupBy('variant_id')
      .select('variant_id')
      .count('* as c');

    if (invoice_box_id) q = q.where('invoice_box_id', invoice_box_id);
    require('../../utils/storeScope').applyStoreScope(q, 'inventory_items.store_id', {
      store_id,
      store_ids,
    });

    const rows = await q;
    return new Map(rows.map((r) => [r.variant_id, Number(r.c)]));
  }
}

module.exports = new BarcodesService();
