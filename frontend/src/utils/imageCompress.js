/**
 * Compress an image in the browser before uploading it.
 *
 * Phone photos are often 5–12 MB, which either bounce off the size limit or crawl over
 * a shop connection. We downscale to a sane longest edge and re-encode as JPEG so a
 * catalogue photo lands at a few hundred KB.
 *
 * Dependency-free (canvas). Two decoders are tried — createImageBitmap first, then an
 * <img> element — because on some phones/formats one works and the other doesn't. If
 * NOTHING here can decode or encode the file cleanly, the ORIGINAL is returned unchanged
 * and the server sorts it out (it re-encodes and, for an iPhone HEIC, converts to JPEG).
 * So this step only ever helps; it never hands the server broken bytes of its own making.
 */

const DEFAULTS = {
  maxDimension: 2000,               // longest edge, px
  maxBytes: 1.5 * 1024 * 1024,      // aim under ~1.5 MB
  mimeType: 'image/jpeg',
  quality: 0.85,
  minQuality: 0.4,
  minValidBytes: 1024,              // anything smaller than this is a failed encode
};

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
      else resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function decodeWithBitmap(file) {
  if (typeof createImageBitmap !== 'function') return Promise.reject(new Error('no-createImageBitmap'));
  // `from-image` applies EXIF orientation; some engines reject the options bag, so retry without.
  return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
}

function decodeWithImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img-decode-failed')); };
    img.src = url;
  });
}

async function doCompress(file, opts) {
  const o = { ...DEFAULTS, ...opts };

  // Re-encoding a GIF would drop its animation, and SVG is vector — leave both alone.
  if (!file.type || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (typeof document === 'undefined') return file;

  let source;
  let revoke = null;
  let width;
  let height;
  try {
    source = await decodeWithBitmap(file);
    width = source.width; height = source.height;
  } catch {
    try {
      const r = await decodeWithImg(file);
      source = r.img; revoke = r.revoke;
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    } catch {
      return file; // undecodable here → hand the original to the server
    }
  }

  const done = (result) => { revoke?.(); source.close?.(); return result; };
  if (!width || !height) return done(file);

  const scale = Math.min(1, o.maxDimension / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return done(file);
  // JPEG has no alpha; without this, transparent PNG areas composite to black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  done(null); // release the decoded source now that it's drawn

  let q = o.quality;
  let blob = await canvasToBlob(canvas, o.mimeType, q);
  while (blob && blob.size > o.maxBytes && q > o.minQuality) {
    q = Math.max(o.minQuality, q - 0.15);
    blob = await canvasToBlob(canvas, o.mimeType, q);
  }

  // A failed/empty encode (some mobile canvases return null or a stub) → keep the original.
  if (!blob || blob.size < o.minValidBytes) return file;
  // An already-small image that wasn't downscaled can come out larger — keep the original.
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
