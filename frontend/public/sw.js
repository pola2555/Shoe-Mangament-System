const CACHE_NAME = 'pt-erp-v3';
const IMAGE_CACHE = 'shoe-erp-images-v1';
const PRECACHE = ['/', '/index.html'];

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

  const url = new URL(e.request.url);

  // Cache-first for uploaded images (they never change once uploaded)
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        try {
          const res = await fetch(e.request);
          if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
            cache.put(e.request, res.clone());
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
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
