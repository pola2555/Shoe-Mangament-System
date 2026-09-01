const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

/**
 * Box Templates service.
 * 
 * Templates define the standard size distribution for boxes of shoes.
 * E.g., "Standard Nike Box": size 40 x1, size 41 x1, size 42 x2, etc.
 * 
 * When creating a purchase invoice, the user selects a template
 * and the sizes/quantities are pre-filled — saving time on repetitive data entry.
 */
class BoxTemplatesService {
  async list({ product_id } = {}) {
    let query = db('box_templates')
      .leftJoin('products', 'box_templates.product_id', 'products.id')
      .select(
        'box_templates.*',
        'products.product_code',
        'products.model_name as product_name'
      )
      .orderBy('box_templates.name', 'asc');

    if (product_id) query = query.where('box_templates.product_id', product_id);

    const templates = await query.limit(500);
    if (templates.length === 0) return templates;

    // All items in one query rather than one per template.
    const allItems = await db('box_template_items')
      .whereIn('template_id', templates.map((t) => t.id))
      .orderBy('color_label', 'asc')
      .orderBy('size', 'asc');

    const itemsByTemplate = new Map();
    for (const item of allItems) {
      if (!itemsByTemplate.has(item.template_id)) itemsByTemplate.set(item.template_id, []);
      itemsByTemplate.get(item.template_id).push(item);
    }
    for (const tmpl of templates) {
      tmpl.items = itemsByTemplate.get(tmpl.id) || [];
    }

    return templates;
  }

  async getById(id) {
    const template = await db('box_templates')
      .leftJoin('products', 'box_templates.product_id', 'products.id')
      .where('box_templates.id', id)
      .select(
        'box_templates.*',
        'products.product_code',
        'products.model_name as product_name'
      )
      .first();

    if (!template) throw new AppError('Box template not found', 404);

    template.items = await db('box_template_items')
      .where('template_id', id)
      .orderBy('color_label', 'asc')
      .orderBy('size', 'asc');

    return template;
  }

  async create(data) {
    const { items, ...rest } = data;
    // Whitelist allowed fields
    const templateData = {
      name: rest.name,
      product_id: rest.product_id || null,
      notes: rest.notes || null,
    };
    const id = generateUUID();

    await db.transaction(async (trx) => {
      await trx('box_templates').insert({ id, ...templateData });

      if (items && items.length > 0) {
        const itemRows = items.map((item) => ({
          template_id: id,
          size: item.size,
          quantity: item.quantity,
          color_label: item.color_label || null,
        }));
        await trx('box_template_items').insert(itemRows);
      }
    });

    return this.getById(id);
  }

  async update(id, data) {
    const existing = await db('box_templates').where('id', id).first();
    if (!existing) throw new AppError('Box template not found', 404);

    const { items, ...rest } = data;
    // Whitelist allowed fields
    const templateData = {};
    if (rest.name !== undefined) templateData.name = rest.name;
    if (rest.product_id !== undefined) templateData.product_id = rest.product_id;
    if (rest.notes !== undefined) templateData.notes = rest.notes;

    await db.transaction(async (trx) => {
      if (Object.keys(templateData).length > 0) {
        templateData.updated_at = new Date();
        await trx('box_templates').where('id', id).update(templateData);
      }

      // If items provided, replace all items
      if (items) {
        await trx('box_template_items').where('template_id', id).del();
        if (items.length > 0) {
          const itemRows = items.map((item) => ({
            template_id: id,
            size: item.size,
            quantity: item.quantity,
            color_label: item.color_label || null,
          }));
          await trx('box_template_items').insert(itemRows);
        }
      }
    });

    return this.getById(id);
  }

  async delete(id) {
    const deleted = await db('box_templates').where('id', id).del();
    if (!deleted) throw new AppError('Box template not found', 404);
  }
}

module.exports = new BoxTemplatesService();
