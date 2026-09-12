const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const { paginate, wantsPage } = require('../../utils/paginate');
const { capabilities } = require('../../utils/schemaCapabilities');
const { colorImageLateral } = require('../inventory/inventory.service');
const { formatSize, formatColor } = require('../../utils/variantDisplay');
const { applyDateRange } = require('../../utils/dateRange');
const { userHasStoreAccess } = require('../../middleware/auth');
const bcrypt = require('bcryptjs');
const shiftsService = require('../shifts/shifts.service');

/**
 * PLAN 3 — who may set a price, who may discount, and whose name goes on the sale.
 *
 * All three are enforced here rather than in the POS, because the POS is one client of
 * an open API. A hidden input stops nobody.
 */

/** Admins always may; everyone else needs the permission granted explicitly. */
function canOverridePrice(user) {
  if (!user) return false;
  if (user.role_name === 'admin') return true;
  return Boolean(user.permissions?.price_override);
}

function canApproveDiscount(user) {
  if (!user) return false;
  if (user.role_name === 'admin') return true;
  return Boolean(user.permissions?.discount_approval);
}

/**
 * A discount is legitimate only if this person could grant it, or somebody who could
 * already did.
 *
 * The approved request is consumed here, inside the sale's own transaction, so the same
 * approval cannot be spent twice by two simultaneous checkouts: the row is locked, its
 * status is re-checked under that lock, and it is marked used before the sale commits.
 */
async function assertDiscountAllowed(trx, { user, storeId, amount, requestId }) {
  if (canApproveDiscount(user)) return null;

  if (!requestId) {
    throw new AppError(
      'You need a manager to approve this discount. Send a discount request from the till.',
      403
    );
  }

  const request = await trx('discount_requests').where('id', requestId).forUpdate().first();
  if (!request) throw new AppError('That discount approval was not found', 404);
  if (request.store_id !== storeId) throw new AppError('That approval belongs to another branch', 400);
  if (request.status === 'used') throw new AppError('That approval has already been used', 409);
  if (request.status !== 'approved') {
    throw new AppError(`That discount request is ${request.status}, not approved`, 400);
  }
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    throw new AppError('That approval has expired. Ask again.', 400);
  }
  const approved = Math.round(parseFloat(request.approved_discount) * 100) / 100;
  if (amount > approved + 0.01) {
    throw new AppError(`Only ${approved} EGP was approved, not ${amount}`, 400);
  }

  await trx('discount_requests').where('id', requestId).update({
    status: 'used', updated_at: new Date(),
  });
  return request;
}

/** May this person let a customer walk out owing money, without asking? */
function canApproveCredit(user) {
  return user?.role_name === 'admin' || user?.permissions?.credit_approval === 'write';
}

/**
 * Letting a registered customer pay later now needs the same kind of approval a
 * discount does.
 *
 * WHY THIS IS NOT JUST A WARNING
 *
 * Unpaid balance is stock that has left the building against a promise. Before this, a
 * cashier could hand over any amount of goods on account with nothing but the customer
 * existing in the system, and the first anyone knew was the customer's balance climbing
 * in a report nobody reads daily.
 *
 * Consumed inside the sale's transaction and locked, exactly like the discount
 * approval, so one approval cannot fund two checkouts running at once.
 */
async function assertCreditAllowed(trx, { user, storeId, amount, requestId, customerId }) {
  if (!customerId) {
    throw new AppError(
      'A walk-in customer must pay in full. Add the customer to the system to sell on account.',
      400
    );
  }
  if (canApproveCredit(user)) return null;

  if (!requestId) {
    throw new AppError(
      'You need a manager to approve letting this customer pay later. '
      + 'Send a pay-later request from the till.',
      403
    );
  }

  const request = await trx('discount_requests').where('id', requestId).forUpdate().first();
  if (!request) throw new AppError('That approval was not found', 404);
  if (request.kind !== 'credit') {
    throw new AppError('That approval was for a discount, not for paying later', 400);
  }
  if (request.store_id !== storeId) throw new AppError('That approval belongs to another branch', 400);
  if (request.status === 'used') throw new AppError('That approval has already been used', 409);
  if (request.status !== 'approved') {
    throw new AppError(`That pay-later request is ${request.status}, not approved`, 400);
  }
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    throw new AppError('That approval has expired. Ask again.', 400);
  }
  if (request.customer_id && customerId && request.customer_id !== customerId) {
    // An approval to let ONE customer owe money is not an approval for any customer.
    throw new AppError('That approval was for a different customer', 400);
  }
  const approved = Math.round(parseFloat(request.approved_credit) * 100) / 100;
  if (amount > approved + 0.01) {
    throw new AppError(`Only ${approved} EGP was approved on account, not ${amount}`, 400);
  }

  await trx('discount_requests').where('id', requestId).update({
    status: 'used', updated_at: new Date(),
  });
  return request;
}

