const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const env = require('../config/env');

/**
 * Thumbnail generation.
 *
 * Uploads are stored as untouched originals — up to 10 MB — and every list view then
 * renders one into a 44px box. A single inventory page could pull tens of megabytes to
 * display thumbnails.
 *
 * On upload we derive a small WebP alongside the original. The thumbnail key is derived
 * from the original by convention (`<dir>/thumbs/<name>.webp`) so it needs no schema
 * change to locate; the thumb_url column added later just saves recomputing it.
 */

const THUMB_WIDTH = 300;
const THUMB_QUALITY = 78;
const THUMB_DIR = 'thumbs';

/**
 * Convention: uploads/products/abc.jpg -> uploads/products/thumbs/abc.webp
 * Kept in one place so the generator, the URL builder and the backfill agree.
 */
function thumbKeyFor(key) {
  const dir = path.posix.dirname(key);
  const base = path.posix.basename(key, path.posix.extname(key));
  return path.posix.join(dir === '.' ? '' : dir, THUMB_DIR, `${base}.webp`);
}

/**
 * Derive the public thumbnail URL from a stored image URL.
 * Returns null when the input is falsy, so callers can fall back to the original.
 */
function thumbUrlFor(imageUrl) {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      const url = new URL(imageUrl);
      url.pathname = `/${thumbKeyFor(url.pathname.replace(/^\//, ''))}`;
      return url.toString();
    }
    // Relative local path, e.g. /uploads/products/abc.jpg
    return `/${thumbKeyFor(imageUrl.replace(/^\//, ''))}`;
  } catch {
    return null;
  }
}

/**
 * Resize a buffer to a thumbnail.
 * `withoutEnlargement` keeps small images from being upscaled into a larger file.
 */
async function makeThumbnailBuffer(input) {
  return sharp(input, { failOn: 'none' })
    .rotate() // honour EXIF orientation, which resizing would otherwise discard
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

// --- S3 ---

async function uploadThumbToS3(key, buffer) {
  const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: env.storage.s3.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.storage.s3.accessKeyId,
      secretAccessKey: env.storage.s3.secretAccessKey,
    },
  });
  await client.send(new PutObjectCommand({
    Bucket: env.storage.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: 'image/webp',
    ServerSideEncryption: 'AES256',
    // Immutable content addressed by UUID — cache hard.
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

async function fetchS3Object(key) {
  const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: env.storage.s3.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.storage.s3.accessKeyId,
      secretAccessKey: env.storage.s3.secretAccessKey,
    },
  });
  const res = await client.send(new GetObjectCommand({
    Bucket: env.storage.s3.bucket,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Generate and store a thumbnail for a freshly uploaded multer file.
 *
 * Best-effort: a thumbnail failure must never fail the upload itself, since the
 * original is already stored and the UI falls back to it.
 *
 * @param {string} subfolder
 * @param {object} file - req.file from multer (disk or multer-s3)
 * @returns {Promise<string|null>} public thumbnail URL, or null if generation failed
 */
async function generateThumbnail(subfolder, file) {
  try {
    if (env.storage.type === 's3') {
      if (!file.key) return null;
      const source = await fetchS3Object(file.key);
      const thumbKey = thumbKeyFor(file.key);
      await uploadThumbToS3(thumbKey, await makeThumbnailBuffer(source));
      return `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${thumbKey}`;
    }

    // Local disk
    if (!file.path) return null;
    const relative = path.posix.join(env.storage.uploadDir, subfolder, file.filename);
    const thumbRelative = thumbKeyFor(relative);
    const thumbAbsolute = path.join(process.cwd(), thumbRelative);
    fs.mkdirSync(path.dirname(thumbAbsolute), { recursive: true });
    await sharp(file.path, { failOn: 'none' })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toFile(thumbAbsolute);
    return `/${thumbRelative}`;
  } catch (error) {
    console.error('[thumbnails] generation failed:', error.message);
    return null;
  }
}

/**
 * Remove a thumbnail when its original is deleted, so orphans don't accumulate.
 */
async function deleteThumbnail(imageUrl) {
  const thumbUrl = thumbUrlFor(imageUrl);
  if (!thumbUrl) return;
  try {
    const { deleteFile } = require('../middleware/upload');
    await deleteFile(thumbUrl);
  } catch { /* best effort — the original is what matters */ }
}

module.exports = {
  THUMB_WIDTH,
  thumbKeyFor,
  thumbUrlFor,
  makeThumbnailBuffer,
  generateThumbnail,
  deleteThumbnail,
};
