const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Categories, size scales and colour presets — the catalogue's reference data.
 *
 * Nothing here is deletable. Categories and scale values are referenced by products
 * and variants with RESTRICT, and a scale value that has already been printed onto a
 * label must keep resolving; `is_active = false` retires one without breaking history.
 * That is the same posture as products and colours elsewhere in this codebase
 * ("Cannot delete ... Deactivate it instead").
 */
class ProductCategoriesService {
  // ================================================================
  //  CATEGORIES
  // ================================================================

  async listCategories({ is_active, include_counts } = {}) {
    const q = db('product_categories as c')
      .join('size_scales as s', 's.id', 'c.size_scale_id')
      .select(
        'c.*',
        's.code as scale_code',
        's.name_en as scale_name_en',
        's.name_ar as scale_name_ar',
        's.display_prefix',
        's.display_suffix',
        's.is_numeric as scale_is_numeric'
      )
      .orderBy(['c.sort_order', 'c.name_en']);

    if (is_active !== undefined) q.where('c.is_active', is_active === 'false' ? false : !!is_active);

    const categories = await q;
    if (!include_counts) return categories;

    // One grouped count, not one query per category.
    const counts = await db('products')
      .whereNotNull('category_id')
      .select('category_id')
      .count('id as n')
      .groupBy('category_id');
    const byId = new Map(counts.map((r) => [r.category_id, Number(r.n)]));
    return categories.map((c) => ({ ...c, product_count: byId.get(c.id) || 0 }));
  }

  async getCategory(id) {
    const found = (await this.listCategories({})).find((c) => c.id === id);
    if (!found) throw new AppError('Category not found', 404);
    found.size_values = await this.listScaleValues(found.size_scale_id);
    return found;
  }

  /** The category a product belongs to, with its scale resolved. Used across services. */
  async getCategoryForProduct(productId, trx = db) {
    const row = await trx('products as p')
      .leftJoin('product_categories as c', 'c.id', 'p.category_id')
      .leftJoin('size_scales as s', 's.id', 'c.size_scale_id')
      .where('p.id', productId)
      .first(
        'c.id as category_id',
        'c.code as category_code',
        'c.has_colors',
        'c.has_sizes',
        'c.placeholder_color_name',
        'c.size_scale_id',
        's.code as scale_code',
        's.display_prefix',
        's.display_suffix',
        's.is_numeric as scale_is_numeric'
      );
    // A product with no category predates this feature. Treat it as the old behaviour —
    // colours and sizes both required — rather than throwing, so existing catalogue
    // rows keep working if the code ships ahead of the backfill.
    if (!row || !row.category_id) {
      return { category_id: null, has_colors: true, has_sizes: true, size_scale_id: null };
    }
    return row;
  }

  async createCategory(data) {
    await this._assertScaleExists(data.size_scale_id);
    await this._assertUnique('product_categories', 'code', data.code);
    const [category] = await db('product_categories')
      .insert({ id: generateUUID(), ...data })
      .returning('*');
    return category;
  }

  async updateCategory(id, data) {
    const current = await db('product_categories').where('id', id).first();
    if (!current) throw new AppError('Category not found', 404);
    if (data.size_scale_id) await this._assertScaleExists(data.size_scale_id);

    // Changing what a category *is* would invalidate variants already created against
    // the old shape: an EU 42 variant means nothing under a Kids/Teens/Adults scale,
    // and turning colours off would strand real colours behind a placeholder.
    const shapeChanged =
      (data.size_scale_id && data.size_scale_id !== current.size_scale_id) ||
      (data.has_colors !== undefined && data.has_colors !== current.has_colors) ||
      (data.has_sizes !== undefined && data.has_sizes !== current.has_sizes);

    if (shapeChanged) {
      const inUse = await db('product_variants')
        .join('products', 'products.id', 'product_variants.product_id')
        .where('products.category_id', id)
        .count('product_variants.id as n')
        .first();
      if (Number(inUse.n) > 0) {
        throw new AppError(
          `Cannot change the sizes or colours of this category: ${inUse.n} variant(s) already use it. ` +
            'Create a new category instead.',
          400
        );
      }
    }

    const allowed = ['name_en', 'name_ar', 'has_colors', 'has_sizes', 'size_scale_id',
      'placeholder_color_name', 'sort_order', 'is_active'];
    const safe = {};
    for (const k of allowed) if (data[k] !== undefined) safe[k] = data[k];
    safe.updated_at = new Date();

    const [category] = await db('product_categories').where('id', id).update(safe).returning('*');
    return category;
  }

  async toggleCategoryActive(id) {
    const current = await db('product_categories').where('id', id).first();
    if (!current) throw new AppError('Category not found', 404);
    const [category] = await db('product_categories')
      .where('id', id)
      .update({ is_active: !current.is_active, updated_at: new Date() })
      .returning('*');
    return category;
  }

  // ================================================================
  //  SIZE SCALES
  // ================================================================

  async listScales({ include_values } = {}) {
    const scales = await db('size_scales').orderBy(['is_system', 'name_en']);
    if (!include_values) return scales;

    const values = await db('size_scale_values').orderBy(['scale_id', 'sort_order']);
    const byScale = new Map();
    for (const v of values) {
      if (!byScale.has(v.scale_id)) byScale.set(v.scale_id, []);
      byScale.get(v.scale_id).push(v);
    }
    return scales.map((s) => ({ ...s, values: byScale.get(s.id) || [] }));
  }

  async getScale(id) {
    const scale = await db('size_scales').where('id', id).first();
    if (!scale) throw new AppError('Size list not found', 404);
    scale.values = await this.listScaleValues(id);
    return scale;
  }

