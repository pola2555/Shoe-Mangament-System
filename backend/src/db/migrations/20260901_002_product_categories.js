/**
 * Product categories, size scales and colour presets.
 *
 * The catalogue could only describe shoes: product_variants.product_color_id and
 * size_eu are both NOT NULL, and the natural key is (product, colour, size). A bag
 * with no size and a knife with no colour had nowhere to go.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS SCHEMA DEPENDS ON: colour and size are never NULL or empty.
 *
 * A category with has_colors = false gets ONE placeholder product_colors row per
 * product (product_colors.is_placeholder). A category with has_sizes = false points
 * at the `one_size` scale, whose single value is the real string 'OS'.
 *
 * That is what lets everything downstream stay exactly as it is. Ten queries INNER
 * JOIN product_colors (inventory, sales, transfers, customers, barcodes, products);
 * making the column nullable would mean rewriting every one of them and leaving every
 * FUTURE join a trap that silently drops rows — a failure this codebase has already
 * had three times (see the comments in expenses.service.js and inventory.service.js).
 * It would also void UNIQUE(product_id, product_color_id, size_eu), because Postgres
 * treats NULLs as distinct, so a product could collect unlimited duplicate variants.
 *
 * It also means barcodes need no change at all: 'OS' is non-numeric, so it takes an
 * escape code from the existing 900-999 band exactly as S/M/L would, and SKUs stay
 * unique because the size segment of the SKU is never empty.
 *
 * Corollary: product_variants.size_scale_value_id is ADVISORY. It exists so sort keys
 * can be re-derived when a scale is reordered. size_eu and size_sort are load-bearing;
 * size_scale_value_id must never appear in an INNER JOIN.
 * ---------------------------------------------------------------------------
 *
 * down() restores the schema, not the data. Placeholder colours and 'OS' variants are
 * deliberately left behind, because inventory_items references variants with
 * ON DELETE RESTRICT and deleting them would destroy stock history. After a rollback a
 * colourless product is simply a product whose colour is named 'Standard'.
 */

const SIZE_DIGITS = "NULLIF(substring(size_eu from '[0-9]+[.]{0,1}[0-9]*'), '')::numeric";

/** EU shoe sizes 30-50 in half steps. sort_order = value * 10 so halves interleave. */
function euShoeValues() {
  const out = [];
  for (let tenths = 300; tenths <= 500; tenths += 5) {
    const n = tenths / 10;
    out.push({ value: String(n % 1 === 0 ? n : n.toFixed(1)), sort_order: tenths });
  }
  return out;
}

const SCALES = [
  {
    code: 'eu_shoe',
    name_en: 'EU shoe sizes', name_ar: 'مقاسات أحذية أوروبية',
    display_prefix: 'EU', display_suffix: '', is_numeric: true, is_system: true,
    values: euShoeValues(),
  },
  {
    code: 'one_size',
    name_en: 'One size', name_ar: 'مقاس واحد',
    display_prefix: '', display_suffix: '', is_numeric: false, is_system: true,
    // 'OS' is a real value on purpose — an empty size would collide in the SKU and
    // has no barcode escape code. See the header.
    values: [{ value: 'OS', label_en: 'One size', label_ar: 'مقاس واحد', sort_order: 0 }],
  },
  {
    code: 'age_group',
    name_en: 'Age group', name_ar: 'الفئة العمرية',
    display_prefix: '', display_suffix: '', is_numeric: false, is_system: false,
    values: [
      { value: 'KIDS', label_en: 'Kids', label_ar: 'أطفال', sort_order: 10 },
      { value: 'TEENS', label_en: 'Teens', label_ar: 'مراهقون', sort_order: 20 },
      { value: 'ADULTS', label_en: 'Adults', label_ar: 'بالغون', sort_order: 30 },
    ],
  },
  {
    code: 'alpha_clothing',
    name_en: 'Small / Medium / Large', name_ar: 'صغير / وسط / كبير',
    display_prefix: '', display_suffix: '', is_numeric: false, is_system: false,
    values: [
      { value: 'XS', label_en: 'Extra small', label_ar: 'صغير جدًا', sort_order: 10 },
      { value: 'S', label_en: 'Small', label_ar: 'صغير', sort_order: 20 },
      { value: 'M', label_en: 'Medium', label_ar: 'وسط', sort_order: 30 },
      { value: 'L', label_en: 'Large', label_ar: 'كبير', sort_order: 40 },
      { value: 'XL', label_en: 'Extra large', label_ar: 'كبير جدًا', sort_order: 50 },
      { value: 'XXL', label_en: '2XL', label_ar: '2XL', sort_order: 60 },
      { value: '3XL', label_en: '3XL', label_ar: '3XL', sort_order: 70 },
    ],
  },
  {
    code: 'belt_cm',
    name_en: 'Belt length (cm)', name_ar: 'طول الحزام (سم)',
    display_prefix: '', display_suffix: 'cm', is_numeric: true, is_system: false,
    values: [80, 85, 90, 95, 100, 105, 110, 115, 120]
      .map((n) => ({ value: String(n), sort_order: n * 10 })),
  },
];

