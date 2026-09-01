#!/usr/bin/env node
/**
 * One-off backfill: generate thumbnails for images uploaded before thumbnail
 * generation existed, and populate their thumb_url columns.
 *
 * Safe to re-run — it only processes rows whose thumb_url is still NULL, and skips
 * any whose thumbnail object already exists in storage.
 *
 * Usage:
 *   node scripts/backfill-thumbnails.js            # process everything
 *   node scripts/backfill-thumbnails.js --limit 50 # process the first 50
 *   node scripts/backfill-thumbnails.js --dry-run  # report only, change nothing
 *
 * Run this AFTER migration 20260814_002 has added the thumb_url columns.
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

process.chdir(path.join(__dirname, '..'));

const db = require('../src/config/database');
const env = require('../src/config/env');
const { thumbKeyFor, makeThumbnailBuffer } = require('../src/utils/thumbnails');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : null;

// Modest concurrency: resizing is CPU-bound and this may run on the live server.
const CONCURRENCY = 3;

function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: env.storage.s3.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.storage.s3.accessKeyId,
      secretAccessKey: env.storage.s3.secretAccessKey,
    },
  });
}

/** Strip the public URL down to a storage key. */
function keyFromUrl(imageUrl) {
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    const url = new URL(imageUrl);
    let key = url.pathname.replace(/^\//, '');
    const bucketPrefix = `${env.storage.s3.bucket}/`;
    if (key.startsWith(bucketPrefix)) key = key.slice(bucketPrefix.length);
    return key;
  }
  return imageUrl.replace(/^\//, '');
}

async function processS3(imageUrl) {
  const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const client = s3Client();
  const key = keyFromUrl(imageUrl);
  const thumbKey = thumbKeyFor(key);
  const publicUrl = `https://s3.${env.storage.s3.region}.amazonaws.com/${env.storage.s3.bucket}/${thumbKey}`;

  // Already generated on a previous run — just record the URL.
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.storage.s3.bucket, Key: thumbKey }));
    return { thumbUrl: publicUrl, skipped: true };
  } catch { /* not present — generate it */ }

  if (dryRun) return { thumbUrl: publicUrl, dryRun: true };

  const res = await client.send(new GetObjectCommand({ Bucket: env.storage.s3.bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);

  await client.send(new PutObjectCommand({
    Bucket: env.storage.s3.bucket,
    Key: thumbKey,
    Body: await makeThumbnailBuffer(Buffer.concat(chunks)),
    ContentType: 'image/webp',
    ServerSideEncryption: 'AES256',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return { thumbUrl: publicUrl };
}

async function processLocal(imageUrl) {
  const relative = keyFromUrl(imageUrl);
  const source = path.join(process.cwd(), relative);
  if (!fs.existsSync(source)) throw new Error(`source missing: ${relative}`);

  const thumbRelative = thumbKeyFor(relative);
  const thumbAbsolute = path.join(process.cwd(), thumbRelative);
  const publicUrl = `/${thumbRelative}`;

  if (fs.existsSync(thumbAbsolute)) return { thumbUrl: publicUrl, skipped: true };
  if (dryRun) return { thumbUrl: publicUrl, dryRun: true };

  fs.mkdirSync(path.dirname(thumbAbsolute), { recursive: true });
  await sharp(source, { failOn: 'none' })
    .rotate()
    .resize({ width: 300, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbAbsolute);

  return { thumbUrl: publicUrl };
}

async function backfillTable(table) {
  let query = db(table).whereNull('thumb_url').whereNotNull('image_url').select('id', 'image_url');
  if (limit) query = query.limit(limit);
  const rows = await query;

  console.log(`\n${table}: ${rows.length} image(s) without a thumbnail`);
  if (rows.length === 0) return { done: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  let next = 0;

  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const result = env.storage.type === 's3'
          ? await processS3(row.image_url)
          : await processLocal(row.image_url);

        if (!dryRun) {
          await db(table).where('id', row.id).update({ thumb_url: result.thumbUrl });
        }
        done++;
        const tag = result.skipped ? 'exists' : (result.dryRun ? 'would create' : 'created');
        process.stdout.write(`  [${done + failed}/${rows.length}] ${tag}: ${result.thumbUrl}\n`);
      } catch (error) {
        failed++;
        console.error(`  [${done + failed}/${rows.length}] FAILED ${row.image_url}: ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return { done, failed };
}

(async () => {
  console.log(`Thumbnail backfill — storage=${env.storage.type}${dryRun ? ' (DRY RUN)' : ''}`);

  let totalDone = 0;
  let totalFailed = 0;

  for (const table of ['product_color_images', 'attached_images']) {
    const { done, failed } = await backfillTable(table);
    totalDone += done;
    totalFailed += failed;
  }

  console.log(`\nDone. ${totalDone} processed, ${totalFailed} failed.`);
  // Non-zero exit on failures so a deploy script can notice.
  await db.destroy();
  process.exit(totalFailed > 0 ? 1 : 0);
})().catch(async (error) => {
  console.error('Backfill aborted:', error);
  await db.destroy();
  process.exit(1);
});
