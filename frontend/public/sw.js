const CACHE_NAME = 'pt-erp-v3';
const IMAGE_CACHE = 'shoe-erp-images-v2';
// A tiny companion cache holding one timestamp per image, so an opaque cross-origin
// response (which exposes no readable Date header) can still be aged. Same-origin
// synthetic Responses, so their headers ARE readable.
const IMAGE_META = 'shoe-erp-image-meta-v1';
const PRECACHE = ['/', '/index.html'];

// Both real caches are bounded: images accumulated forever, and the network-first
// branch stored every asset (including each build's hashed bundles) permanently.
const MAX_IMAGE_ENTRIES = 500;
const MAX_ASSET_ENTRIES = 100;

// How long a cached image is served without even trying the network. Product photos
// change rarely, so a day of pure cache is the right trade: after that the image is
// STILL served instantly, and a fresh copy is fetched in the background for next time
// (stale-while-revalidate). So the network is touched at most once per image per day,
// never on the path the user waits on.
const IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  const removed = evictable.slice(0, excess);
  await Promise.all(removed.map((key) => cache.delete(key)));
  return removed;
}

/** Remember when an image was stored, so it can be aged later. */
async function stampImage(url) {
  const meta = await caches.open(IMAGE_META);
  await meta.put(new Request(metaKey(url)), new Response(String(Date.now())));
}

async function imageAge(url) {
  const meta = await caches.open(IMAGE_META);
  const hit = await meta.match(new Request(metaKey(url)));
  if (!hit) return Infinity; // no stamp → treat as stale, so it revalidates once
  const t = Number(await hit.text());
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

// A same-origin key so the meta Response is readable; the real image URL is opaque.
function metaKey(url) {
  return `${self.registration.scope}__imgmeta__?u=${encodeURIComponent(url)}`;
}

/** Fetch an image and store it (plus its timestamp), trimming both caches together. */
async function storeImage(request) {
  const res = await fetch(request);
  // Images come from S3, i.e. cross-origin no-cors → an opaque response: status 0,
  // res.ok false, no readable headers. Opaque responses are still cacheable and replay
  // fine into an <img>, so cache them; a genuine same-origin image is cached on ok.
  const isOpaque = res.type === 'opaque';
  const isImage = res.ok && res.headers.get('content-type')?.startsWith('image/');
  if (isOpaque || isImage) {
    const cache = await caches.open(IMAGE_CACHE);
    await cache.put(request, res.clone());
    await stampImage(request.url);
    // Fire-and-forget so trimming never delays the response, and keep the meta cache in
    // step so it cannot grow without bound behind the image cache.
    trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES).then((removed) => {
      if (removed?.length) {
        caches.open(IMAGE_META).then((meta) =>
          Promise.all(removed.map((k) => meta.delete(new Request(metaKey(k.url))))));
      }
    });
  }
  return res;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  const keepCaches = [CACHE_NAME, IMAGE_CACHE, IMAGE_META];
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

  // Cache-first (stale-while-revalidate) for uploaded images. Covers both local
  // /uploads/ and the S3 bucket, which is where images actually come from now that
  // STORAGE_TYPE=s3 — the /uploads/ test alone matched nothing.
  const isImageRequest =
    url.pathname.startsWith('/uploads/') ||
    e.request.destination === 'image';

  if (isImageRequest) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) {
          // Serve the cached copy immediately — always. If it is older than a day,
          // refresh it in the background so the NEXT load is current, without ever
          // making this load wait on the network. This is the whole point: product
          // images rarely change, so the user should almost never pay for one.
          const age = await imageAge(e.request.url);
          if (age > IMAGE_MAX_AGE_MS) {
            e.waitUntil(storeImage(e.request).catch(() => {}));
          }
          return cached;
        }
        try {
          return await storeImage(e.request);
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
