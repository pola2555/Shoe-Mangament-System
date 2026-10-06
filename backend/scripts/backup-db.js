/*
 * Take a database backup now, by hand.
 *
 * The nightly job in `src/utils/dbBackup.js` does this on its own; this is for the
 * three times you want one immediately — before a migration, before a deploy, and when
 * proving the thing actually works on a new server.
 *
 *   node scripts/backup-db.js --dry-run   dump locally, report the size, upload nothing
 *   node scripts/backup-db.js             dump and upload
 *   node scripts/backup-db.js --list      what is in the bucket already
 *
 * --dry-run needs no S3 configuration at all, which is the point: it is the one form
 * that is safe to run on a developer machine pointed at a real bucket.
 */
process.chdir(require('path').join(__dirname, '..'));

const { runBackup, listBackups, disabledReason, config } = require('../src/utils/dbBackup');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const list = args.includes('--list');

(async () => {
  if (list) {
    const reason = disabledReason();
    if (reason) { console.log(`cannot list — ${reason}`); process.exit(1); }
    const rows = await listBackups();
    if (!rows.length) { console.log(`no backups under s3://${config.bucket}/${config.prefix}/`); return; }
    console.log(`${rows.length} backup(s) in s3://${config.bucket}/${config.prefix}/ — newest first:`);
    for (const r of rows.slice(0, 40)) {
      console.log(`  ${new Date(r.LastModified).toISOString()}  ${(r.Size / 1048576).toFixed(2)} MB  ${r.Key}`);
    }
    return;
  }

  if (!dryRun) {
    const reason = disabledReason();
    if (reason) {
      console.log(`Refusing to upload — ${reason}`);
      console.log('Run with --dry-run to test the dump itself without touching S3.');
      process.exit(1);
    }
  }

  const res = await runBackup({ dryRun });
  if (res.dryRun) {
    console.log(`OK — the dump works (${(res.bytes / 1048576).toFixed(2)} MB in ${res.seconds.toFixed(1)}s). Nothing was uploaded.`);
  } else {
    console.log(`OK — ${res.key}`);
  }
})().catch((e) => {
  console.error('FAILED: ' + e.message);
  process.exit(1);
});
