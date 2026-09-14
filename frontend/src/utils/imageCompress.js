/**
 * Compress an image in the browser before uploading it.
 *
 * Phone photos are often 5–12 MB, which either bounce off the 10 MB server limit or
 * crawl over a shop connection (and a slow upload is what got cut off mid-flight).
 * We downscale to a sane longest edge and re-encode as JPEG, stepping quality down
 * until the result fits comfortably — so a catalogue photo lands at a few hundred KB
 * instead of many MB, and never hits the size cap.
 *
 * Dependency-free (canvas + createImageBitmap). Always resolves: on anything it can't
 * handle it returns the ORIGINAL file, so the upload still goes ahead and the server
 * validates it as before.
 */

const DEFAULTS = {
  maxDimension: 2000,               // longest edge, px — plenty for the zoom viewer
  maxBytes: 1.5 * 1024 * 1024,      // aim under ~1.5 MB
  mimeType: 'image/jpeg',
  quality: 0.85,
  minQuality: 0.4,
};

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

async function doCompress(file, opts) {
  const o = { ...DEFAULTS, ...opts };

  // Only re-encode raster photos. GIF (animation) and SVG must pass through untouched.
  if (!file.type || !file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return file;
  }
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return file;
  }

  // `from-image` bakes in EXIF orientation, so a portrait phone photo isn't uploaded
  // sideways once the canvas strips its metadata.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = bitmap;
  if (!width || !height) { bitmap.close?.(); return file; }

  const scale = Math.min(1, o.maxDimension / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close?.(); return file; }
  // JPEG has no alpha; without this, transparent PNG areas composite to black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let q = o.quality;
  let blob = await canvasToBlob(canvas, o.mimeType, q);
  while (blob && blob.size > o.maxBytes && q > o.minQuality) {
    q = Math.max(o.minQuality, q - 0.15);
    blob = await canvasToBlob(canvas, o.mimeType, q);
  }
  if (!blob) return file;

  // A small, already-optimised image that wasn't resized can come out larger than it
  // went in — keep the original in that case.
  if (blob.size >= file.size && scale === 1) return file;

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
