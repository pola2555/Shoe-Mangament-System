const CACHE_NAME = 'pt-erp-v3';
const IMAGE_CACHE = 'shoe-erp-images-v1';
const PRECACHE = ['/', '/index.html'];

// Both caches were unbounded: images accumulated forever, and the network-first
// branch stored every asset (including each build's hashed bundles) permanently.
const MAX_IMAGE_ENTRIES = 300;
const MAX_ASSET_ENTRIES = 100;

/**
 * Trim a cache to a maximum entry count, evicting oldest-first.
 * Cache.keys() returns insertion order, so the head is the oldest entry.
 */
async function trimCache(cacheName, maxEntries, protectedPaths = []) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  // Never evict the precached app shell — losing it breaks the offline fallback,
  // which is the one thing the cache exists to guarantee.
  const evictable = keys.filter((key) => {
    const { pathname } = new URL(key.url);
    return !protectedPaths.includes(pathname);
  });

  const excess = keys.length - maxEntries;
  await Promise.all(evictable.slice(0, excess).map((key) => cache.delete(key)));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  const keepCaches = [CACHE_NAME, IMAGE_CACHE];
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => !keepCaches.includes(n)).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Skip API calls
  if (e.request.url.includes('/api/')) return;

  // Only GET is cacheable; cache.put() throws on any other method.
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Cache-first for uploaded images (they never change once uploaded).
  // Covers both local /uploads/ and the S3 bucket, which is where images actually
  // come from now that STORAGE_TYPE=s3 — the /uploads/ test alone matched nothing.
  const isImageRequest =
    url.pathname.startsWith('/uploads/') ||
    e.request.destination === 'image';

  if (isImageRequest) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        try {
          const res = await fetch(e.request);
          // Images now come from S3, i.e. cross-origin. A no-cors request yields an
          // opaque response: status 0, res.ok false, no readable headers. Testing
          // res.ok && content-type therefore cached nothing at all. Opaque responses
          // are still cacheable and replay fine into an <img>.
          const isOpaque = res.type === 'opaque';
          const isImage = res.ok && res.headers.get('content-type')?.startsWith('image/');
          if (isOpaque || isImage) {
            await cache.put(e.request, res.clone());
            // Fire-and-forget so trimming never delays the response.
            trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
          }
          return res;
        } catch {
          return new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  // Network-first for all other assets
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(async (cache) => {
          await cache.put(e.request, clone);
          trimCache(CACHE_NAME, MAX_ASSET_ENTRIES, PRECACHE);
        });
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => {
        if (r) return r;
        // Only fall back to the app shell for page navigations. Answering a failed
        // script/style request with HTML makes a stale-chunk failure worse: the
        // browser gets a MIME-type error instead of a clean network error the app's
        // error boundary can recognise and offer a reload for.
        if (e.request.mode === 'navigate') return caches.match('/');
        return Response.error();
      }))
  );
});