  async listScaleValues(scaleId) {
    if (!scaleId) return [];
    // Usage counts drive the UI: a value already on a variant can be renamed or
    // reordered but never removed.
    const values = await db('size_scale_values').where('scale_id', scaleId).orderBy('sort_order');
    if (!values.length) return values;
    const counts = await db('product_variants')
      .whereIn('size_scale_value_id', values.map((v) => v.id))
      .select('size_scale_value_id')
      .count('id as n')
      .groupBy('size_scale_value_id');
    const byId = new Map(counts.map((r) => [r.size_scale_value_id, Number(r.n)]));
    return values.map((v) => ({ ...v, variant_count: byId.get(v.id) || 0 }));
  }

  async createScale(data) {
    await this._assertUnique('size_scales', 'code', data.code);
    const { values, ...scale } = data;
    return db.transaction(async (trx) => {
      const [created] = await trx('size_scales')
        .insert({ id: generateUUID(), ...scale })
        .returning('*');
      await trx('size_scale_values').insert(
        values.map((v) => ({ id: generateUUID(), scale_id: created.id, ...v }))
      );
      created.values = await trx('size_scale_values').where('scale_id', created.id).orderBy('sort_order');
      return created;
    });
  }

  async updateScale(id, data) {
    const current = await db('size_scales').where('id', id).first();
    if (!current) throw new AppError('Size list not found', 404);

    const allowed = ['name_en', 'name_ar', 'display_prefix', 'display_suffix', 'is_numeric', 'is_active'];
    const safe = {};
    for (const k of allowed) if (data[k] !== undefined) safe[k] = data[k];
    safe.updated_at = new Date();

    const [scale] = await db('size_scales').where('id', id).update(safe).returning('*');
    return scale;
  }

  /**
   * Replace a scale's whole value set in one transaction — that is what makes
   * reordering atomic rather than a series of individual moves.
   *
   * Values already used by a variant may be relabelled and reordered but not removed;
   * removing one would strand printed labels and leave variants sorting by a key that
   * no longer means anything.
   */
  async replaceScaleValues(scaleId, values) {
    const scale = await db('size_scales').where('id', scaleId).first();
    if (!scale) throw new AppError('Size list not found', 404);

    return db.transaction(async (trx) => {
      const existing = await trx('size_scale_values').where('scale_id', scaleId);
      const byValue = new Map(existing.map((v) => [v.value, v]));
      const keep = new Set(values.map((v) => v.value));

      const removed = existing.filter((v) => !keep.has(v.value));
      if (removed.length) {
        const used = await trx('product_variants')
          .whereIn('size_scale_value_id', removed.map((v) => v.id))
          .select('size_scale_value_id')
          .count('id as n')
          .groupBy('size_scale_value_id');
        if (used.length) {
          const names = removed
            .filter((r) => used.some((u) => u.size_scale_value_id === r.id))
            .map((r) => r.value)
            .join(', ');
          throw new AppError(
            `Cannot remove ${names}: product variants already use ${used.length === 1 ? 'it' : 'them'}. ` +
              'Untick Active to retire a size instead.',
            400
          );
        }
        await trx('size_scale_values').whereIn('id', removed.map((v) => v.id)).del();
      }

      for (const v of values) {
        const found = byValue.get(v.value);
        if (found) {
          await trx('size_scale_values').where('id', found.id).update({
            label_en: v.label_en ?? null,
            label_ar: v.label_ar ?? null,
            sort_order: v.sort_order,
            is_active: v.is_active === undefined ? true : v.is_active,
          });
        } else {
          await trx('size_scale_values').insert({
            id: generateUUID(),
            scale_id: scaleId,
            value: v.value,
            label_en: v.label_en ?? null,
            label_ar: v.label_ar ?? null,
            sort_order: v.sort_order,
            is_active: v.is_active === undefined ? true : v.is_active,
          });
        }
      }

      // Re-derive every affected variant's sort key from the new ordering. This is the
      // reason size_scale_value_id is stored at all: without it a reorder would leave
      // variants sorted by the old positions with no way back.
      await trx.raw(
        `UPDATE product_variants v
            SET size_sort = sv.sort_order
           FROM size_scale_values sv
          WHERE sv.id = v.size_scale_value_id
            AND sv.scale_id = ?`,
        [scaleId]
      );

      return trx('size_scale_values').where('scale_id', scaleId).orderBy('sort_order');
    });
  }

  // ================================================================
  //  COLOUR PRESETS
  // ================================================================

  async listColorPresets({ is_active } = {}) {
    const q = db('color_presets').orderBy(['sort_order', 'name_en']);
    if (is_active !== undefined) q.where('is_active', is_active === 'false' ? false : !!is_active);
    return q;
  }

  async createColorPreset(data) {
    await this._assertUnique('color_presets', 'name_en', data.name_en);
    const [preset] = await db('color_presets')
      .insert({ id: generateUUID(), ...data })
      .returning('*');
    return preset;
  }

  async updateColorPreset(id, data) {
    const allowed = ['name_en', 'name_ar', 'hex_code', 'sort_order', 'is_active'];
    const safe = {};
    for (const k of allowed) if (data[k] !== undefined) safe[k] = data[k];
    const [preset] = await db('color_presets').where('id', id).update(safe).returning('*');
    if (!preset) throw new AppError('Colour not found', 404);
    return preset;
  }

  // ================================================================

  async _assertScaleExists(scaleId) {
    const scale = await db('size_scales').where('id', scaleId).first('id');
    if (!scale) throw new AppError('Size list not found', 404);
  }

  /** Friendlier than letting the unique index surface as "already exists". */
  async _assertUnique(table, column, value) {
    if (value === undefined) return;
    const found = await db(table).where(column, value).first('id');
    if (found) throw new AppError(`"${value}" is already in use`, 409);
  }
}

module.exports = new ProductCategoriesService();
