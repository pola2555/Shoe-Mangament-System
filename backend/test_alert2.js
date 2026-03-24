require('dotenv').config();
const db = require('./src/config/database');
const purchasesService = require('./src/modules/purchases/purchases.service');

async function run() {
  try {
    console.log('Seeding baseline data for alert test...');
    const [category] = await db('categories').insert({ id: db.fn.uuid(), name: 'Test Category' }).returning('*');
    const [product] = await db('products').insert({
      id: db.fn.uuid(),
      category_id: category.id,
      model_name: 'Alert Shoe',
      product_code: 'AL-100',
      net_price: 100,
      min_selling_price: 150,
      default_selling_price: 200,
      season: 'Summer',
      gender: 'Unisex',
    }).returning('*');
    
    const [color] = await db('product_colors').insert({ id: db.fn.uuid(), color_name: 'Red', hex_code: '#FF0000' }).returning('*');
    const [supplier] = await db('suppliers').insert({
      id: db.fn.uuid(),
      company_name: 'Test Supplier',
      contact_person: 'Bob'
    }).returning('*');

    const [store] = await db('stores').where({ store_name: 'Main Store' }).returning('*');
    // or just fetch the first store
    const existingStore = await db('stores').first();

    console.log('Creating Purchase Invoice...');
    const invoice = await purchasesService.createInvoice({
      supplier_id: supplier.id,
      invoice_ref_number: 'INV-TEST-02',
      invoice_date: new Date(),
      total_amount: 1500,
      discount_amount: 0
    }, null);

    console.log('Adding Box (cost 150 EGP instead of 100)...');
    const box = await purchasesService.addBox(invoice.id, {
      product_id: product.id,
      destination_store_id: existingStore.id,
      total_items: 10,
      cost_per_item: 150,
      box_template_id: null
    });

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