// has_sizes = false always pairs with the one_size scale: every consumer then has one
// uniform code path ("resolve the scale, take its values") with no branching, and
// has_sizes is purely a hint to hide the size picker.
const CATEGORIES = [
  { code: 'shoes',       name_en: 'Shoes',       name_ar: 'أحذية',     scale: 'eu_shoe',   has_colors: true,  has_sizes: true },
  { code: 'slippers',    name_en: 'Slippers',    name_ar: 'شباشب',     scale: 'eu_shoe',   has_colors: true,  has_sizes: true },
  { code: 'sandals',     name_en: 'Sandals',     name_ar: 'صنادل',     scale: 'eu_shoe',   has_colors: true,  has_sizes: true },
  { code: 'socks',       name_en: 'Socks',       name_ar: 'جوارب',     scale: 'age_group', has_colors: true,  has_sizes: true },
  { code: 'bags',        name_en: 'Bags',        name_ar: 'حقائب',     scale: 'one_size',  has_colors: true,  has_sizes: false },
  { code: 'belts',       name_en: 'Belts',       name_ar: 'أحزمة',     scale: 'belt_cm',   has_colors: true,  has_sizes: true },
  { code: 'tools',       name_en: 'Tools',       name_ar: 'أدوات',     scale: 'one_size',  has_colors: false, has_sizes: false },
  { code: 'accessories', name_en: 'Accessories', name_ar: 'إكسسوارات', scale: 'one_size',  has_colors: true,  has_sizes: false },
];

const COLOR_PRESETS = [
  ['Black', 'أسود', '#000000'], ['White', 'أبيض', '#FFFFFF'],
  ['Grey', 'رمادي', '#808080'], ['Navy', 'كحلي', '#1F2A44'],
  ['Blue', 'أزرق', '#1E6FD9'], ['Light blue', 'أزرق فاتح', '#7FB3E8'],
  ['Red', 'أحمر', '#D22B2B'], ['Burgundy', 'نبيتي', '#7B1E3A'],
  ['Pink', 'وردي', '#E88AA8'], ['Green', 'أخضر', '#2E8B57'],
  ['Olive', 'زيتي', '#6B7A3A'], ['Yellow', 'أصفر', '#F2C230'],
  ['Orange', 'برتقالي', '#E8792B'], ['Brown', 'بني', '#6B4A2F'],
  ['Beige', 'بيج', '#D8C6A8'], ['Tan', 'جملي', '#B08050'],
  ['Gold', 'ذهبي', '#C9A227'], ['Silver', 'فضي', '#B8B8B8'],
];

