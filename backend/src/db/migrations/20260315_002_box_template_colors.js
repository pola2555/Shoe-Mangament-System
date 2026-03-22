/**
 * MIGRATION: Add color_label to box_template_items.
 * 
 * This allows templates to define color-grouped size distributions
 * (e.g. "Black: 40×2, 41×3" and "White: 40×1, 42×2").
 * The label is a plain string, not a FK, so templates remain reusable
 * across products — the UI auto-maps labels to actual product_color_ids.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('box_template_items', (t) => {
    t.string('color_label', 50).nullable().defaultTo(null);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('box_template_items', (t) => {
    t.dropColumn('color_label');
  });
};