/**
 * Whose sale this is.
 *
 * A branch can require a short code at checkout. It exists because several staff share
 * one till and one login, which made every sale look like it belonged to whoever signed
 * in that morning — so per-person figures were not merely inaccurate, they were
 * unrecoverable.
 *
 * The code is bcrypt-hashed and compared against every staff member assigned to that
 * branch, which is why codes must be unique within a branch: a code that matched two
 * people would credit the money to whichever row came back first.
 */
async function resolveSeller(user, data) {
  const store = await db('stores').where('id', data.store_id).first('require_seller_passcode');
  if (!store?.require_seller_passcode) {
    // Not required here: an explicitly named seller is still honoured, so a shop can
    // start attributing sales before it starts enforcing codes.
    return data.sold_by || null;
  }

  const code = String(data.seller_code || '').trim();
  if (!code) {
    throw new AppError('Enter your selling code to complete this sale', 400);
  }

  const staff = await db('users as u')
    .leftJoin('user_stores as us', 'us.user_id', 'u.id')
    .where('u.is_active', true)
    .whereNotNull('u.seller_code_hash')
    .where((b) => b.where('us.store_id', data.store_id).orWhere('u.store_id', data.store_id))
    .distinct('u.id', 'u.full_name', 'u.seller_code_hash');

  for (const person of staff) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(code, person.seller_code_hash)) return person.id;
  }
  throw new AppError('That selling code was not recognised at this branch', 403);
}

/**
 * Finding a sale by anything a person at the counter can actually say.
 *
 * The receipt number and the customer were the only ways in. Nobody keeps a receipt,
 * and a customer coming back to exchange arrives holding the shoe — so the thing they
 * CAN tell you is the product, or the label still stuck to it. Both screens that look a
 * sale up now search what was sold as well.
 *
 * EXISTS, not a join: a sale holding three pairs of one product is still ONE sale, and
 * joining would list it three times. It also keeps the item tables out of the row shape,
 * so the columns the list returns do not change.
 *
 * Shared by `list` and `exportExcel` so the spreadsheet contains what the screen shows.
 * A second copy of this predicate is how the two would quietly drift apart.
 */
function applySaleSearch(query, search) {
  if (!search) return query;
  // % and _ are LIKE wildcards: unescaped, a bare "%" returns the whole history and
  // reads as a search that ignored what was typed.
  const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;

  return query.where(function () {
    this.where('sales.sale_number', 'ilike', like)
      .orWhere('customers.phone', 'ilike', like)
      .orWhere('customers.name', 'ilike', like)
      .orWhereExists(function () {
        this.select(db.raw('1'))
          .from('sale_items')
          .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
          .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
          .join('products', 'product_variants.product_id', 'products.id')
          .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
          .whereRaw('sale_items.sale_id = sales.id')
          .where(function () {
            this.where('products.model_name', 'ilike', like)
              .orWhere('products.product_code', 'ilike', like)
              .orWhere('products.brand', 'ilike', like)
              .orWhere('product_variants.sku', 'ilike', like)
              // The barcode is what a scan sends. This is what makes finding a sale
              // from the label on the shoe work at all — before it, the exchange and
              // returns screens sent a scanned code into a search that could never
              // match one, and always answered "no sale found".
              .orWhere('product_variants.barcode', 'ilike', like)
              .orWhere(function () {
                // Colour — but never the stand-in colour a colourless category
                // carries, or one word would return every knife in the shop.
                this.where('product_colors.color_name', 'ilike', like)
                  .andWhere('product_colors.is_placeholder', false);
              });
          });
      });
  });
}

/**
 * Sales service — POS checkout.
 * 
 * Flow: employee scans/selects items → creates a sale → items marked 'sold'
 * Sale prices come from store-specific or default product prices.
 */
