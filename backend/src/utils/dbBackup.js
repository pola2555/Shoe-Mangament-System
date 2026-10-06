const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../config/env');

/**
 * A nightly dump of the database, kept off this machine.
 *
 * The droplet is one 1-vCPU box with the database on the same disk as the app. A disk
 * failure, a bad migration or a mistaken DELETE currently costs everything, because the
 * only copies of the data that have ever existed were taken by hand before a deploy.
 * This takes one every night without being asked and puts it somewhere the droplet
 * cannot lose.
 *
 * FIVE DECISIONS WORTH KNOWING
 *
 * 1. OFF UNLESS TURNED ON. `BACKUP_ENABLED` must be `true`. Every developer machine
 *    runs this same code with `STORAGE_TYPE=s3` pointed at a real bucket, so a job
 *    that defaulted to on would have laptops writing dumps of their scratch databases
 *    into production storage.
 *
 * 2. ITS OWN BUCKET, NOT THE UPLOADS ONE. The uploads bucket is reachable from the
 *    browser — that is its whole purpose, it serves product photos into <img> tags. A
 *    database dump holds every customer's phone number, every price, and the password
 *    hash of every account. Those two things cannot share a bucket on the strength of
 *    a prefix, so the bucket must be named explicitly and is refused if it is the
 *    uploads one. `BACKUP_ALLOW_UPLOADS_BUCKET=true` overrides it for whoever is
 *    certain, because refusing outright would just mean no backups at all.
 *
 * 3. WHEN THE LAST ONE RAN IS READ FROM S3, NOT REMEMBERED. A plain 24-hour
 *    `setInterval` restarts its clock every time the app restarts, so a server that is
 *    redeployed each morning would never once reach the 24-hour mark. Instead the job
 *    wakes hourly, asks the bucket what the newest backup is, and acts on the answer.
 *    No state to keep in sync, and it is self-correcting: whatever the bucket holds IS
 *    the truth about what has been backed up.
 *
 * 4. STREAMED, NEVER BUFFERED. `pg_dump` writes to a temp file and that file is
 *    streamed up. Reading the dump into memory first would mean holding the entire
 *    database in RAM on a box with 1 GB of it, next to a Node process already using a
 *    fifth of that.
 *
 * 5. IT CAN NEVER TAKE THE SERVER DOWN. Every failure is caught and logged. A shop
 *    that cannot sell because a backup failed would be a far worse outage than the one
 *    this is insuring against.
 */

const HOUR_MS = 60 * 60 * 1000;

const config = {
  enabled: String(process.env.BACKUP_ENABLED || '').toLowerCase() === 'true',
  bucket: process.env.BACKUP_S3_BUCKET || '',
  prefix: (process.env.BACKUP_S3_PREFIX || 'db-backups').replace(/^\/+|\/+$/g, ''),
  intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 24,
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30,
  pgDump: process.env.PG_DUMP_PATH || 'pg_dump',
  allowUploadsBucket: String(process.env.BACKUP_ALLOW_UPLOADS_BUCKET || '').toLowerCase() === 'true',
};

/**
 * Why this job will not run, or null if it will.
 *
 * Returned as a sentence rather than a boolean so startup can say which of the several
 * reasons applies — "backups are off" and "backups are on but misconfigured" need very
 * different responses from whoever reads the log.
 */
function disabledReason() {
  if (!config.enabled) return 'BACKUP_ENABLED is not true';
  if (!config.bucket) return 'BACKUP_S3_BUCKET is not set';
  if (config.bucket === env.storage.s3.bucket && !config.allowUploadsBucket) {
    return `BACKUP_S3_BUCKET is the uploads bucket (${config.bucket}), which is served to browsers. `
      + 'Use a private bucket, or set BACKUP_ALLOW_UPLOADS_BUCKET=true if it is not public';
  }
  const missing = ['accessKeyId', 'secretAccessKey'].filter((k) => !env.storage.s3[k]);
  if (missing.length) return `AWS credentials missing: ${missing.join(', ')}`;
  return null;
}

let s3 = null;
function client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: env.storage.s3.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.storage.s3.accessKeyId,
        secretAccessKey: env.storage.s3.secretAccessKey,
      },
    });
  }
  return s3;
}

/**
 * Run pg_dump into `destFile`.
 *
 * The password goes through the environment, never the argument list: arguments are
 * world-readable in `ps` for the life of the process.
 *
 * Custom format (-Fc) rather than plain SQL — it is compressed, and `pg_restore` can
 * read a single table out of it, which is what you actually want at 3am when one table
 * was wrecked and the rest is fine.
 */
