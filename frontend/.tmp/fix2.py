import io

# --- SW: cross-origin S3 images come back opaque, so res.ok is false and nothing cached ---
p = 'public/sw.js'
s = io.open(p, encoding='utf-8').read()
old = """        try {
          const res = await fetch(e.request);
          if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
            await cache.put(e.request, res.clone());
            // Fire-and-forget so trimming never delays the response.
            trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
          }
          return res;
        } catch {
          return new Response('', { status: 503 });
        }"""
new = """        try {
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
        }"""
assert old in s
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('sw.js: opaque cross-origin image responses are cached')

# --- Error boundary must reset when the route changes ---
p2 = 'src/App.jsx'
s2 = io.open(p2, encoding='utf-8').read()
s2 = s2.replace(
    "import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';",
    "import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';")
old2 = """function AppRoutes() {
  return (
    // Suspense handles the loading state for the lazy route chunks above; the error
    // boundary handles the failure case, which Suspense does not cover — a chunk that
    // 404s after a deploy would otherwise unmount the app to a blank page.
    <RouteErrorBoundary>"""
new2 = """function AppRoutes() {
  const location = useLocation();
  return (
    // Suspense handles the loading state for the lazy route chunks above; the error
    // boundary handles the failure case, which Suspense does not cover — a chunk that
    // 404s after a deploy would otherwise unmount the app to a blank page.
    //
    // Keyed on pathname so navigating away remounts it: without the key one page's
    // render error would latch and blank the whole app until a manual reload.
    <RouteErrorBoundary key={location.pathname}>"""
assert old2 in s2
s2 = s2.replace(old2, new2)
io.open(p2, 'w', encoding='utf-8', newline='\n').write(s2)
print('App.jsx: error boundary resets on navigation')
