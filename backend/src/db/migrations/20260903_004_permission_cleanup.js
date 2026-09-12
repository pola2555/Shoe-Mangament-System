/**
 * PERMISSION CLEANUP — 2026-09-03
 *
 * A full audit of all 231 mounted routes against all 46 permission rows
 * (`node scripts/audit-permissions.js`) turned up two codes that gate nothing at all,
 * and a set of descriptions that no screen had ever shown because the permissions
 * dialog rendered a hand-kept list instead of this table.
 *
 * REMOVED
 *
 *   pos_store_access — created by 20260323_001 and granted to users by that same
 *     migration's backfill. Nothing has EVER checked it: not a route, not a service,
 *     not the frontend. Where a person may sell is already decided by `user_stores`
 *     through userHasStoreAccess(), and whether they may sell at all by `pos`. It was
 *     harmless while invisible; now that the dialog lists every real permission it
 *     would read as a meaningful switch that does nothing.
 *
 *   notifications — the notifications routes are deliberately ungated because every
 *     one of them is scoped to `req.user.id`. Gating a person's own notifications
 *     would be wrong, so this code can never be used for anything.
 *
 * Both are dropped from `user_permissions` first: permission_code is an FK to
 * permissions.code, so the grants have to go before the row can.
 *
 * DESCRIPTIONS
 *
 * Rewritten in shop language and, where a permission has a limit that is not obvious
 * from its name, saying so — `user_permissions` in particular, where the write half is
 * admin-only no matter who holds the code.
 *
 * down() restores both rows and the old descriptions. It cannot restore the individual
 * grants, and says so rather than pretending: they authorised nothing, so nothing is
 * lost by their absence.
 */

const REMOVED = ['pos_store_access', 'notifications'];

const DESCRIPTIONS = {
  // administration
  users: 'Add staff, edit their details, deactivate them',
  user_permissions: 'See what a person is allowed to do. Only an admin can CHANGE permissions, whatever this is set to',
  user_password_reset: "Set another person's password",
  stores: 'Rename a branch, open or close one',
  all_stores: 'See every branch, not only the ones assigned',
  dashboard_admin: "The owner's dashboard — company-wide totals",
  seller_codes: 'Manage the short codes staff type at checkout to claim a sale',
  audit_log: 'Read the activity log. Only an admin can clear it',
  // catalog
  products: 'The product catalogue',
  product_variants: 'Colour and size combinations of a product',
  product_images: 'Product photographs',
  product_prices: 'Selling prices, including a branch\'s own price for a product',
  product_categories: 'Categories, size lists and the colour palette',
  box_templates: 'Saved box layouts for receiving stock',
  barcodes: 'Generate barcodes and print labels',
  // operations
  inventory: 'Stock on hand',
  transfers: 'Create a transfer between branches',
  transfer_actions: 'Send, receive or cancel a transfer',
  stock_count: 'Count stock and post what is missing or found',
  stock_intake: 'Enter stock without a purchase invoice (opening stock)',
  // procurement
  purchases: 'Purchase invoices from suppliers',
  purchase_boxes: 'The boxes on a purchase invoice',
  purchase_images: 'Photographs of a purchase invoice',
  suppliers: 'Supplier records',
  supplier_payments: 'Pay a supplier, record a withdrawal',
  // sales
  pos: 'Use the till and ring up sales',
  sales: 'Sales history',
  sale_payments: 'Take a further payment against a sale',
  sale_void: 'Void a sale and put the stock back',
  price_override: 'Sell at a price other than the marked one, within the branch band',
  discount_approval: 'Approve or reject a discount request',
  shifts: 'Open and close the till, count the drawer',
  customers: 'Customer records and their balances',
  // returns
  customer_returns: 'Take goods back from a customer',
  supplier_returns: 'Send goods back to a supplier',
  exchanges: 'Swap a sold item for another. Includes taking the old one back and ringing the new one',
  // finance
  expenses: 'Record and view spending',
  expense_categories: 'Manage expense categories, recurring bills and budgets',
  cash_drawer: 'Take money out of the till and record it',
  loans: 'Money lent out and repayments',
  reports: 'Reports and branch figures',
  // wholesale
  dealers: 'Dealer records',
  dealer_invoices: 'Dealer invoices',
  dealer_payments: 'Dealer payments',
};

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    await trx('user_permissions').whereIn('permission_code', REMOVED).del();
    await trx('permissions').whereIn('code', REMOVED).del();

    for (const [code, description] of Object.entries(DESCRIPTIONS)) {
      await trx('permissions').where('code', code).update({ description });
    }
  });
};

exports.down = async function down(knex) {
  // Restored exactly as 20260323_001 created them. The individual grants are NOT
  // restored: they authorised nothing while they existed.
  const rows = [
    { code: 'pos_store_access', description: 'Sell in assigned stores', category: 'sales' },
    { code: 'notifications', description: 'View notifications', category: 'notifications' },
  ];
  for (const r of rows) {
    const exists = await knex('permissions').where('code', r.code).first();
    if (!exists) await knex('permissions').insert(r);
  }
};