exports.up = async function (knex) {
  // ---------------------------------------------------------------- size scales
  await knex.schema.createTable('size_scales', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('code', 50).notNullable().unique();
    t.string('name_en', 100).notNullable();
    t.string('name_ar', 100).notNullable();
    // Rendered around the value: 'EU' + '42' -> "EU 42"; '95' + 'cm' -> "95 cm".
    t.string('display_prefix', 10).notNullable().defaultTo('');
    t.string('display_suffix', 10).notNullable().defaultTo('');
    // Gates the numeric range filter and the US/UK/CM columns, which are meaningless
    // for an alpha scale.
    t.boolean('is_numeric').notNullable().defaultTo(false);
    t.boolean('is_system').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('size_scale_values', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scale_id').notNullable().references('id').inTable('size_scales').onDelete('CASCADE');
    // varchar(10) mirrors product_variants.size_eu exactly, so a value can always be
    // stored on a variant.
    t.string('value', 10).notNullable();
    t.string('label_en', 50);
    t.string('label_ar', 50);
    t.integer('sort_order').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.unique(['scale_id', 'value']);
    t.index(['scale_id', 'sort_order']);
  });

  // ---------------------------------------------------------------- categories
  await knex.schema.createTable('product_categories', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('code', 50).notNullable().unique();
    t.string('name_en', 100).notNullable();
    t.string('name_ar', 100).notNullable();
    t.boolean('has_colors').notNullable().defaultTo(true);
    t.boolean('has_sizes').notNullable().defaultTo(true);
    // NOT NULL for every category: "no sizes" means one_size, not an absent scale.
    t.uuid('size_scale_id').notNullable().references('id').inTable('size_scales').onDelete('RESTRICT');
    t.string('placeholder_color_name', 50).notNullable().defaultTo('Standard');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ---------------------------------------------------------------- colour presets
  await knex.schema.createTable('color_presets', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name_en', 50).notNullable().unique();
    t.string('name_ar', 50).notNullable();
    t.string('hex_code', 7);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ---------------------------------------------------------------- existing tables
  await knex.schema.alterTable('products', (t) => {
    // Nullable so this migration can run BEFORE the code that requires it — the deploy
    // order this project already relies on (see utils/schemaCapabilities.js). Joi makes
    // it required on create, the backfill below leaves none null, and every read path
    // uses leftJoin so a null can never drop a product from a list.
    t.uuid('category_id').references('id').inTable('product_categories').onDelete('RESTRICT');
    t.index('category_id', 'idx_products_category');
  });

  await knex.schema.alterTable('product_colors', (t) => {
    t.boolean('is_placeholder').notNullable().defaultTo(false);
  });
  // At most one placeholder per product; a second would mean two "colourless" identities.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_colors_one_placeholder
      ON product_colors (product_id) WHERE is_placeholder
  `);

  await knex.schema.alterTable('product_variants', (t) => {
    // Advisory only — see the header. SET NULL, never RESTRICT: losing the link costs
    // a re-derivable sort key, and must never block retiring a scale value.
    t.uuid('size_scale_value_id').references('id').inTable('size_scale_values').onDelete('SET NULL');
  });

  // ---------------------------------------------------------------- seed
  const scaleIds = {};
  for (const s of SCALES) {
    const [row] = await knex('size_scales')
      .insert({
        code: s.code, name_en: s.name_en, name_ar: s.name_ar,
        display_prefix: s.display_prefix, display_suffix: s.display_suffix,
        is_numeric: s.is_numeric, is_system: s.is_system,
      })
      .returning('id');
    scaleIds[s.code] = row.id || row;
    await knex('size_scale_values').insert(
      s.values.map((v) => ({
        scale_id: scaleIds[s.code],
        value: v.value,
        label_en: v.label_en || null,
        label_ar: v.label_ar || null,
        sort_order: v.sort_order,
      }))
    );
  }

  await knex('product_categories').insert(
    CATEGORIES.map((c, i) => ({
      code: c.code, name_en: c.name_en, name_ar: c.name_ar,
      has_colors: c.has_colors, has_sizes: c.has_sizes,
      size_scale_id: scaleIds[c.scale],
      sort_order: (i + 1) * 10,
    }))
  );

  await knex('color_presets').insert(
    COLOR_PRESETS.map(([en, ar, hex], i) => ({
      name_en: en, name_ar: ar, hex_code: hex, sort_order: (i + 1) * 10,
    }))
  );

  // ---------------------------------------------------------------- backfill
  // Everything in the catalogue today is a shoe.
  const shoes = await knex('product_categories').where('code', 'shoes').first('id');
  await knex('products').whereNull('category_id').update({ category_id: shoes.id });

  // Link existing variants to their EU scale value, which gives them a sort key derived
  // from the scale rather than from parsing the label.
  await knex.raw(
    `UPDATE product_variants v
        SET size_scale_value_id = sv.id,
            size_sort           = sv.sort_order
       FROM size_scale_values sv
       JOIN size_scales s ON s.id = sv.scale_id
      WHERE s.code = 'eu_shoe'
        AND sv.value = v.size_eu
        AND v.size_scale_value_id IS NULL`
  );
  // Anything off-scale keeps the digit-derived key, using the same expression the query
  // layer already used, so its ordering is identical to before this migration.
  await knex.raw(
    `UPDATE product_variants
        SET size_sort = ROUND(COALESCE(${SIZE_DIGITS}, 0) * 10)::int
      WHERE size_scale_value_id IS NULL`
  );

  // ---------------------------------------------------------------- permission
  // user_permissions.permission_code is an FK to permissions.code, so a code that does
  // not exist here cannot be granted at all.
  const existing = await knex('permissions').where('code', 'product_categories').first();
  if (!existing) {
    await knex('permissions').insert([{
      code: 'product_categories',
      description: 'Manage product categories, size scales and colour presets',
      category: 'catalog',
    }]);
  }
  // Reads are gated on the existing products:read, so nobody loses access to the
  // category list. Only editing needs this code — grant it to admins so the new screen
  // is reachable without a manual grant.
  const admins = await knex('users').where('role_id', 1).select('id');
  for (const u of admins) {
    const has = await knex('user_permissions')
      .where({ user_id: u.id, permission_code: 'product_categories' })
      .first();
    if (!has) {
      await knex('user_permissions').insert({
        user_id: u.id, permission_code: 'product_categories', access_level: 'write',
      });
    }
  }
};

exports.down = async function (knex) {
  await knex('user_permissions').where('permission_code', 'product_categories').del();
  await knex('permissions').where('code', 'product_categories').del();

  await knex.raw('DROP INDEX IF EXISTS uq_product_colors_one_placeholder');
  await knex.schema.alterTable('product_variants', (t) => t.dropColumn('size_scale_value_id'));
  await knex.schema.alterTable('product_colors', (t) => t.dropColumn('is_placeholder'));
  await knex.schema.alterTable('products', (t) => {
    t.dropIndex('category_id', 'idx_products_category');
    t.dropColumn('category_id');
  });

  await knex.schema.dropTableIfExists('color_presets');
  await knex.schema.dropTableIfExists('product_categories');
  await knex.schema.dropTableIfExists('size_scale_values');
  await knex.schema.dropTableIfExists('size_scales');
};
