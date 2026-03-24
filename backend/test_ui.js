require('dotenv').config();
const db = require('./src/config/database');

async function run() {
  try {
    await db('notifications').insert({
      id: db.fn.uuid(),
      type: 'price_update',
      title: 'Cost Price Changed: ADI-100',
      message: 'The net purchase cost for ADI-100 was officially updated from 1500 EGP to 1600 EGP due to a new invoice. Please review its selling bounded margins.',
      reference_id: null,
      created_at: new Date()
    });
    console.log('Dummy alert inserted.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
