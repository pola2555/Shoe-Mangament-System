const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');

/**
 * File upload middleware using Multer.
 * 
 * In local mode: saves to /uploads/{subfolder}/
 * In S3 mode (future): will use multer-s3 adapter.
 * 
 * File naming: UUID + original extension to prevent collisions.
 * Only image files are accepted (jpg, jpeg, png, webp, gif).
 */

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function createStorage(subfolder) {
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

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}`), false);
  }
}

/**
 * Create an upload middleware for a specific subfolder.
 * 
 * Usage:
 *   const upload = createUpload('products');
 *   router.post('/images', upload.single('image'), controller.uploadImage);
 *   router.post('/images', upload.array('images', 5), controller.uploadImages);
 *
 * @param {string} subfolder - Subfolder within uploads directory
 */
function createUpload(subfolder) {
  return multer({
    storage: createStorage(subfolder),
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE },
  });
}

/**
 * Get the public URL path for an uploaded file.
 * In local mode: /uploads/subfolder/filename
 * In S3 mode (future): full S3 URL
 *
 * @param {string} subfolder
 * @param {string} filename
 */
function getFileUrl(subfolder, filename) {
  if (env.storage.type === 'local') {
    return `/${env.storage.uploadDir}/${subfolder}/${filename}`;
  }
  // Future S3 implementation
  return `https://${env.storage.s3.bucket}.s3.${env.storage.s3.region}.amazonaws.com/${subfolder}/${filename}`;
}

module.exports = { createUpload, getFileUrl };
