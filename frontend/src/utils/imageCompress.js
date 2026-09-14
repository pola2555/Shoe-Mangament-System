/**
 * Compress an image in the browser before uploading it.
 *
 * Phone photos are large; downscaling to a sane longest edge and re-encoding as JPEG
 * makes the upload small and fast. But mobile Safari's canvas is fragile — a big image
 * can draw BLANK (an all-white canvas), and encoding that would upload a blank photo.
 *
 * So this is defensive on both ends:
 *   - decode with a plain <img> first (the most reliable path on iOS), then
 *     createImageBitmap as a fallback;
 *   - after drawing, VERIFY the canvas actually has content (not a uniform blank);
 *   - on any doubt — decode failure, blank draw, empty encode — return the ORIGINAL
 *     file untouched. The server re-encodes and downscales every upload anyway (and
 *     converts HEIC → JPEG), so a fallback still ends up compressed and correct.
 *
 * Dependency-free. Never throws.
 */

const DEFAULTS = {
  maxDimension: 2000,               // longest edge, px
  maxBytes: 1.5 * 1024 * 1024,      // aim under ~1.5 MB
  mimeType: 'image/jpeg',
  quality: 0.85,
  minQuality: 0.4,
  minValidBytes: 1024,              // smaller than this = a failed encode
};

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
      else resolve(null);
    } catch { resolve(null); }
  });
}

function decodeWithImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) { URL.revokeObjectURL(url); reject(new Error('empty')); return; }
      resolve({ source: img, width: w, height: h, cleanup: () => URL.revokeObjectURL(url) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img-decode-failed')); };
    img.src = url;
  });
}

async function decodeWithBitmap(file) {
  if (typeof createImageBitmap !== 'function') throw new Error('no-createImageBitmap');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  return { source: bmp, width: bmp.width, height: bmp.height, cleanup: () => bmp.close?.() };
}

async function decode(file) {
  try { return await decodeWithImg(file); } catch { /* try next */ }
  try { return await decodeWithBitmap(file); } catch { /* give up */ }
  return null;
}

/**
 * True if the drawn canvas has real content. A blank/failed draw is EXACTLY uniform
 * across every sampled pixel; a real photo — even a white-background product shot —
 * always carries some pixel-to-pixel variation. So "every sample identical" ⇒ blank.
 * If the pixels can't be read at all, treat it as blank (fall back to the original).
 */
function canvasHasContent(ctx, w, h) {
  try {
    const rows = [Math.floor(h * 0.25), Math.floor(h * 0.5), Math.floor(h * 0.75)];
    let ref = null;
    for (const y of rows) {
      const data = ctx.getImageData(0, y, w, 1).data;
      for (let i = 0; i < data.length; i += 4 * 8) { // every 8th pixel
        const px = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
        if (ref === null) ref = px;
        else if (px !== ref) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function doCompress(file, opts) {
  const o = { ...DEFAULTS, ...opts };

  // Re-encoding a GIF drops its animation; SVG is vector. Leave both untouched.
  if (!file.type || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (typeof document === 'undefined') return file;

  const decoded = await decode(file);
  if (!decoded) return file; // couldn't decode here → let the server handle the original

  const { source, width, height, cleanup } = decoded;
  const scale = Math.min(1, o.maxDimension / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) { cleanup(); return file; }

  ctx.fillStyle = '#ffffff';           // flatten any transparency to white for JPEG
  ctx.fillRect(0, 0, w, h);
  try { ctx.drawImage(source, 0, 0, w, h); } catch { cleanup(); return file; }
  cleanup();

  // The important guard: if the draw came out blank, DON'T upload a blank photo.
  if (!canvasHasContent(ctx, w, h)) return file;

  let q = o.quality;
  let blob = await canvasToBlob(canvas, o.mimeType, q);
  while (blob && blob.size > o.maxBytes && q > o.minQuality) {
    q = Math.max(o.minQuality, q - 0.15);
    blob = await canvasToBlob(canvas, o.mimeType, q);
  }

  if (!blob || blob.size < o.minValidBytes) return file;      // failed/empty encode
  if (blob.size >= file.size && scale === 1) return file;     // already small enough

  const name = (file.name || 'image').replace(/\.[^./\\]+$/, '') + '.jpg';
  return new File([blob], name, { type: o.mimeType, lastModified: Date.now() });
}

export async function compressImage(file, opts = {}) {
  try {
    return await doCompress(file, opts);
  } catch {
    return file; // never block an upload because compression failed
  }
}
