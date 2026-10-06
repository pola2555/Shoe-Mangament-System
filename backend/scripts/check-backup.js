/*
 * The nightly database backup.
 *
 * Two things have to be true of a backup job, and the second is the one that bites:
 * it has to produce a restorable file, and it has to NOT run where it was not meant
 * to. Every developer machine here runs the same code with STORAGE_TYPE=s3 pointed at
 * a real bucket, so "off unless explicitly turned on" is not a nicety — a default-on
 * job would have laptops writing dumps of scratch databases into production storage.
 *
 * So the refusals are tested as carefully as the dump, and NOTHING in this file
 * uploads anything. The dump is taken for real, measured, and — the part that actually
 * matters — read back with pg_restore to prove it contains the tables it should.
 * A backup nobody has ever restored is a rumour.
 *
 * Run: npm run check:backup
 */
process.chdir(require('path').join(__dirname, '..'));

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    console.log('  ok   ' + name + (r === undefined ? '' : '  ' + r));
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    fail++;
  }
}
async function checkAsync(name, fn) {
  try {
    const r = await fn();
    console.log('  ok   ' + name + (r === undefined ? '' : '  ' + r));
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    fail++;
  }
}

/** Load dbBackup with a specific environment, bypassing require's cache. */
function loadWith(overrides) {
  const keys = [
    'BACKUP_ENABLED', 'BACKUP_S3_BUCKET', 'BACKUP_S3_PREFIX', 'BACKUP_INTERVAL_HOURS',
    'BACKUP_RETENTION_DAYS', 'BACKUP_ALLOW_UPLOADS_BUCKET', 'PG_DUMP_PATH',
  ];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, overrides);
  delete require.cache[require.resolve('../src/utils/dbBackup')];
  const mod = require('../src/utils/dbBackup');
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

