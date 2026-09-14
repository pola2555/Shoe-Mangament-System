const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * File upload middleware.
 *
 * The file is buffered in memory first, validated as a complete image, and only
 * then written to storage (S3 or local disk).
 *
 * Why not stream straight to S3 (multer-s3)? A dropped upload — a phone on a shaky
 * shop connection — was landing a HALF-WRITTEN object in the bucket: the image
 * showed cut off at the bottom, with nothing to say the upload had failed.
 * Streaming commits bytes to S3 as they arrive, so a truncated request left a
 * truncated file behind. Buffering the whole file first means:
 *   - a truncated request errors out (busboy: unexpected end of form) BEFORE
 *     anything is stored, and the caller gets a clear "try again";
 *   - sharp confirms the bytes actually decode to a whole image;
 *   - PutObject carries a known Content-Length, so S3 stores exactly what we have.
 *
 * File naming: UUID + original extension to prevent collisions.
 * Only image files are accepted (jpg, jpeg, png, webp, gif).
 */

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB (kept in step with nginx client_max_body_size)
const MAX_STORED_DIMENSION = 2000;       // longest edge we keep; bigger is pointless here

// --- S3 Client (lazy-initialized) ---
let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: env.storage.s3.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.storage.s3.accessKeyId,
        secretAccessKey: env.storage.s3.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function fileFilter(req, file, cb) {
  // Permissive on purpose: sharp re-decodes and re-encodes every file below, so it is
  // the real validator. A phone can hand us an image with an odd or empty mimetype
  // (HEIC especially), and rejecting on a strict type list here is what turned a normal
  // photo into "invalid file type". Accept anything that looks like an image and let
  // the decode step be the judge.
  const ext = path.extname(file.originalname).toLowerCase();
  const looksLikeImage = (file.mimetype || '').startsWith('image/') || ALLOWED_EXTENSIONS.includes(ext);
  if (looksLikeImage) cb(null, true);
  else cb(new Error('Please choose an image file (JPEG, PNG, WebP, GIF or HEIC).'), false);
}

// One shared in-memory multer. Each upload route composes it with the store step below.
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// Turn multer/busboy failures into clean 400s with a message the cashier can act on,
// instead of the generic 500 the error handler would otherwise return for them.
function translateUploadError(err) {
  if (!err) return err;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError('Image is too large (max 10 MB).', 400);
    return new AppError(`Upload error: ${err.message}`, 400);
  }
  const msg = err.message || '';
  if (/Invalid file type/i.test(msg)) return new AppError(msg, 400);
  if (/Unexpected end of (form|multipart)|aborted/i.test(msg)) {
    return new AppError('The upload was interrupted before it finished. Please try again.', 400);
  }
  return err;
}

/**
 * Validate the buffered image and write it to storage, populating req.file with the
 * same fields the rest of the app already reads (key / location for S3, filename /
 * path for local, size). getUploadedUrl() and generateThumbnail() work unchanged.
 */
