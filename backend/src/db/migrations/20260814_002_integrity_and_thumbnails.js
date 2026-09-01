/**
 * MIGRATION: Data-integrity constraint, missing permission rows, thumbnail columns.
 *
 * 1. UNIQUE on customer_return_items.sale_item_id — a database-level backstop for the
 *    double-refund bug. The service and the Joi schema both reject duplicates now, but
 *    a physical shoe can only be returned once, so the database should enforce it too.
 *
 * 2. The 'dashboard' and 'dashboard_admin' permission codes. 'dashboard_admin' exists
 *    only in the seed, so any database created by migrations never had it, and
 *    'dashboard' was referenced by a route but never defined anywhere. Because
 *    user_permissions.permission_code is a FK to permissions.code, an admin could not
 *    even grant them by hand.
 *
 * 3. thumb_url columns, so the small WebP derivative generated at upload time can be
 *    served to list views instead of the full-size original.
 */
exports.up = async function (knex) {
  // --- 1. Prevent the same sale item being returned twice ---
  // Clear any pre-existing duplicates first, keeping the earliest row, or the
  // constraint cannot be created. Reports already treat "returned" as a boolean
  // (they only test for the presence of a row), so dropping the extras does not
  // change any figure the system displays.
  const duplicates = await knex.raw(`
    SELECT sale_item_id, COUNT(*) as count
    FROM customer_return_items
    GROUP BY sale_item_id
    HAVING COUNT(*) > 1
  `);

  if (duplicates.rows.length > 0) {
    console.log(
      `[migration] found ${duplicates.rows.length} sale item(s) with duplicate return rows; keeping the earliest of each`
    );
    await knex.raw(`
      DELETE FROM customer_return_items
      WHERE id NOT IN (
        SELECT MIN(id) FROM customer_return_items GROUP BY sale_item_id
      )
    `);
  }

  await knex.schema.alterTable('customer_return_items', (t) => {
    t.unique(['sale_item_id'], { indexName: 'uq_customer_return_items_sale_item' });
  });

  // --- 2. Missing permission code ---
  // Only dashboard_admin: it is referenced by a live route but exists solely in the
  // seed, so any database built from migrations never had it. The 'dashboard' code the
  // route used to require is deliberately NOT created — that route is now gated on
  // 'reports', which every reporting user already holds, so inventing a second code
  // nothing reads would just be dead schema.
  await knex('permissions')
    .insert([
      { code: 'dashboard_admin', description: 'Dashboard pending tasks, recent sales & activity', category: 'administration' },
    ])
    .onConflict('code')
    .ignore();

  // Grant both to existing admin-role users so nothing regresses for them.
  const adminUsers = await knex('users')
    .join('roles', 'users.role_id', 'roles.id')
    .where('roles.name', 'admin')
    .select('users.id');

  if (adminUsers.length > 0) {
    const rows = adminUsers.map((u) => (
      { user_id: u.id, permission_code: 'dashboard_admin', access_level: 'read' }
    ));
    await knex('user_permissions')
      .insert(rows)
      .onConflict(['user_id', 'permission_code'])
      .ignore();
  }

  // --- 3. Thumbnail columns ---
  await knex.schema.alterTable('product_color_images', (t) => {
    t.text('thumb_url');
  });
  await knex.schema.alterTable('attached_images', (t) => {
    t.text('thumb_url');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('attached_images', (t) => {
    t.dropColumn('thumb_url');
  });
  await knex.schema.alterTable('product_color_images', (t) => {
    t.dropColumn('thumb_url');
  });

  await knex('user_permissions').where('permission_code', 'dashboard_admin').del();
  await knex('permissions').where('code', 'dashboard_admin').del();

  await knex.schema.alterTable('customer_return_items', (t) => {
    t.dropUnique(['sale_item_id'], 'uq_customer_return_items_sale_item');
  });
};
