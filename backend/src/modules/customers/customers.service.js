const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID } = require('../../utils/generateCodes');

class CustomersService {
  async list({ search } = {}) {
    let query = db('customers').orderBy('name', 'asc');
    if (search) {
      const safeSearch = search.replace(/[%_\\]/g, '\\$&');
      query = query.where(function () {
        this.where('phone', 'ilike', `%${safeSearch}%`)
          .orWhere('name', 'ilike', `%${safeSearch}%`);
      });
    }
    return query.limit(500);
  }

  async getById(id) {
    const customer = await db('customers').where('id', id).first();
    if (!customer) throw new AppError('Customer not found', 404);

    // Fetch purchase history
    customer.sales = await db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .where('customer_id', id)
      .select('sales.*', 'stores.name as store_name')
      .orderBy('sales.created_at', 'desc');

    // Fetch items for each sale with product, color, size, and color image
    if (customer.sales.length > 0) {
      const saleIds = customer.sales.map(s => s.id);
      const items = await db('sale_items')
        .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
        .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
        .join('products', 'product_variants.product_id', 'products.id')
        .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
        .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
        .whereIn('sale_items.sale_id', saleIds)
        .select(
          'sale_items.id',
          'sale_items.sale_id',
          'sale_items.sale_price',
          'product_variants.size_eu',
          'products.product_code',
          'products.model_name as product_name',
          'products.brand',
          'product_colors.color_name',
          'product_colors.hex_code',
          'product_colors.id as product_color_id',
          db.raw('CASE WHEN customer_return_items.id IS NOT NULL THEN true ELSE false END as is_returned'),
          db.raw(`(SELECT pci.image_url FROM product_color_images pci WHERE pci.product_color_id = product_colors.id ORDER BY pci.is_primary DESC, pci.created_at ASC LIMIT 1) as color_image_url`)
        );

      // Group items by sale_id
      const itemsBySale = {};
      for (const item of items) {
        if (!itemsBySale[item.sale_id]) itemsBySale[item.sale_id] = [];
        itemsBySale[item.sale_id].push(item);
      }
      for (const sale of customer.sales) {
        sale.items = itemsBySale[sale.id] || [];
      }
    }

    return customer;
  }

  async searchByPhone(phone) {
    const safePhone = phone.replace(/[%_\\]/g, '\\$&');
    return db('customers').where('phone', 'ilike', `%${safePhone}%`).limit(10);
  }

  async create(data) {
    const existing = await db('customers').where('phone', data.phone).first();
    if (existing) throw new AppError('Customer with this phone already exists', 409);

    const safeData = { id: generateUUID() };
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.name !== undefined) safeData.name = data.name;
    if (data.notes !== undefined) safeData.notes = data.notes;

    const [customer] = await db('customers')
      .insert(safeData)
      .returning('*');
    return customer;
  }

  async update(id, data) {
    const safeData = { updated_at: new Date() };
    if (data.phone !== undefined) safeData.phone = data.phone;
    if (data.name !== undefined) safeData.name = data.name;
    if (data.notes !== undefined) safeData.notes = data.notes;

    const [customer] = await db('customers')
      .where('id', id).update(safeData).returning('*');
    if (!customer) throw new AppError('Customer not found', 404);
    return customer;
  }

  async delete(id) {
    const salesCount = await db('sales').where('customer_id', id).count('id as count').first();
    if (parseInt(salesCount.count) > 0) {
      throw new AppError('Cannot delete customer with existing sales. Edit their info instead.', 400);
    }
    const count = await db('customers').where('id', id).del();
    if (!count) throw new AppError('Customer not found', 404);
  }
}

module.exports = new CustomersService();