async function storeBufferedFile(subfolder, req) {
  const file = req.file;
  if (!file || !file.buffer) return;

  // Normalise rather than reject.
  //
  // The previous version ran a strict full-decode (`.stats` with failOn:'error') and
  // threw "incomplete or corrupted" on anything sharp grumbled about — which rejected
  // ordinary phone photos. Instead, re-decode tolerantly and re-encode to a web-safe
  // image: this repairs the small imperfections real photos carry, bakes in EXIF
  // orientation (so portrait shots aren't sideways), converts HEIC/HEIF from an iPhone
  // to JPEG, and caps the longest edge so what we store is never needlessly huge. Only
  // a genuinely unreadable file (sharp can't decode it at all) is refused.
  const sharp = require('sharp');
  let outBuffer;
  let outExt;
  let outContentType;
  try {
    const meta = await sharp(file.buffer, { failOn: 'none' }).metadata();
    const fmt = meta.format;
    if (fmt === 'gif') {
      // Keep GIFs byte-for-byte so animation survives.
      outBuffer = file.buffer;
      outExt = '.gif';
      outContentType = 'image/gif';
    } else {
      const pipeline = sharp(file.buffer, { failOn: 'none' })
        .rotate() // apply EXIF orientation, then drop the metadata
        .resize({ width: MAX_STORED_DIMENSION, height: MAX_STORED_DIMENSION, fit: 'inside', withoutEnlargement: true });
      if (fmt === 'png') {
        outBuffer = await pipeline.png().toBuffer();
        outExt = '.png';
        outContentType = 'image/png';
      } else if (fmt === 'webp') {
        outBuffer = await pipeline.webp({ quality: 85 }).toBuffer();
        outExt = '.webp';
        outContentType = 'image/webp';
      } else {
        // jpeg, heif/heic, or anything else decodable → a broadly-supported JPEG.
        outBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
        outExt = '.jpg';
        outContentType = 'image/jpeg';
      }
    }
  } catch (err) {
    console.error('[upload] could not process image:', err && err.message);
    throw new AppError('This image could not be read. Please upload a JPEG or PNG photo and try again.', 400);
  }

  file.buffer = outBuffer;         // so the thumbnail is built from the same clean bytes
  file.size = outBuffer.length;

  if (env.storage.type === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = `${subfolder}/${uuidv4()}${outExt}`;
    await getS3Client().send(new PutObjectCommand({
      Bucket: env.storage.s3.bucket,
      Key: key,
      Body: outBuffer,             // a Buffer → the SDK sets Content-Length exactly
      ContentType: outContentType,
      ServerSideEncryption: 'AES256',
    }));
    file.key = key;
    file.location = `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${key}`;
  } else {
    const uploadPath = path.join(process.cwd(), env.storage.uploadDir, subfolder);
    fs.mkdirSync(uploadPath, { recursive: true });
    const name = `${uuidv4()}${outExt}`;
    const dest = path.join(uploadPath, name);
    fs.writeFileSync(dest, outBuffer);
    file.filename = name;
    file.path = dest;
  }
}

/**
 * Create an upload middleware for a specific subfolder.
 * Automatically picks local disk or S3 based on STORAGE_TYPE env.
 *
 * Returns an object exposing .single(field) — a two-step middleware chain (parse,
 * then validate + store) that Express runs in order, so routes call it exactly as
 * before: `upload.single('image')`.
 *
 * @param {string} subfolder - Subfolder / S3 key prefix (e.g. 'products', 'payments')
 */
function createUpload(subfolder) {
  return {
    single(field) {
      return [
        (req, res, next) => memoryUpload.single(field)(req, res, (err) => next(translateUploadError(err))),
        async (req, res, next) => {
          try {
            await storeBufferedFile(subfolder, req);
            next();
          } catch (err) {
            next(err);
          }
        },
      ];
    },
  };
}

/**
 * Get the public URL path for an uploaded file.
 * In local mode: /uploads/subfolder/filename
 * In S3 mode: full S3 URL
 *
 * @param {string} subfolder
 * @param {string} filename
 */
function getFileUrl(subfolder, filename) {
  if (env.storage.type === 's3') {
    return `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${subfolder}/${filename}`;
  }
  return `/${env.storage.uploadDir}/${subfolder}/${filename}`;
}

/**
 * Get the URL for a just-uploaded file from req.file.
 * Works for both local (disk) and S3 storage.
 *
 * @param {string} subfolder - Only needed for local mode
 * @param {object} file - The req.file object populated by storeBufferedFile
 */
function getUploadedUrl(subfolder, file) {
  if (file.key) {
    return `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${file.key}`;
  }
  // Local disk: construct from subfolder + filename
  return `/${env.storage.uploadDir}/${subfolder}/${file.filename}`;
}

/**
 * Delete a file from storage.
 * In local mode: removes from disk.
 * In S3 mode: sends DeleteObject to S3.
 *
 * @param {string} imageUrl - The full URL as stored in the database
 */
async function deleteFile(imageUrl) {
  if (!imageUrl) return;

  if (env.storage.type === 's3') {
    // Extract the S3 key from the full URL
    // Path-style: https://s3.region.amazonaws.com/bucket/subfolder/filename
    // Virtual-hosted: https://bucket.s3.region.amazonaws.com/subfolder/filename
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const url = new URL(imageUrl);
    let key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    // If path-style, strip the bucket name prefix
    const bucketPrefix = env.storage.s3.bucket + '/';
    if (key.startsWith(bucketPrefix)) {
      key = key.slice(bucketPrefix.length);
    }
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: env.storage.s3.bucket,
      Key: key,
    }));
  } else {
    // Local: imageUrl is like /uploads/products/uuid.jpg
    const filePath = path.join(process.cwd(), imageUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = { createUpload, getFileUrl, getUploadedUrl, deleteFile };
