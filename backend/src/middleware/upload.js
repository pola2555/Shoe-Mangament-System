const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');

/**
 * File upload middleware using Multer.
 * 
 * In local mode: saves to /uploads/{subfolder}/
 * In S3 mode: uses multer-s3 to upload directly to AWS S3.
 * 
 * File naming: UUID + original extension to prevent collisions.
 * Only image files are accepted (jpg, jpeg, png, webp, gif).
 */

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

function createLocalStorage(subfolder) {
  const uploadPath = path.join(process.cwd(), env.storage.uploadDir, subfolder);
  
  // Ensure directory exists
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${uuidv4()}${ext}`;
      cb(null, name);
    },
  });
}

function createS3Storage(subfolder) {
  const multerS3 = require('multer-s3');
  return multerS3({
    s3: getS3Client(),
    bucket: env.storage.s3.bucket,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    serverSideEncryption: 'AES256',
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${subfolder}/${uuidv4()}${ext}`;
      cb(null, name);
    },
  });
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_TYPES.includes(file.mimetype) && ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
}

/**
 * Create an upload middleware for a specific subfolder.
 * Automatically picks local disk or S3 based on STORAGE_TYPE env.
 *
 * @param {string} subfolder - Subfolder / S3 key prefix (e.g. 'products', 'payments')
 */
function createUpload(subfolder) {
  const storage = env.storage.type === 's3'
    ? createS3Storage(subfolder)
    : createLocalStorage(subfolder);

  return multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE },
  });
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

/**
 * Get the URL for a just-uploaded file from req.file.
 * Works for both local (disk) and S3 (multer-s3) storage.
 *
 * @param {string} subfolder - Only needed for local mode
 * @param {object} file - The req.file object from multer
 */
function getUploadedUrl(subfolder, file) {
  // multer-s3 sets .location — but with forcePathStyle it's already path-style
  // Reconstruct to ensure consistent format
  if (file.key) {
    return `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${file.key}`;
  }
  // Local disk: construct from subfolder + filename
  return `/${env.storage.uploadDir}/${subfolder}/${file.filename}`;
}
