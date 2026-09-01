const db = require('../config/database');

/**
 * Background retention pruning.
 *
 * Three tables grew without bound:
 *   - activity_log      — a row (with a JSON body dump) for every write in the system
 *   - refresh_tokens    — a row per login and per refresh, never removed
 *   - notifications     — never removed
 *
 * On a busy POS this is the main driver of database growth, and the refresh_tokens
 * table is read on every token refresh, so an ever-growing table directly slows down
 * the auth path.
 *
 * Deletes run in bounded batches so a first run against a large backlog cannot hold a
 * long transaction or spike memory.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;

const config = {
  activityLogDays: parseInt(process.env.RETENTION_ACTIVITY_LOG_DAYS, 10) || 90,
  notificationDays: parseInt(process.env.RETENTION_NOTIFICATION_DAYS, 10) || 90,
  intervalMs: (parseInt(process.env.RETENTION_INTERVAL_HOURS, 10) || 24) * 60 * 60 * 1000,
};

/**
 * Delete in batches until nothing is left to delete, capped so one pass cannot run away.
 * @param {() => import('knex').Knex.QueryBuilder} buildQuery
 */
async function deleteInBatches(buildQuery, label) {
  let total = 0;
  for (let pass = 0; pass < 100; pass++) {
    // Batching comes from the LIMIT on the inner id subquery — PostgreSQL does not
    // accept LIMIT on a DELETE statement itself.
    const deleted = await buildQuery().del();
    total += deleted;
    if (deleted < BATCH_SIZE) break;
  }
  if (total > 0) console.log(`[retention] pruned ${total} rows from ${label}`);
  return total;
}

async function pruneActivityLog() {
  const cutoff = new Date(Date.now() - config.activityLogDays * DAY_MS);
  return deleteInBatches(
    () => db('activity_log').whereIn('id', db('activity_log')
      .select('id').where('created_at', '<', cutoff).limit(BATCH_SIZE)),
    'activity_log'
  );
}

async function pruneRefreshTokens() {
  // Expired or revoked tokens have no further use — a revoked token is only ever
  // compared against, and an expired one fails the expiry check anyway.
  const now = new Date();
  return deleteInBatches(
    () => db('refresh_tokens').whereIn('id', db('refresh_tokens')
      .select('id')
      .where('expires_at', '<', now)
      .orWhere('is_revoked', true)
      .limit(BATCH_SIZE)),
    'refresh_tokens'
  );
}

async function pruneNotifications() {
  const cutoff = new Date(Date.now() - config.notificationDays * DAY_MS);
  return deleteInBatches(
    () => db('notifications').whereIn('id', db('notifications')
      .select('id').where('created_at', '<', cutoff).limit(BATCH_SIZE)),
    'notifications'
  );
}

async function runRetention() {
  try {
    await pruneRefreshTokens();
    await pruneActivityLog();
    await pruneNotifications();
  } catch (error) {
    // Never let a retention failure take down the server.
    console.error('[retention] pass failed:', error.message);
  }
}

/**
 * Start the periodic pass. unref() so the timer never holds the process open
 * during a shutdown.
 */
function startRetentionJob() {
  // Delay the first pass so it does not compete with startup.
  const initial = setTimeout(runRetention, 60_000);
  const periodic = setInterval(runRetention, config.intervalMs);
  initial.unref();
  periodic.unref();
  return () => { clearTimeout(initial); clearInterval(periodic); };
}

module.exports = {
  startRetentionJob,
  runRetention,
  pruneActivityLog,
  pruneRefreshTokens,
  pruneNotifications,
};
