/**
 * THE PRINT QUEUE — 2026-09-24
 *
 * WHY
 *
 * Labels are printed at a printer, and stock is received at a desk. Until now the only
 * way to print was to be standing in front of the document that created the stock —
 * open the purchase box, press Print labels, and do it there and then. So a morning
 * spent receiving four invoices meant either four trips to the printer, or going back
 * afterwards and reconstructing from memory which boxes still needed labels.
 *
 * A queue is that memory, kept by the system instead of by the person. Receiving stock
 * offers to put the labels on it; the queue accumulates; one print run clears it.
 *
 * WHAT A ROW IS
 *
 * One row is "N labels of this variant, for this branch, because of this document".
 * Not one row per label — a 60-pair box would be 60 rows — and not one row per variant
 * either, because WHERE the request came from is the thing that makes the queue
 * readable a day later ("these 40 are from invoice PI-2026-0011").
 *
 * The branch is on the row and is NOT NULL, for two reasons that both change what gets
 * printed: a branch can carry its own selling price (store_product_prices), which the
 * label prints as a code, and the queue must be scopeable to the branches a person is
 * assigned to, like every other stock document in this system.
 *
 * ADDING THE SAME STOCK TWICE MUST NOT DOUBLE THE LABELS
 *
 * The prompt after receiving stock can be answered twice — the page can be reloaded,
 * the box re-opened, two people can both press it. So a pending row is unique per
 * (branch, variant, source document), and re-adding the same document REPLACES its
 * pending rows rather than adding to them. Two different documents for the same variant
 * are two rows and do sum, which is correct: two boxes arrived.
 *
 * Two partial unique indexes rather than one over a COALESCE: a manual add has no
 * source document, and Postgres treats NULLs in a unique index as distinct, so the
 * manual case needs its own index or it would never merge at all. Manual adds SUM into
 * their row — pressing "add to queue" twice by hand is a person asking for more labels,
 * which is the opposite of the document case.
 *
 * `printed_qty` rather than a boolean: a roll of labels runs out halfway through a run,
 * and the remainder has to stay in the queue. status flips to `done` only when every
 * label asked for has been printed.
 *
 * PERMISSION
 *
 * `print_queue` is its own code, not a corner of `barcodes`. Printing labels for a
 * product you are looking at and holding a standing list of everything the shop owes
 * labels for are different jobs: the first belongs to whoever is at the product screen,
 * the second is usually one person with the printer. user_permissions.permission_code
 * is an FK to permissions.code, so without this row the ability could never be granted
 * to anybody — the mistake that once left `dashboard` ungrantable.
 *
 * down() drops the queue. Nothing else references it: a queue row is a note about work
 * to do, never a record of stock, so losing it loses no history.
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('print_queue_items');
  if (!exists) {
    await knex.schema.createTable('print_queue_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());

      // RESTRICT, like every other stock document: a branch holding queued work is a
      // branch somebody still has something to do at.
      t.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('RESTRICT');
      // CASCADE: a variant that no longer exists cannot be labelled, and the queue row
      // is only a note. Nothing is lost by it going with it.
      t.uuid('variant_id').notNullable().references('id').inTable('product_variants').onDelete('CASCADE');

      t.integer('quantity').notNullable();
      t.integer('printed_qty').notNullable().defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('pending');   // pending | done | cancelled

      // Polymorphic and deliberately without a foreign key, the same shape as
      // attached_images: a queue row must survive the document that suggested it being
      // edited or deleted, because the labels are still owed either way.
      t.string('source_type', 20).notNullable().defaultTo('manual'); // purchase_box | stock_intake | manual
      t.uuid('source_id');
      // The document's own number, kept as text so the queue still says where a row
      // came from after that document is gone.
      t.string('source_ref', 60);

      t.text('note');
      t.uuid('added_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('last_printed_at');
      t.timestamp('completed_at');
      t.uuid('completed_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      // The page's own query: one branch, one status, newest first.
      t.index(['store_id', 'status']);
      t.index(['variant_id']);
      t.index(['source_type', 'source_id']);
    });

    // Re-adding a document replaces its pending rows. The index is the backstop for two
    // requests arriving together; the service also takes an advisory lock per branch, so
    // in normal operation this never fires.
    await knex.raw(`
      CREATE UNIQUE INDEX uq_print_queue_pending_source
        ON print_queue_items (store_id, variant_id, source_type, source_id)
        WHERE status = 'pending' AND source_id IS NOT NULL
    `);

    // A manual add has no document, and NULLs are distinct to a unique index, so the
    // manual case needs its own or every press would make a new row.
    await knex.raw(`
      CREATE UNIQUE INDEX uq_print_queue_pending_manual
        ON print_queue_items (store_id, variant_id)
        WHERE status = 'pending' AND source_id IS NULL
    `);
  }

  const perm = await knex('permissions').where('code', 'print_queue').first();
  if (!perm) {
    await knex('permissions').insert({
      code: 'print_queue',
      description: 'The label print queue — hold labels to print and clear them in one run',
      category: 'inventory',
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_print_queue_pending_manual');
  await knex.raw('DROP INDEX IF EXISTS uq_print_queue_pending_source');
  await knex.schema.dropTableIfExists('print_queue_items');

  await knex('user_permissions').where('permission_code', 'print_queue').del().catch(() => {});
  await knex('permissions').where('code', 'print_queue').del();
};
