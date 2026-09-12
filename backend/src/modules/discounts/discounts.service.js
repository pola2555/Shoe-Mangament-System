const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { capabilities } = require('../../utils/schemaCapabilities');
const bcrypt = require('bcryptjs');
const { generateUUID, generateDocumentNumber } = require('../../utils/generateCodes');
const { applyStoreScope } = require('../../utils/storeScope');
const { userHasStoreAccess } = require('../../middleware/auth');

/**
 * Discount requests — a cashier asks, a manager answers, the till carries on.
 *
 * WHY ASYNCHRONOUS
 *
 * The alternative is a manager walking to the till and typing a password into someone
 * else's session. That works in one shop with the manager on the floor and fails
 * everywhere else, and it teaches staff that a manager's password is a thing you hand
 * over. A request that a manager can answer from anywhere costs a parked cart and
 * nothing else.
 *
 * WHAT A PARKED CART IS NOT
 *
 * It is not a reservation. The stock stays on the shelf and can be sold to the next
 * person who walks in — which is correct: holding stock for an unapproved discount
 * would lose real sales. So every line is re-validated when the cart is resumed, and
 * `resume` tells the cashier exactly which pair is gone rather than failing vaguely.
 *
 * The approval is consumed inside the SALE's transaction (see sales.service
 * `assertDiscountAllowed`), not here, so two tills cannot spend one approval twice.
 */

const DEFAULT_TTL_HOURS = 12;
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