(async () => {
  const env = require('../src/config/env');

  console.log('THE GAP: the only copies of this database were taken by hand, before deploys.');
  console.log('');
  console.log('refusing to run where it should not:');

  check('off by default — an unconfigured machine never uploads', () => {
    const m = loadWith({});
    const r = m.disabledReason();
    if (!r) throw new Error('a machine with no backup config would have uploaded');
    return r;
  });

  check('on, but with no bucket, is still off', () => {
    const m = loadWith({ BACKUP_ENABLED: 'true' });
    const r = m.disabledReason();
    if (!r || !/BACKUP_S3_BUCKET/.test(r)) throw new Error('expected a complaint about the bucket, got: ' + r);
    return r;
  });

  check('the uploads bucket is refused — it is served to browsers', () => {
    // The one that matters. That bucket's objects are rendered into <img> tags; a
    // dump beside them is every phone number and password hash in the shop, one URL
    // guess away. A prefix is not a security boundary.
    const m = loadWith({ BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: env.storage.s3.bucket });
    const r = m.disabledReason();
    if (!r) throw new Error('it would have written the database into the uploads bucket');
    if (!/uploads bucket/.test(r)) throw new Error('the message does not explain why: ' + r);
    return 'refused, and the message names the override';
  });

  check('...but the refusal can be overridden deliberately', () => {
    const m = loadWith({
      BACKUP_ENABLED: 'true',
      BACKUP_S3_BUCKET: env.storage.s3.bucket,
      BACKUP_ALLOW_UPLOADS_BUCKET: 'true',
    });
    if (m.disabledReason()) throw new Error('the override does not work: ' + m.disabledReason());
  });

  check('a private bucket, enabled, is accepted', () => {
    const m = loadWith({ BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: 'some-private-backup-bucket' });
    const r = m.disabledReason();
    if (r) throw new Error('a good configuration was rejected: ' + r);
    if (m.config.intervalHours !== 24) throw new Error('default interval is not 24h');
    if (m.config.retentionDays !== 30) throw new Error('default retention is not 30 days');
    return '24h, 30 days, prefix ' + m.config.prefix;
  });

  check('starting the job without configuration is a log line, not a crash', () => {
    const m = loadWith({});
    const stop = m.startBackupJob();
    if (typeof stop !== 'function') throw new Error('no stop function returned');
    stop();
  });

  await checkAsync('a misconfigured bucket cannot be uploaded to by mistake', async () => {
    const m = loadWith({ BACKUP_ENABLED: 'true' });
    let threw = null;
    try { await m.runBackup({ dryRun: false }); } catch (e) { threw = e.message; }
    if (!threw) throw new Error('runBackup uploaded with no bucket configured');
  });

  console.log('');
  console.log('the dump itself:');

  const m = loadWith({});
  let dumpPath = null;

  await checkAsync('pg_dump is reachable and produces a non-empty file', async () => {
    const res = await m.runBackup({ dryRun: true });
    if (!res.dryRun) throw new Error('a dry run uploaded something');
    if (res.key !== null) throw new Error('a dry run produced an S3 key');
    if (!res.bytes) throw new Error('empty dump');
    return `${(res.bytes / 1048576).toFixed(2)} MB in ${res.seconds.toFixed(1)}s`;
  });

  await checkAsync('the dump is a real custom-format archive, listable by pg_restore', async () => {
    // Taken again, kept this time, so the contents can be read back. This is the
    // difference between "a file was produced" and "a backup exists".
    const tmp = path.join(os.tmpdir(), `shoeerp-verify-${process.pid}.dump`);
    const dbName = env.db.name;
    const r = spawnSync(process.env.PG_DUMP_PATH || 'pg_dump', [
      '--host', String(env.db.host), '--port', String(env.db.port),
      '--username', String(env.db.user), '--dbname', String(dbName),
      '--format', 'custom', '--no-owner', '--no-privileges', '--file', tmp,
    ], { env: { ...process.env, PGPASSWORD: env.db.password || '' }, windowsHide: true });
    if (r.status !== 0) throw new Error('pg_dump failed: ' + String(r.stderr).slice(0, 200));
    dumpPath = tmp;

    const listed = spawnSync('pg_restore', ['--list', tmp], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) throw new Error('pg_restore could not read it: ' + String(listed.stderr).slice(0, 200));
    const toc = String(listed.stdout);

    // The tables the shop would be ruined without.
    const needed = ['sales', 'sale_items', 'inventory_items', 'products', 'users', 'customers'];
    const missing = needed.filter((t) => !new RegExp(`TABLE DATA public ${t} `).test(toc));
    if (missing.length) throw new Error('the archive has no data for: ' + missing.join(', '));
    return `${needed.length}/${needed.length} critical tables present`;
  });

  await checkAsync('the dump carries rows, not just an empty schema', async () => {
    if (!dumpPath) throw new Error('no dump to inspect');
    const listed = spawnSync('pg_restore', ['--list', dumpPath], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const dataEntries = String(listed.stdout).split('\n').filter((l) => / TABLE DATA /.test(l));
    if (dataEntries.length < 20) throw new Error(`only ${dataEntries.length} tables carry data`);
    return `${dataEntries.length} tables with data`;
  });

  check('the temp file is cleaned up after a run', () => {
    // Checked against the dry run's own temp path pattern: a dump left behind every
    // night fills the disk the database is sitting on.
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(`shoeerp-backup-${process.pid}-`));
    if (leftovers.length) throw new Error('left behind: ' + leftovers.join(', '));
    return 'nothing left in ' + os.tmpdir();
  });

  if (dumpPath) { try { fs.unlinkSync(dumpPath); } catch { /* gone */ } }

  console.log('');
  console.log('scheduling:');

  check('the interval and retention are configurable', () => {
    const m2 = loadWith({
      BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: 'b',
      BACKUP_INTERVAL_HOURS: '6', BACKUP_RETENTION_DAYS: '90',
    });
    if (m2.config.intervalHours !== 6) throw new Error('interval ignored');
    if (m2.config.retentionDays !== 90) throw new Error('retention ignored');
    return '6h / 90 days';
  });

  await checkAsync('a bad pg_dump path fails with a message that says what to do', async () => {
    const m2 = loadWith({ PG_DUMP_PATH: 'definitely-not-a-real-pg-dump' });
    let msg = null;
    try { await m2.runBackup({ dryRun: true }); } catch (e) { msg = e.message; }
    if (!msg) throw new Error('a missing pg_dump did not fail');
    if (!/PG_DUMP_PATH|postgresql-client/.test(msg)) throw new Error('unhelpful message: ' + msg);
  });

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + (e.stack || e.message));
  process.exit(1);
});