class SalesService {
  async list({ store_id, store_ids, customer_id, search, days, startDate, endDate, include_voided, limit, page, paginate: wantPage } = {}) {
    let query = db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .leftJoin('users', 'sales.created_by', 'users.id')
      .leftJoin('users as voider', 'sales.voided_by', 'voider.id')
      .select(
        'sales.*',
        'stores.name as store_name',
        'customers.name as customer_name',
        'customers.phone as customer_phone',
        'users.full_name as created_by_name',
        'voider.full_name as voided_by_name'
      )
      .orderBy('sales.created_at', 'desc');

    applyStoreScope(query, 'sales.store_id', { store_id, store_ids });
    if (customer_id) query = query.where('sales.customer_id', customer_id);
    // Voided sales are hidden by default: they did not happen. The history screen asks
    // for them explicitly so the record is still reachable, greyed and labelled.
    if (!include_voided) query = query.whereNull('sales.voided_at');
    
    if (days) {
      const parsedDays = parseInt(days, 10);
      if (!isNaN(parsedDays)) {
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - parsedDays);
        query = query.where('sales.created_at', '>=', dateFrom);
      }
    }

    // Date range, applied on the server so a paged history filters the WHOLE record,
    // not just the rows that happen to be on the current page.
    applyDateRange(query, 'sales.created_at', { startDate, endDate });

    applySaleSearch(query, search);

    // The sales HISTORY page pages through the whole record; the exchange and returns
    // lookups just want a short capped list to choose from. wantsPage tells them apart
    // so neither gets the other's shape.
    if (wantsPage({ page, paginate: wantPage })) {
      // The revenue figure under the table must describe the WHOLE filtered set, not the
      // fifty rows on screen — otherwise it shrinks every time you turn the page. Summed
      // from a clone before paging, and always net of refunds and never counting a
      // voided sale, even when voided rows are being shown for the record.
      const summaryRow = await query.clone().clearSelect().clearOrder()
        .whereNull('sales.voided_at')
        .select(db.raw('COALESCE(SUM(sales.final_amount - COALESCE(sales.refunded_amount, 0)), 0) as revenue'))
        .first();
      const { data, pagination } = await paginate(query, { page, limit, defaultLimit: 50, maxLimit: 200 });
      return {
        data: await this._attachItemSummary(data),
        pagination,
        summary: { revenue: Math.round((Number(summaryRow?.revenue) || 0) * 100) / 100 },
      };
    }