class DiscountsService {
  /**
   * Park a cart and ask for a discount.
   *
   * The cart total is computed HERE from the inventory rows, not taken from the client:
   * an approval is a manager agreeing to give away a specific amount, and it must be
   * anchored to a total the server believes in.
   */
  async request(data, user) {
    const items = data.items || [];
    if (items.length === 0) throw new AppError('There is nothing in the cart', 400);
    // 'discount' asks to give away margin; 'credit' asks to let the customer walk out
    // without paying. Same parked-cart machinery, different question and different
    // permission to answer it — see migration 20260904_003.
    const kind = data.kind === 'credit' ? 'credit' : 'discount';
    if (kind === 'credit' && !data.customer_id) {
      throw new AppError(
        'A walk-in must pay in full. Add the customer to the system to sell on account.', 400);
    }

    const ids = items.map((i) => i.id);
    const rows = await db('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .join('products as p', 'p.id', 'pv.product_id')
      .leftJoin('store_product_prices as spp', function () {
        this.on('spp.product_id', '=', 'p.id').andOn('spp.store_id', '=', db.raw('?', [data.store_id]));
      })
      .whereIn('ii.id', ids)
      .select('ii.id', 'ii.status', 'ii.store_id', 'p.model_name', 'p.product_code',
        'p.default_selling_price', 'spp.selling_price as store_price',
        // The floor, per line, so the approver can be told how far under it they are
        // going. Captured at REQUEST time and stored with the cart: a band edited
        // between asking and answering must not silently change what was agreed.
        'p.min_selling_price', 'spp.min_selling_price as store_min_price');

    if (rows.length !== ids.length) throw new AppError('One of those items no longer exists', 400);

    const byId = new Map(rows.map((r) => [r.id, r]));
    let total = 0;
    let minTotal = 0;
    const cart = items.map((i) => {
      const row = byId.get(i.id);
      const price = i.sale_price !== undefined && i.sale_price !== null && i.sale_price !== ''
        ? money(i.sale_price)
        : money(row.store_price ?? row.default_selling_price ?? 0);
      // A branch floor beats the catalogue floor, the same precedence the till uses.
      // No floor at all means this line has none to breach, so it contributes its own
      // price — otherwise a product with no minimum would drag the whole floor to zero
      // and the warning would never fire.
      const floor = row.store_min_price ?? row.min_selling_price;
      const lineFloor = floor === null || floor === undefined ? price : money(floor);
      total = money(total + price);
      minTotal = money(minTotal + lineFloor);
      return {
        id: i.id, sale_price: price, name: row.model_name, code: row.product_code,
        min_price: lineFloor,
      };
    });

    let requested = 0;
    let requestedCredit = 0;
    if (kind === 'credit') {
      requestedCredit = money(data.requested_credit);
      if (!(requestedCredit > 0)) throw new AppError('Ask for an amount greater than zero', 400);
      if (requestedCredit > total) {
        throw new AppError('The amount left unpaid cannot be more than the sale', 400);
      }
    } else {
      requested = money(data.requested_discount);
      if (!(requested > 0)) throw new AppError('Ask for a discount greater than zero', 400);
      if (requested > total) throw new AppError('The discount cannot be more than the cart', 400);
    }

    const id = generateUUID();
    await db.transaction(async (trx) => {
      const number = await generateDocumentNumber('DR', trx, 'discount_requests', 'request_number');
      await trx('discount_requests').insert({
        id,
        request_number: number,
        store_id: data.store_id,
        requested_by: user.id,
        status: 'pending',
        cart: JSON.stringify(cart),
        customer_id: data.customer_id || null,
        kind,
        cart_total: total,
        min_total: minTotal,
        requested_discount: requested,
        requested_credit: kind === 'credit' ? requestedCredit : null,
        reason: data.reason || null,
        expires_at: new Date(Date.now() + DEFAULT_TTL_HOURS * 3600 * 1000),
      });

      // One notification per person who can actually answer it. A shared pile would be
      // read by nobody, and the cashier is standing at the counter waiting.
      const approvers = await trx('users as u')
        .leftJoin('roles as r', 'r.id', 'u.role_id')
        .leftJoin('user_permissions as up', function () {
          this.on('up.user_id', '=', 'u.id')
            .andOn('up.permission_code', '=', trx.raw('?', [kind === 'credit' ? 'credit_approval' : 'discount_approval']));
        })
        .where('u.is_active', true)
        .where((b) => b.where('r.name', 'admin').orWhereNotNull('up.permission_code'))
        .distinct('u.id');

      if (approvers.length) {
        await trx('notifications').insert(approvers.map((a) => ({
          id: generateUUID(),
          user_id: a.id,
          type: kind === 'credit' ? 'credit_request' : 'discount_request',
          title: kind === 'credit'
            ? `Pay-later requested: ${number}`
            : `Discount requested: ${number}`,
          message: kind === 'credit'
            ? `${user.full_name || 'A cashier'} is asking to let a customer take `
              + `${total} EGP of goods and leave ${requestedCredit} EGP unpaid`
              + `${data.reason ? ` — ${data.reason}` : ''}.`
            : `${user.full_name || 'A cashier'} is asking for ${requested} EGP off a `
              + `${total} EGP sale${data.reason ? ` — ${data.reason}` : ''}.`,
          title_key: kind === 'credit'
            ? 'notifications.credit_request_title' : 'notifications.discount_request_title',
          message_key: kind === 'credit'
            ? 'notifications.credit_request_message' : 'notifications.discount_request_message',
          params: JSON.stringify({
            number, who: user.full_name || '',
            amount: kind === 'credit' ? requestedCredit : requested,
            total, reason: data.reason || '',
          }),
          reference_id: id,
          created_at: new Date(),
        })));
      }
    });

    return this.getById(id);
  }

  /**
   * Approve, possibly for less than was asked. Rejecting takes the same path.
   *
   * BELOW THE FLOOR
   *
   * A discount that takes the sale under the sum of the line minimums is allowed — the
   * owner asked for it to be possible — but never by accident. The first attempt is
   * refused with the two numbers in the message; sending `acknowledge_below_min` lets
   * it through. That is a deliberate second action rather than a checkbox the server
   * trusts blindly, and the acknowledgement is recorded on the request so the decision
   * can be read back later as "they knew".
   */
  async decide(id, { approve, amount, note, acknowledge_below_min: acknowledged }, user) {
    await db.transaction(async (trx) => {
      const request = await trx('discount_requests').where('id', id).forUpdate().first();
      if (!request) throw new AppError('Discount request not found', 404);
      // A manager answers requests for their OWN branch. Permission to approve is not
      // permission to reach into another shop's till.
      if (!userHasStoreAccess(user, request.store_id)) {
        throw new AppError('This request belongs to another branch', 403);
      }
      if (request.status !== 'pending') {
        throw new AppError(`This request is already ${request.status}`, 400);
      }

      const isCredit = request.kind === 'credit';
      let approved = null;
      let approvedCredit = null;
      let belowMin = false;

      // Answering is gated by KIND, not by one blanket permission: a shop may trust
      // somebody to give 50 off and not to let stock walk out unpaid.
      const needed = isCredit ? 'credit_approval' : 'discount_approval';
      if (user.role_name !== 'admin' && user.permissions?.[needed] !== 'write') {
        throw new AppError(
          isCredit
            ? 'You cannot approve letting a customer pay later'
            : 'You cannot approve discounts', 403);
      }

      if (approve && isCredit) {
        // Approving LESS credit than asked is the useful middle answer: "they can owe
        // 200, not 500". The rest has to be paid at the counter.
        approvedCredit = amount === undefined || amount === null
          ? money(request.requested_credit)
          : money(amount);
        if (!(approvedCredit > 0)) {
          throw new AppError('Approve an amount greater than zero, or reject it', 400);
        }
        if (approvedCredit > money(request.cart_total)) {
          throw new AppError('They cannot owe more than the sale is worth', 400);
        }
      }

      if (approve && !isCredit) {
        approved = amount === undefined || amount === null
          ? money(request.requested_discount)
          : money(amount);
        if (!(approved > 0)) throw new AppError('Approve an amount greater than zero, or reject it', 400);
        if (approved > money(request.cart_total)) {
          throw new AppError('The discount cannot be more than the cart', 400);
        }

        const floor = money(request.min_total || 0);
        const after = money(money(request.cart_total) - approved);
        if (floor > 0 && after < floor && !acknowledged) {
          const err = new AppError(
            `That leaves ${after} EGP, which is under the ${floor} EGP minimum for these `
            + 'items. Approve again to go ahead anyway.', 409);
          // Carried so the screen can show the two numbers rather than parse a sentence.
          err.details = { below_min: true, after, min_total: floor, shortfall: money(floor - after) };
          throw err;
        }
        belowMin = floor > 0 && after < floor;
      }

      await trx('discount_requests').where('id', id).update({
        status: approve ? 'approved' : 'rejected',
        approved_discount: approved,
        approved_credit: approvedCredit,
        decided_by: user.id,
        decided_at: new Date(),
        decision_note: note || null,
        below_min_acknowledged: belowMin,
        updated_at: new Date(),
      });

      // Tell the person who is still standing at the till.
      if (request.requested_by) {
        await trx('notifications').insert({
          id: generateUUID(),
          user_id: request.requested_by,
          type: isCredit ? 'credit_decision' : 'discount_decision',
          title: approve
            ? `${isCredit ? 'Pay-later' : 'Discount'} approved: ${request.request_number}`
            : `${isCredit ? 'Pay-later' : 'Discount'} refused: ${request.request_number}`,
          message: approve
            ? `${user.full_name || 'A manager'} approved `
              + `${isCredit ? `${approvedCredit} EGP on account` : `${approved} EGP off`}.`
              + `${note ? ` ${note}` : ''} Open the till and finish the sale.`
            : `${user.full_name || 'A manager'} refused this `
              + `${isCredit ? 'pay-later request' : 'discount'}.${note ? ` ${note}` : ''}`,
          title_key: approve
            ? (isCredit ? 'notifications.credit_approved_title' : 'notifications.discount_approved_title')
            : (isCredit ? 'notifications.credit_rejected_title' : 'notifications.discount_rejected_title'),
          message_key: approve
            ? (isCredit ? 'notifications.credit_approved_message' : 'notifications.discount_approved_message')
            : (isCredit ? 'notifications.credit_rejected_message' : 'notifications.discount_rejected_message'),
          params: JSON.stringify({
            number: request.request_number, who: user.full_name || '',
            amount: (isCredit ? approvedCredit : approved) || 0, note: note || '',
          }),
          reference_id: id,
          created_at: new Date(),
        });
      }
    });

    return this.getById(id);
  }

  async cancel(id, user) {
    const request = await db('discount_requests').where('id', id).first();
    if (!request) throw new AppError('Discount request not found', 404);
    if (!userHasStoreAccess(user, request.store_id)) {
      throw new AppError('This request belongs to another branch', 403);
    }
    if (request.status !== 'pending' && request.status !== 'approved') {
      throw new AppError(`This request is already ${request.status}`, 400);
    }
    if (request.requested_by !== user.id && user.role_name !== 'admin') {
      throw new AppError('Only the person who asked, or an admin, can cancel this', 403);
    }
    await db('discount_requests').where('id', id).update({ status: 'cancelled', updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * Pick the parked cart back up.
   *
   * Nothing was reserved, so this is where the cashier finds out what has gone. Each
   * missing pair is named: "that one sold" is actionable, "resume failed" is not.
   */
  async resume(id, user) {
    const request = await this.getById(id, user);
    if (request.status === 'used') throw new AppError('This sale has already been completed', 409);
    if (request.status === 'rejected') {
      throw new AppError(request.kind === 'credit'
        ? 'This pay-later request was refused' : 'This discount was refused', 400);
    }
    if (request.status === 'cancelled') throw new AppError('This request was cancelled', 400);
    if (request.status === 'pending') throw new AppError('This is still waiting for a decision', 400);
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      throw new AppError('This approval has expired. Ask again.', 400);
    }

    const cart = request.cart || [];
    const rows = await db('inventory_items')
      .whereIn('id', cart.map((c) => c.id))
      .select('id', 'status', 'store_id');
    const byId = new Map(rows.map((r) => [r.id, r]));

    const gone = [];
    const available = [];
    for (const line of cart) {
      const row = byId.get(line.id);
      if (!row || row.status !== 'in_stock' || row.store_id !== request.store_id) {
        gone.push({ ...line, why: !row ? 'removed' : row.status });
      } else {
        available.push(line);
      }
    }

    return {
      ...request,
      resumable: gone.length === 0,
      available_items: available,
      // A parked cart holds no stock, deliberately — so this is the normal case on a
      // busy day, not an error.
      unavailable_items: gone,
    };
  }

  async list({ store_id, store_ids, status, kind, mine, user, limit } = {}) {
    const q = db('discount_requests as dr')
      .leftJoin('stores', 'stores.id', 'dr.store_id')
      .leftJoin('users as rq', 'rq.id', 'dr.requested_by')
      .leftJoin('users as dc', 'dc.id', 'dr.decided_by')
      .leftJoin('customers as c', 'c.id', 'dr.customer_id')
      .select('dr.*', 'stores.name as store_name', 'rq.full_name as requested_by_name',
        'dc.full_name as decided_by_name', 'c.name as customer_name')
      .orderBy('dr.created_at', 'desc')
      .limit(Math.min(200, parseInt(limit, 10) || 50));
    applyStoreScope(q, 'dr.store_id', { store_id, store_ids });
    if (status) q.where('dr.status', status);
    if (kind) q.where('dr.kind', kind);
    if (mine && user) q.where('dr.requested_by', user.id);
    const rows = await q;
    // One decorate per row would be a query storm on a 50-row queue, so the whole page
    // is decorated in one pass.
    return this._decorateMany(rows);
  }

  /** _decorateCart across a page of requests, in a single lookup. */
  async _decorateMany(rows) {
    const all = rows.flatMap((r) => (Array.isArray(r.cart) ? r.cart : []));
    if (all.length === 0) return rows;
    const decorated = await this._decorateCart(all);
    const byId = new Map(decorated.map((d) => [d.id, d]));
    return rows.map((r) => ({
      ...r,
      cart: (Array.isArray(r.cart) ? r.cart : []).map((l) => ({ ...l, ...(byId.get(l.id) || {}) })),
    }));
  }

  async getById(id, user = null) {
    const row = await db('discount_requests as dr')
      .leftJoin('stores', 'stores.id', 'dr.store_id')
      .leftJoin('users as rq', 'rq.id', 'dr.requested_by')
      .leftJoin('users as dc', 'dc.id', 'dr.decided_by')
      .leftJoin('customers as c', 'c.id', 'dr.customer_id')
      .where('dr.id', id)
      .first('dr.*', 'stores.name as store_name', 'rq.full_name as requested_by_name',
        'dc.full_name as decided_by_name', 'c.name as customer_name');
    if (!row) throw new AppError('Discount request not found', 404);
    // A discount request is one branch's business — its cart, its customer, and the
    // pricing floor. Without this a `pos:read` user at any branch could read another
    // branch's request by its id (and the floor leaked past priceVisibility besides).
    // Every other module scopes getById on the loaded row; this one did not.
    if (user && !userHasStoreAccess(user, row.store_id)) {
      throw new AppError('This request belongs to another branch', 403);
    }
    row.cart = await this._decorateCart(row.cart);
    return row;
  }

  /**
   * Put the picture, the size and the colour back on each parked line.
   *
   * A manager answering "can I give 100 off?" was shown a product code and a number.
   * That is not enough to judge it: 100 off a pair of sandals and 100 off a boot are
   * different answers, and the person deciding is usually not the person holding the
   * shoe.
   *
   * Resolved on READ rather than stored in the parked cart, so a product photographed
   * or renamed after the request was made still shows correctly — and so the cart json
   * stays small.
   */
  async _decorateCart(cart) {
    const lines = Array.isArray(cart) ? cart : [];
    if (lines.length === 0) return lines;

    const { productImageThumbs: hasThumbs } = await capabilities();
    const thumbCol = hasThumbs ? 'pci.thumb_url' : 'NULL::text as thumb_url';

    const rows = await db('inventory_items as ii')
      .join('product_variants as pv', 'pv.id', 'ii.variant_id')
      .join('products as p', 'p.id', 'pv.product_id')
      .join('product_colors as pc', 'pc.id', 'pv.product_color_id')
      .leftJoin('product_categories as pcat', 'pcat.id', 'p.category_id')
      .leftJoin('size_scales as sscale', 'sscale.id', 'pcat.size_scale_id')
      .leftJoin('size_scale_values as ssv', 'ssv.id', 'pv.size_scale_value_id')
      .joinRaw(`LEFT JOIN LATERAL (
        SELECT pci.image_url, ${thumbCol}
        FROM product_color_images pci
        WHERE pci.product_color_id = pc.id
        ORDER BY pci.is_primary DESC, pci.created_at ASC
        LIMIT 1
      ) color_img ON TRUE`)
      .whereIn('ii.id', lines.map((l) => l.id))
      .select(
        'ii.id', 'ii.status',
        'p.brand', 'p.model_name', 'p.product_code',
        'pv.size_eu', 'pv.sku',
        'pc.color_name', 'pc.is_placeholder',
        'pcat.has_sizes',
        'sscale.display_prefix as size_prefix',
        'sscale.display_suffix as size_suffix',
        'ssv.label_en as size_label_en', 'ssv.label_ar as size_label_ar',
        'color_img.image_url', 'color_img.thumb_url',
      );

    const byId = new Map(rows.map((r) => [r.id, r]));
    return lines.map((l) => ({ ...l, ...(byId.get(l.id) || {}) }));
  }

  // ================================================================
  //  SELLER CODES
  // ================================================================

  /**
   * Set the short code a person types at checkout to claim a sale.
   *
   * Unique WITHIN a branch, because that is where it is resolved: a code matching two
   * people at one till would credit the money to whichever row came back first, and
   * nothing on screen would say so. Across branches it may repeat — two shops never
   * compare codes.
   */
  async setSellerCode(userId, code) {
    const value = String(code || '').trim();
    if (value.length < 3 || value.length > 20) {
      throw new AppError('A selling code is between 3 and 20 characters', 400);
    }

    const person = await db('users').where('id', userId).first();
    if (!person) throw new AppError('User not found', 404);

    const stores = await db('user_stores').where('user_id', userId).pluck('store_id');
    if (person.store_id) stores.push(person.store_id);

    if (stores.length) {
      const colleagues = await db('users as u')
        .leftJoin('user_stores as us', 'us.user_id', 'u.id')
        .whereNot('u.id', userId)
        .whereNotNull('u.seller_code_hash')
        .where((b) => b.whereIn('us.store_id', stores).orWhereIn('u.store_id', stores))
        .distinct('u.id', 'u.full_name', 'u.seller_code_hash');

      for (const colleague of colleagues) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(value, colleague.seller_code_hash)) {
          throw new AppError(
            `${colleague.full_name} already uses that code at one of these branches. Pick another.`,
            409
          );
        }
      }
    }

    await db('users').where('id', userId).update({
      seller_code_hash: await bcrypt.hash(value, 10),
      updated_at: new Date(),
    });
    return { ok: true };
  }

  async clearSellerCode(userId) {
    const n = await db('users').where('id', userId).update({ seller_code_hash: null, updated_at: new Date() });
    if (!n) throw new AppError('User not found', 404);
    return { ok: true };
  }

  /** Who at this branch can claim a sale. Never returns anything resembling a code. */
  async sellersAt(storeId) {
    return db('users as u')
      .leftJoin('user_stores as us', 'us.user_id', 'u.id')
      .where('u.is_active', true)
      .where((b) => b.where('us.store_id', storeId).orWhere('u.store_id', storeId))
      .distinct('u.id', 'u.full_name')
      .select(db.raw('u.seller_code_hash IS NOT NULL as has_code'))
      .orderBy('u.full_name');
  }
}

module.exports = new DiscountsService();
