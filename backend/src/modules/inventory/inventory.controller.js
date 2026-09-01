const inventoryService = require('./inventory.service');
const db = require('../../config/database');
const AppError = require('../../utils/AppError');
const { userHasStoreAccess } = require('../../middleware/auth');
const { resolveStoreScope } = require('../../utils/storeScope');
const env = require('../../config/env');

// Cap on a proxied image. The handler used to buffer the entire remote response into
// memory with no limit, so a single large URL could spike RSS or OOM the process.
const MAX_PROXY_IMAGE_BYTES = 10 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 10000;

/**
 * Allowlist for the export proxy.
 *
 * Fails CLOSED. The previous version began with `if (!bucket) return true`, which
 * permitted any http/https URL whenever S3 was not configured — letting an
 * authenticated user make the server fetch internal addresses, including the cloud
 * metadata endpoint at 169.254.169.254.
 */
function isAllowedExportImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    // Local storage mode: the path alone is not enough — any host serving a
    // /uploads/ path would pass, which leaves the SSRF open. Pin the host to our
    // own configured origin as well.
    if (env.storage?.type !== 's3') {
      if (!parsed.pathname.startsWith(`/${env.storage.uploadDir}/`)) return false;
      if (parsed.pathname.includes('..')) return false;
      try {
        const selfOrigin = new URL(env.cors.origin);
        if (parsed.host === selfOrigin.host) return true;
        // Loopback is allowed only outside production, where the API and the Vite dev
        // server sit on different ports. Allowing any localhost port in production
        // would leave loopback SSRF open to every internal service on the box.
        return env.nodeEnv !== 'production'
          && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      } catch {
        return false;
      }
    }

    const bucket = env.storage?.s3?.bucket;
    // S3 mode with no bucket configured is a misconfiguration — allow nothing.
    if (!bucket) return false;

    // Path-style S3 URL: s3.region.amazonaws.com/bucket/key
    const pathStyle = parsed.hostname.endsWith('.amazonaws.com') && parsed.pathname.startsWith(`/${bucket}/`);
    // Virtual-hosted S3 URL: bucket.s3.region.amazonaws.com/key
    const virtualHosted = parsed.hostname === `${bucket}.s3.${env.storage.s3.region}.amazonaws.com`;

    return pathStyle || virtualHosted;
  } catch {
    return false;
  }
}

class InventoryController {
  async list(req, res, next) {
    try {
      // Drop any client-supplied store filter, then re-derive it from the user.
      const { store_id: _ignored, store_ids: _ignored2, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      const items = await inventoryService.list(filters);
      res.json({ success: true, data: items });
    } catch (error) { next(error); }
  }

  async summary(req, res, next) {
    try {
      const { store_id: _ignored, store_ids: _ignored2, ...rest } = req.query;
      const filters = { ...rest, ...resolveStoreScope(req.user, req.query) };
      const data = await inventoryService.summary(filters);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  }

  async manualEntry(req, res, next) {
    try {
      if (!userHasStoreAccess(req.user, req.body.store_id)) {
        throw new AppError('Access denied: you are not assigned to this store', 403);
      }
      const result = await inventoryService.manualEntry(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) { next(error); }
  }

  async exportImageProxy(req, res, next) {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'Missing image url' });
      }

      if (!isAllowedExportImageUrl(url)) {
        throw new AppError('Image URL is not allowed for export', 400);
      }

      // Bounded fetch: abort rather than hang a connection (and a socket) indefinitely.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(url, { signal: controller.signal, redirect: 'error' });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return res.status(404).json({ success: false, message: 'Image not found' });
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('image/')) {
        return res.status(400).json({ success: false, message: 'Invalid image content' });
      }

      // Reject oversized images up front when the origin declares a length.
      const declaredLength = parseInt(response.headers.get('content-length') || '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_IMAGE_BYTES) {
        return res.status(413).json({ success: false, message: 'Image too large to export' });
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=300');

      // Stream through instead of buffering the whole file, and stop if an origin
      // that lied about (or omitted) Content-Length exceeds the cap mid-flight.
      let forwarded = 0;
      for await (const chunk of response.body) {
        forwarded += chunk.length;
        if (forwarded > MAX_PROXY_IMAGE_BYTES) {
          res.destroy();
          return;
        }
        if (!res.write(chunk)) {
          // Respect backpressure so a slow client cannot balloon the send buffer.
          // Resolve on close/error too: if the client disconnects mid-transfer,
          // 'drain' never fires and the handler would hang forever holding the
          // upstream connection open.
          const drained = await new Promise((resolve) => {
            const finish = (ok) => {
              res.off('drain', onDrain);
              res.off('close', onAbort);
              res.off('error', onAbort);
              resolve(ok);
            };
            const onDrain = () => finish(true);
            const onAbort = () => finish(false);
            res.once('drain', onDrain);
            res.once('close', onAbort);
            res.once('error', onAbort);
          });
          if (!drained) return;
        }
      }
      return res.end();
    } catch (error) {
      // Once the body has started, the status line and headers are already on the
      // wire — writing an error response would throw ERR_HTTP_HEADERS_SENT and mask
      // the real fault. Abort the connection instead so the client sees a truncated
      // transfer rather than a bogus 200 with JSON appended.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error?.name === 'AbortError') {
        return res.status(504).json({ success: false, message: 'Image fetch timed out' });
      }
      return next(error);
    }
  }

  async markDamaged(req, res, next) {
    try {
      // Verify item is in user's store
      const item = await db('inventory_items').where('id', req.params.id).first();
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
      if (!userHasStoreAccess(req.user, item.store_id)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const result = await inventoryService.markDamaged(req.params.id, req.body.notes);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  }
}

module.exports = new InventoryController();
