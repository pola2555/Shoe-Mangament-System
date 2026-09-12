const storesService = require('./stores.service');

class StoresController {
  /**
   * Every store. `include_stats=1` attaches a live picture of each — deliberately
   * opt-in, because most callers of this endpoint want nothing but the names.
   */
  async list(req, res, next) {
    try {
      // Names are reference data every screen needs; figures are money. Asking for
      // stats without `reports:read` gets the names, silently, rather than a 403 that
      // would break a page that only wanted the names anyway.
      const wantsStats = req.query.include_stats === '1' || req.query.include_stats === 'true';
      const maySeeMoney = req.user?.role_name === 'admin' || Boolean(req.user?.permissions?.reports);
      const stores = await storesService.list(
        { is_active: req.query.is_active, include_stats: wantsStats && maySeeMoney },
        req.user
      );
      res.json({ success: true, data: stores });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const store = await storesService.getById(req.params.id);
      res.json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const store = await storesService.create(req.body);
      res.status(201).json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const store = await storesService.update(req.params.id, req.body);
      res.json({ success: true, data: store });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------- reports

  async overview(req, res, next) {
    try {
      const data = await storesService.overview(req.params.id, req.query, req.user);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async comparison(req, res, next) {
    try {
      const data = await storesService.comparison(req.query, req.user);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------- staff

  async listStaff(req, res, next) {
    try {
      const staff = await storesService.listStaff(req.params.id);
      res.json({ success: true, data: staff });
    } catch (error) {
      next(error);
    }
  }

  async setStaff(req, res, next) {
    try {
      // Assigning staff to a branch writes the SAME user_stores table that the
      // admin-only `PUT /users/:id/stores` does, and store assignment is what grants a
      // user that branch's sales, stock, expenses and reports. Gated only on
      // users:write, this was a way for a non-admin to self-assign to any branch (or
      // wipe another branch's staff). Assigning access is an admin act, matching
      // setStores.
      if (req.user.role_name !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Only an admin can change which staff are assigned to a branch',
        });
      }
      const staff = await storesService.setStaff(req.params.id, req.body.user_ids);
      res.json({ success: true, data: staff });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------- pricing

  async listPrices(req, res, next) {
    try {
      const result = await storesService.listPrices(req.params.id, req.query);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async setPrice(req, res, next) {
    try {
      const row = await storesService.setPrice(req.params.id, req.params.productId, req.body);
      res.json({ success: true, data: row });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new StoresController();