    // 200 unless asked for fewer. The exchange screen asks for 25 because it is
    // offering a choice to a person standing at a counter, not filling a report.
    const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 200);
    return this._attachItemSummary(await query.limit(cap));
  }

  /**
   * What was in each sale — one query for the whole page, never one per row.
   *
   * Both screens that list sales already had an "Items" column and both printed a
   * hard-coded dash into it, because this query returned `sales.*` and nothing else.
   * That was survivable while a sale was found by its receipt number. It is not
   * survivable now that a sale can be found by its PRODUCT: searching "Nike" and
   * getting five receipt numbers with nothing to say which is the right one leaves the
   * person opening sales one at a time to find out.
   *
   * Names only — brand and model. Size and colour would have to be formatted through
   * the category rules that live on the client (utils/variantFormat.js), and a second
   * copy of those rules on the server is how "EU KIDS" reached a receipt once already.
   */
  async _attachItemSummary(sales) {
    if (!sales.length) return sales;

    const rows = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .whereIn('sale_items.sale_id', sales.map((s) => s.id))
      .select('sale_items.sale_id', 'products.brand', 'products.model_name');

    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.sale_id)) byId.set(r.sale_id, { count: 0, names: [] });
      const entry = byId.get(r.sale_id);
      // One row is one physical pair, so the row count IS the number of pairs.
      entry.count += 1;
      const name = [r.brand, r.model_name].filter(Boolean).join(' ').trim();
      if (name && !entry.names.includes(name)) entry.names.push(name);
    }

    return sales.map((sale) => {
      const entry = byId.get(sale.id) || { count: 0, names: [] };
      return {
        ...sale,
        item_count: entry.count,
        // Three names is what fits in a table cell; the rest are counted, not hidden.
        item_products: entry.names.slice(0, 3),
        item_products_more: Math.max(0, entry.names.length - 3),
      };
    });
  }

  async getById(id) {
    const { productImageThumbs: hasThumbs } = await capabilities();
    const sale = await db('sales')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .leftJoin('users', 'sales.created_by', 'users.id')
      .where('sales.id', id)
      .leftJoin('users as seller', 'sales.sold_by', 'seller.id')
      .select(
        'sales.*',
        'stores.name as store_name',
        // The receipt is printed from this row, so the branch's own details come with
        // it — a shop with three branches has three phone numbers.
        'stores.phone as store_phone',
        'stores.address as store_address',
        'stores.receipt_note as store_receipt_note',
        'customers.name as customer_name',
        'customers.phone as customer_phone',
        'users.full_name as created_by_name',
        // Who served the customer, where a selling code said so.
        'seller.full_name as sold_by_name'
      )
      .first();

    if (!sale) throw new AppError('Sale not found', 404);

    sale.items = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      // Left join to see if this exact sale item exists in customer_return_items
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .joinRaw(colorImageLateral(hasThumbs))
      .where('sale_items.sale_id', id)
      .select(
        // The picture of the colour that was actually sold — the same LATERAL the
        // inventory list uses, so the two screens cannot show different images for the
        // same pair. A sale is far easier to recognise by its photo than by its SKU.
        'color_img.image_url as color_image_url',
        db.raw('COALESCE(color_img.thumb_url, color_img.image_url) as color_image_thumb_url'),
        // How this category writes a size, and whether the colour is the "no colour"
        // placeholder. Without them variantFormat assumes a shoe and prints "EU KIDS".
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes',
        'product_colors.is_placeholder as color_is_placeholder',
        'sale_items.*',
        'inventory_items.cost',
        'product_variants.sku',
        'product_variants.size_eu',
        'products.product_code',
        'products.model_name as product_name',
        'products.brand',
        'product_colors.color_name',
        'product_colors.hex_code',
        db.raw('CASE WHEN customer_return_items.id IS NOT NULL THEN true ELSE false END as is_returned')
      );

    sale.payments = await db('sale_payments').where('sale_id', id).orderBy('created_at');

    // Surface the outstanding balance so a partially-paid sale is visible in the UI.
    const paid = sale.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    sale.amount_paid = Math.round(paid * 100) / 100;
    sale.amount_due = Math.round((parseFloat(sale.final_amount) - paid) * 100) / 100;

    return sale;
  }

  /**
   * Ring up a sale.
   *
   * `externalTrx` exists so an EXCHANGE can put the return and the outgoing sale in one
   * transaction. Without it an exchange would need its own copy of everything below —
   * the stock lock, the price band, the cost snapshot, the shift link — and a second
   * path for stock leaving the building is exactly how this codebase once ended up with
   * three different formulas for one number.
   *
   * When a transaction is supplied the sale is NOT re-read afterwards: nothing is
   * committed yet, so the caller gets the ids and reads the finished row itself.
   */
  async create(data, user, externalTrx = null, opts = {}) {
    // Store access check. This used to read `user.role`, but the users table has
    // `role_id` — so the comparison was always `undefined !== 'admin'` and any admin
    // not explicitly listed in user_stores was refused. userHasStoreAccess already
    // handles admin, all_stores, assigned_stores and the legacy store_id fallback.
    if (!userHasStoreAccess(user, data.store_id)) {
      throw new AppError('You are not assigned to this store', 403);
    }

    const userId = user.id;
    const saleId = generateUUID();
    const { estimatedCostTracking: trackEstimated } = await capabilities();

    // Who gets credited with the sale. Resolved BEFORE the transaction because it is a
    // bcrypt comparison — slow by design — and holding a stock lock open across it
    // would serialise every till in the shop behind one password check.
    const soldBy = await resolveSeller(user, data);
    let saleNumber = null;

    const body = async (trx) => {
      // Inside the transaction: the advisory lock it takes must be held until commit.
      saleNumber = await generateDocumentNumber('S', trx, 'sales', 'sale_number');
      let totalAmount = 0;

      // Validate items and compute prices
      const saleItems = [];
      for (const reqItem of data.items) {
        const itemId = reqItem.id;
        const item = await trx('inventory_items')
          .where('id', itemId).forUpdate().first();

        if (!item) throw new AppError(`Item ${itemId} not found`, 404);
        if (item.status !== 'in_stock') throw new AppError(`Item ${itemId} is not available (status: ${item.status})`, 400);
        if (item.store_id !== data.store_id) throw new AppError(`Item ${itemId} is not at this store`, 400);

        // Get the product to determine selling price boundaries
        const variant = await trx('product_variants').where('id', item.variant_id).first();
        const product = await trx('products').where('id', variant.product_id).first();

        // Check for store-specific price
        const storePrice = await trx('store_product_prices')
          .where({ product_id: product.id, store_id: data.store_id }).first();

        const defaultPrice = storePrice
          ? parseFloat(storePrice.selling_price)
          : parseFloat(product.default_selling_price) || 0;

        // The band this branch actually trades in.
        //
        // The store's own floor and ceiling win when it has them, falling back to the
        // catalogue's — which is exactly what the POS screen has always computed
        // (`store_min_selling_price ?? min_selling_price`). The server checked only the
        // catalogue band, so a branch could set a floor of 60, watch the till refuse 55
        // on screen, and still have 55 accepted by a hand-made request or any other
        // client. The rule has to live where it is enforced, not where it is displayed.
        const minPrice = storePrice && storePrice.min_selling_price !== null
          ? parseFloat(storePrice.min_selling_price)
          : (product.min_selling_price !== null ? parseFloat(product.min_selling_price) : null);
        const maxPrice = storePrice && storePrice.max_selling_price !== null
          ? parseFloat(storePrice.max_selling_price)
          : (product.max_selling_price !== null ? parseFloat(product.max_selling_price) : null);

        let sellingPrice = defaultPrice;

        if (reqItem.sale_price !== undefined && reqItem.sale_price !== null && reqItem.sale_price !== '') {
          sellingPrice = parseFloat(reqItem.sale_price);
          if (isNaN(sellingPrice) || sellingPrice < 0) {
            throw new AppError(`Invalid sale price for ${product.model_name}`, 400);
          }

          // Who may move a price at all, as opposed to how far it may move.
          //
          // The band says what the shop will accept; this says who is allowed to choose
          // within it. Without it every cashier could sell at the floor all day, and the
          // difference would be invisible — it looks exactly like a run of cheap sales.
          // Enforced here, not by hiding the input: the input is only a suggestion to a
          // client that could be anything.
          //
          // The cent of tolerance is the same rounding allowance the payment check uses.
          if (Math.abs(sellingPrice - defaultPrice) > 0.01 && !canOverridePrice(user)) {
            throw new AppError(
              `You cannot change the price of ${product.model_name}. `
              + `It sells at ${defaultPrice} EGP — ask a manager for a different price.`,
              403
            );
          }

          if (minPrice !== null && Number.isFinite(minPrice) && sellingPrice < minPrice) {
            throw new AppError(`Price for ${product.model_name} cannot be less than the minimum allowed (${minPrice} EGP)`, 400);
          }
          if (maxPrice !== null && Number.isFinite(maxPrice) && sellingPrice > maxPrice) {
            throw new AppError(`Price for ${product.model_name} cannot be more than the maximum allowed (${maxPrice} EGP)`, 400);
          }
        }

        saleItems.push({
          id: generateUUID(),
          sale_id: saleId,
          inventory_item_id: itemId,
          sale_price: sellingPrice,
          cost_at_sale: parseFloat(item.cost),
          // Photocopied for the same reason the cost is: a report has to be able to say
          // "this profit rests on a guessed cost" without joining back to inventory on
          // every query. Omitted entirely where the column is absent, so this code runs
          // on a database that has not had migration 20260903_002 yet.
          ...(trackEstimated ? { cost_is_estimated: item.cost_is_estimated ?? false } : {}),
        });

        totalAmount = Math.round((totalAmount + sellingPrice) * 100) / 100;

        // Mark item as sold
        await trx('inventory_items')
          .where('id', itemId)
          .update({ status: 'sold', sold_at: new Date(), updated_at: new Date() });
      }

      const discountAmount = Math.round((parseFloat(data.discount_amount) || 0) * 100) / 100;
      if (discountAmount < 0) throw new AppError('Discount amount cannot be negative', 400);
      if (discountAmount > totalAmount) throw new AppError('Discount cannot exceed the total amount', 400);

      // A discount has to be either something this user may grant on their own, or one
      // a manager already approved. Checked on the SERVER because the till is the one
      // place a discount can be typed, and hiding the field on screen protects nothing.
      if (discountAmount > 0) {
        await assertDiscountAllowed(trx, {
          user, storeId: data.store_id, amount: discountAmount,
          requestId: data.discount_request_id,
        });
      }

      const finalAmount = Math.round((totalAmount - discountAmount) * 100) / 100;

      // Every sale belongs to the drawer that was open when it was rung up. Attached
      // here rather than matched by timestamp later, so a cash-up cannot disagree with
      // itself. A sale rung with no shift open is still allowed — refusing would stop a
      // shop trading over paperwork — and shows up as unassigned cash instead.
      const shift = await shiftsService.openShiftFor(data.store_id, trx);

      await trx('sales').insert({
        id: saleId,
        sale_number: saleNumber,
        store_id: data.store_id,
        customer_id: data.customer_id || null,
        total_amount: totalAmount,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        notes: data.notes || null,
        shift_id: shift ? shift.id : null,
        // Who actually served the customer, when a passcode says so. `created_by` stays
        // as the audit trail of which session rang it up — several people share a till.
        sold_by: soldBy,
        created_by: userId,
      });

      // Insert sale items
      await trx('sale_items').insert(saleItems);

      // Reconcile payments against the sale total. Nothing checked this before, so a
      // sale could be recorded as paid for less (or more) than it was worth.
      // Overpayment is rejected; underpayment is allowed but surfaced as amount_due,
      // so a partially-paid sale is visible rather than silently lost.
      const paymentsTotal = Math.round(
        (data.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100
      ) / 100;

      // Selling on credit needs someone to collect from. A walk-in has no name, no
      // phone and no history, so an unpaid balance against one is a debt owed by
      // nobody — it would sit in the books forever with nothing to chase.
      //
      // The one-cent tolerance below applies here too: the client sums its own cart
      // while the server re-derives the total per item, and refusing a legitimate
      // cash sale over a rounding cent would be worse than the thing this guards.
      // `settledByCaller` is a fourth ARGUMENT, never a field on `data`, so a client
      // cannot post it: an exchange settles the money itself a few lines later, inside
      // this same transaction, and would otherwise trip the walk-in rule on an even swap
      // where nothing is owed at all.
      if (!opts.settledByCaller && paymentsTotal < finalAmount - 0.01) {
        await assertCreditAllowed(trx, {
          user,
          storeId: data.store_id,
          customerId: data.customer_id,
          amount: Math.round((finalAmount - paymentsTotal) * 100) / 100,
          requestId: data.credit_request_id,
        });
      }

      // One-cent tolerance: the client sums its own cart to produce the payment
      // amount while the server re-derives the total from per-item prices, so the two
      // can differ in the last cent purely from rounding. Rejecting that would fail a
      // legitimate checkout and roll the whole sale back.
      if (paymentsTotal > finalAmount + 0.01) {
        throw new AppError(
          `Payments (${paymentsTotal.toFixed(2)}) exceed the sale total (${finalAmount.toFixed(2)})`,
          400
        );
      }

      // Single batch insert instead of one round-trip per payment method. A sale taken
      // entirely on account has no payments at all, and knex rejects an empty insert.
      if (data.payments && data.payments.length) {
        await trx('sale_payments').insert(
          data.payments.map((payment) => ({
            id: generateUUID(),
            sale_id: saleId,
            amount: payment.amount,
            payment_method: payment.payment_method,
            reference_no: payment.reference_no || null,
          }))
        );
      }
    };

    if (externalTrx) {
      await body(externalTrx);
      return { id: saleId, sale_number: saleNumber };
    }
    await db.transaction(body);
    return this.getById(saleId);
  }

  /**
   * Undo a sale that should never have been rung up.
   *
   * A void is not a return. A return is the customer bringing goods back, and the
   * system already records that against the sale. A void says the sale never happened:
   * the stock goes back as if it had not left, and every report stops counting it.
   *
   * What is NOT done, deliberately: the sale, its lines and its payments are all kept.
   * Deleting them would leave a gap in the sale numbering with nothing to explain it,
   * and the record of a mistake is worth more than a tidy table.
   *
   * The whole thing is one transaction with the sale locked, so two people voiding at
   * once cannot both return the same stock.
   */
  async voidSale(saleId, { reason }, user) {
    await db.transaction(async (trx) => {
      const sale = await trx('sales').where('id', saleId).forUpdate().first();
      if (!sale) throw new AppError('Sale not found', 404);
      if (sale.voided_at) throw new AppError('This sale has already been voided', 400);

      if (!userHasStoreAccess(user, sale.store_id)) {
        throw new AppError('You are not assigned to this store', 403);
      }

      const items = await trx('sale_items').where('sale_id', saleId);

      // A returned line has already been reversed once. Voiding on top of it would
      // put the same pair back into stock twice.
      const returned = await trx('customer_return_items')
        .whereIn('sale_item_id', items.map((i) => i.id))
        .count('id as n')
        .first();
      if (Number(returned.n) > 0) {
        throw new AppError(
          'Some of this sale has already been returned, so it cannot be voided. Return the rest instead.',
          400
        );
      }

      // Every pair must still be exactly where the sale left it. If one has since been
      // transferred or sold again, silently flipping it back to in_stock would invent
      // stock in the wrong place — so name it and stop.
      const inventoryIds = items.map((i) => i.inventory_item_id);
      const moved = await trx('inventory_items as ii')
        .join('product_variants as v', 'v.id', 'ii.variant_id')
        .join('products as p', 'p.id', 'v.product_id')
        .whereIn('ii.id', inventoryIds)
        .whereNot('ii.status', 'sold')
        .select('p.product_code', 'v.size_eu', 'ii.status');
      if (moved.length) {
        const names = moved.map((m) => `${m.product_code} ${m.size_eu} (${m.status})`).join(', ');
        throw new AppError(
          `Cannot void: ${names} has moved on since this sale. Use a customer return instead.`,
          400
        );
      }

      await trx('inventory_items')
        .whereIn('id', inventoryIds)
        .update({ status: 'in_stock', sold_at: null, updated_at: new Date() });

      await trx('sales').where('id', saleId).update({
        voided_at: new Date(),
        voided_by: user.id,
        void_reason: reason || null,
      });
    });

    return this.getById(saleId);
  }

  /**
   * Edit the parts of a completed sale that carry no money.
   *
   * Items and prices are not editable by design. A sale is a receipt the customer is
   * holding and a number the shop has banked; changing either afterwards makes the
   * reports disagree with reality with nothing to show what happened. A mis-rung sale
   * is voided and rung again, which says so plainly.
   */
  async updateSale(saleId, data, user) {
    const sale = await db('sales').where('id', saleId).first();
    if (!sale) throw new AppError('Sale not found', 404);
    if (sale.voided_at) throw new AppError('A voided sale cannot be edited', 400);
    if (!userHasStoreAccess(user, sale.store_id)) {
      throw new AppError('You are not assigned to this store', 403);
    }

    const safe = {};
    if (data.customer_id !== undefined) {
      const customerId = data.customer_id || null;
      if (customerId) {
        const customer = await db('customers').where('id', customerId).first();
        if (!customer) throw new AppError('Customer not found', 404);
      } else {
        // Moving a sale back to walk-in would leave any unpaid balance owed by nobody.
        const paid = await db('sale_payments').where('sale_id', saleId).sum('amount as total').first();
        const outstanding = Math.round((parseFloat(sale.final_amount) - (parseFloat(paid.total) || 0)) * 100) / 100;
        if (outstanding > 0.01) {
          throw new AppError(
            `This sale still has ${outstanding.toFixed(2)} outstanding, so it cannot be moved to a walk-in customer.`,
            400
          );
        }
      }
      safe.customer_id = customerId;
    }
    if (data.notes !== undefined) safe.notes = data.notes || null;
    if (!Object.keys(safe).length) throw new AppError('Nothing to update', 400);

    await db('sales').where('id', saleId).update(safe);
    return this.getById(saleId);
  }

  /**
   * What a customer still owes, and on which sales.
   *
   * Voided sales are excluded: they did not happen, so nobody owes anything for them.
   */
  async customerBalance(customerId, { store_id, store_ids } = {}) {
    const query = db('sales')
      .leftJoin('stores', 'stores.id', 'sales.store_id')
      .where('sales.customer_id', customerId)
      .whereNull('sales.voided_at')
      .select(
        'sales.id', 'sales.sale_number', 'sales.created_at', 'sales.final_amount',
        'sales.refunded_amount', 'stores.name as store_name',
        db.raw('COALESCE((SELECT SUM(amount) FROM sale_payments sp WHERE sp.sale_id = sales.id), 0) as paid')
      )
      .orderBy('sales.created_at', 'desc');
    applyStoreScope(query, 'sales.store_id', { store_id, store_ids });

    const rows = await query;
    const sales = rows.map((r) => {
      const due = Math.round((parseFloat(r.final_amount) - parseFloat(r.paid)) * 100) / 100;
      return { ...r, final_amount: parseFloat(r.final_amount), paid: parseFloat(r.paid), due };
    });
    const unpaid = sales.filter((s) => s.due > 0.01);

    return {
      outstanding: Math.round(unpaid.reduce((n, s) => n + s.due, 0) * 100) / 100,
      unpaid_count: unpaid.length,
      unpaid_sales: unpaid,
      sales,
    };
  }

  async addPayment(saleId, paymentData) {
    // Validate payment amount
    const amount = parseFloat(paymentData.amount);
    if (isNaN(amount) || amount <= 0) throw new AppError('Payment amount must be positive', 400);

    // The read-then-insert used to run outside any transaction, so two concurrent
    // payments could each see the same total, both pass the overpayment check, and
    // together overpay the sale. forUpdate serialises them on the sale row.
    return db.transaction(async (trx) => {
      const sale = await trx('sales').where('id', saleId).forUpdate().first();
      if (!sale) throw new AppError('Sale not found', 404);
      // Settling a voided sale would take money for something that did not happen.
      if (sale.voided_at) throw new AppError('This sale has been voided', 400);

      const existingPayments = await trx('sale_payments').where('sale_id', saleId).sum('amount as total').first();
      const totalPaid = Math.round((parseFloat(existingPayments.total || 0)) * 100) / 100;
      const saleTotal = Math.round(parseFloat(sale.final_amount) * 100) / 100;
      if (Math.round((totalPaid + amount) * 100) / 100 > saleTotal) {
        throw new AppError(`Payment would exceed sale total. Remaining: ${(saleTotal - totalPaid).toFixed(2)}`, 400);
      }

      const [payment] = await trx('sale_payments').insert({
        id: generateUUID(),
        sale_id: saleId,
        amount: amount,
        payment_method: paymentData.payment_method,
        reference_no: paymentData.reference_no || null,
      }).returning('*');

      return payment;
    });
  }

  async exportExcel({ store_id, store_ids, startDate, endDate, search } = {}) {
    let query = db('sales').whereNull('sales.voided_at')
      .join('stores', 'sales.store_id', 'stores.id')
      .leftJoin('customers', 'sales.customer_id', 'customers.id')
      .select(
        'sales.id', 'sales.sale_number', 'sales.final_amount',
        'sales.refunded_amount', 'sales.created_at',
        'stores.name as store_name',
        'customers.name as customer_name'
      )
      .orderBy('sales.created_at', 'desc')
      .limit(5000);

    applyStoreScope(query, 'sales.store_id', { store_id, store_ids });
    applyDateRange(query, 'sales.created_at', { startDate, endDate });
    // The same predicate the screen used, so Export means "export what I am looking at"
    // rather than "export everything, silently".
    applySaleSearch(query, search);

    const sales = await query;
    if (!sales.length) return [];

    const saleIds = sales.map(s => s.id);

    const items = await db('sale_items')
      .join('inventory_items', 'sale_items.inventory_item_id', 'inventory_items.id')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .join('product_colors', 'product_variants.product_color_id', 'product_colors.id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'products.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'product_variants.size_scale_value_id')
      .leftJoin('customer_return_items', 'sale_items.id', 'customer_return_items.sale_item_id')
      .whereIn('sale_items.sale_id', saleIds)
      .whereNull('customer_return_items.id')
      .select(
        'sale_items.sale_id', 'sale_items.sale_price',
        'products.product_code', 'products.model_name',
        'product_colors.color_name', 'product_variants.size_eu',
        // How this category writes a size, and whether the colour is the "no colour"
        // placeholder. Without them variantFormat assumes a shoe and prints "EU KIDS".
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en',
        'ssv.label_ar as size_label_ar',
        'pcat.has_sizes',
        'product_colors.is_placeholder as color_is_placeholder'
      );

    const payments = await db('sale_payments')
      .whereIn('sale_id', saleIds)
      .select('sale_id', 'amount', 'payment_method');

    // Index by sale_id
    const itemsBySale = {};
    for (const it of items) {
      if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
      itemsBySale[it.sale_id].push(it);
    }
    const paymentsBySale = {};
    for (const p of payments) {
      if (!paymentsBySale[p.sale_id]) paymentsBySale[p.sale_id] = [];
      paymentsBySale[p.sale_id].push(p);
    }

    // Build rows: one row per sale item
    const rows = [];
    for (const sale of sales) {
      const saleItems = itemsBySale[sale.id] || [];
      const salePayments = paymentsBySale[sale.id] || [];
      const cashTotal = salePayments.filter(p => p.payment_method === 'cash').reduce((s, p) => s + parseFloat(p.amount), 0);
      const otherTotal = salePayments.filter(p => p.payment_method !== 'cash').reduce((s, p) => s + parseFloat(p.amount), 0);
      const otherMethods = [...new Set(salePayments.filter(p => p.payment_method !== 'cash').map(p => p.payment_method))].join(', ');

      for (let i = 0; i < saleItems.length; i++) {
        const item = saleItems[i];
        rows.push({
          sale_number: sale.sale_number,
          date: new Date(sale.created_at).toLocaleDateString(),
          store: sale.store_name,
          customer: sale.customer_name || 'Walk-in',
          product: `${item.product_code} - ${item.model_name}`,
          // Written the way the app writes a size and a colour anywhere else: a sock
          // exports as "Kids", not "KIDS", and a knife's stand-in colour as blank
          // rather than the word "Standard".
          color: formatColor(item),
          size: formatSize(item),
          price: parseFloat(item.sale_price),
          cash: i === 0 ? cashTotal : '',
          other: i === 0 ? otherTotal : '',
          other_methods: i === 0 ? otherMethods : '',
        });
      }
    }

    return rows;
  }
}

module.exports = new SalesService();
