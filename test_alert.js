require('dotenv').config({ path: './backend/.env' });
const db = require('./backend/src/config/database');
const purchasesService = require('./backend/src/modules/purchases/purchases.service');

async function run() {
  try {
    console.log('Seeding baseline data...');
    // Create a category
    const [category] = await db('categories').insert({ id: db.fn.uuid(), name: 'Test Category' }).returning('*');
    // Create a product
    const [product] = await db('products').insert({
      id: db.fn.uuid(),
      category_id: category.id,
      model_name: 'Alert Shoe',
      product_code: 'AL-100',
      net_price: 100, // Original price
      min_selling_price: 150,
      default_selling_price: 200,
      season: 'Summer 2026',
      gender: 'Unisex',
    }).returning('*');
    
    // Create a color
    const [color] = await db('product_colors').insert({ id: db.fn.uuid(), color_name: 'Red', hex_code: '#FF0000' }).returning('*');

    // Create a supplier
    const [supplier] = await db('suppliers').insert({
      id: db.fn.uuid(),
      company_name: 'Test Supplier',
      contact_person: 'Bob'
    }).returning('*');

    // Create a store
    const [store] = await db('stores').insert({
      id: db.fn.uuid(),
      store_name: 'Test Store',
      location: 'Test Location',
      is_active: true
    }).returning('*');

    console.log('Creating Purchase Invoice...');
    // Add invoice
    const invoice = await purchasesService.createInvoice({
      supplier_id: supplier.id,
      invoice_ref_number: 'INV-TEST-01',
      invoice_date: new Date(),
      total_amount: 1500,
    }, null); // system user

    console.log('Adding Box (cost 150 EGP instead of 100)...');
    // Add box to invoice
    const box = await purchasesService.addBox(invoice.id, {
      product_id: product.id,
      destination_store_id: store.id,
      total_items: 10,
      cost_per_item: 150, // Changed from 100
      box_template_id: null
    });

    // Add items inside box
    await db('box_items').insert({
      id: db.fn.uuid(),
      invoice_box_id: box.id,
      product_color_id: color.id,
      size_eu: 40,
      quantity: 10
    });

    console.log('Completing Box to trigger inventory & alerts...');
    await purchasesService.completeBox(box.id);

    console.log('Validating Results...');
    const updatedProduct = await db('products').where('id', product.id).first();
    console.log(`Product New Net Price: ${updatedProduct.net_price} (Expected 150)`);

    const notifications = await db('notifications').select('*');
    console.log(`Notifications Generated: ${notifications.length}`);
    if (notifications.length > 0) {
      console.log('Notification Title:', notifications[0].title);
      console.log('Notification Message:', notifications[0].message);
    }
    
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
}

run();