function runPgDump(destFile) {
  return new Promise((resolve, reject) => {
    const args = [
      '--host', String(env.db.host),
      '--port', String(env.db.port),
      '--username', String(env.db.user),
      '--dbname', String(env.db.name),
      '--format', 'custom',
      '--compress', '6',
      '--no-owner',
      '--no-privileges',
      '--file', destFile,
    ];

    const child = spawn(config.pgDump, args, {
      env: { ...process.env, PGPASSWORD: env.db.password || '' },
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? `pg_dump not found (looked for "${config.pgDump}"). Install postgresql-client or set PG_DUMP_PATH.`
        : e.message,
    )));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`pg_dump exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Objects under the backup prefix, newest first. */
async function listBackups() {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const out = [];
  let token;
  do {
    const res = await client().send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${config.prefix}/`,
      ContinuationToken: token,
    }));
    for (const o of res.Contents || []) out.push(o);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
}

/**
 * Delete anything past the retention window.
 *
 * The newest backup is kept no matter how old it is. A server that has been off for
 * two months would otherwise come back, find every copy expired, and delete the only
 * one it had before taking a new one — turning a retention policy into data loss.
 */
async function pruneOldBackups(existing) {
  const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const cutoff = Date.now() - config.retentionDays * 24 * HOUR_MS;
  const stale = existing.slice(1).filter((o) => new Date(o.LastModified).getTime() < cutoff);
  if (!stale.length) return 0;

  for (let i = 0; i < stale.length; i += 1000) {
    await client().send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: { Objects: stale.slice(i, i + 1000).map((o) => ({ Key: o.Key })) },
    }));
  }
  console.log(`[backup] pruned ${stale.length} backup(s) older than ${config.retentionDays} days`);
  return stale.length;
}

/**
 * Take one backup and upload it, whatever the schedule says.
 *
 * `dryRun` does everything except the upload and the prune, so the dump itself — by
 * far the most likely thing to be misconfigured — can be proven on a machine that must
 * not write to the bucket.
 */
async function runBackup({ dryRun = false, now = new Date() } = {}) {
  const reason = disabledReason();
  if (reason && !dryRun) throw new Error(`backups are not configured: ${reason}`);

  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const name = `${env.db.name}_${stamp}.dump`;
  const tmp = path.join(os.tmpdir(), `shoeerp-backup-${process.pid}-${stamp}.dump`);

  const started = Date.now();
  try {
    await runPgDump(tmp);
    const { size } = fs.statSync(tmp);
    if (!size) throw new Error('pg_dump produced an empty file');

    if (dryRun) {
      console.log(`[backup] dry run: ${name} would be ${(size / 1048576).toFixed(2)} MB`);
      return { key: null, bytes: size, dryRun: true, seconds: (Date.now() - started) / 1000 };
    }

    const key = `${config.prefix}/${name}`;
    const { Upload } = require('@aws-sdk/lib-storage');
    await new Upload({
      client: client(),
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: fs.createReadStream(tmp),
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'AES256',
      },
    }).done();

    const seconds = (Date.now() - started) / 1000;
    console.log(`[backup] uploaded ${key} (${(size / 1048576).toFixed(2)} MB) in ${seconds.toFixed(1)}s`);
    await pruneOldBackups(await listBackups());
    return { key, bytes: size, dryRun: false, seconds };
  } finally {
    // The temp file is removed whether the dump failed, the upload failed, or it all
    // worked — a half-written dump left behind each night fills the disk the database
    // is sitting on.
    try { fs.unlinkSync(tmp); } catch { /* never existed, or already gone */ }
  }
}

/** Has enough time passed since the newest backup in the bucket? */
async function isDue(now = new Date()) {
  const existing = await listBackups();
  if (!existing.length) return true;
  const age = now.getTime() - new Date(existing[0].LastModified).getTime();
  return age >= config.intervalHours * HOUR_MS;
}

let running = false;
async function tick() {
  // A dump that overruns its window must not have a second one started on top of it —
  // two pg_dumps at once on a one-core box is how the till starts timing out.
  if (running) return;
  running = true;
  try {
    if (await isDue()) await runBackup();
  } catch (error) {
    console.error('[backup] pass failed:', error.message);
  } finally {
    running = false;
  }
}

/**
 * Start the hourly check. Returns a stop function.
 *
 * `unref()` on both timers so a pending check never holds the process open through a
 * shutdown, matching `retention.js`.
 */
function startBackupJob() {
  const reason = disabledReason();
  if (reason) {
    console.log(`[backup] disabled — ${reason}`);
    return () => {};
  }
  console.log(`[backup] every ${config.intervalHours}h to s3://${config.bucket}/${config.prefix}/, keeping ${config.retentionDays} days`);

  // Five minutes, so a restart cannot collide with startup — and so a server restarted
  // repeatedly during a deploy does not try to back up on each one.
  const initial = setTimeout(tick, 5 * 60_000);
  const periodic = setInterval(tick, HOUR_MS);
  initial.unref();
  periodic.unref();
  return () => { clearTimeout(initial); clearInterval(periodic); };
}

module.exports = {
  startBackupJob, runBackup, isDue, listBackups, pruneOldBackups, disabledReason, config,
};
