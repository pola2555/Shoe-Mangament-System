const { v4: uuidv4 } = require('uuid');

/**
 * Generate a sequential document number.
 * Format: PREFIX-YYYY-NNNN (e.g., "PI-2026-0001")
 *
 * Must be called INSIDE the transaction that inserts the document. It takes a
 * transaction-scoped advisory lock keyed on prefix+year, so concurrent callers
 * serialise here and are released at commit. Previously this ran outside the
 * transaction: two simultaneous checkouts read the same maximum, and the loser hit
 * the unique index and saw a bare "A record with this value already exists".
 *
 * @param {string} prefix - e.g., 'PI', 'S', 'TR', 'WI', 'CR', 'SR'
 * @param {object} db - Knex transaction (or instance, when no concurrency is possible)
 * @param {string} table - Table to check for existing numbers
 * @param {string} column - Column that stores the number
 * @returns {Promise<string>} Next sequential number
 */
async function generateDocumentNumber(prefix, db, table, column = 'invoice_number') {
  const year = new Date().getFullYear();
  const pattern = `${prefix}-${year}-%`;

  // Serialise number allocation per (prefix, year). pg_advisory_xact_lock releases
  // automatically on commit or rollback, so a failed insert cannot strand the lock.
  await db.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`docnum:${prefix}:${year}`]);

  // Order by the numeric suffix, not the whole string. A lexical sort put
  // 'S-2026-9999' above 'S-2026-10000', so the counter reset after 9999 documents
  // and started colliding with numbers already issued.
  const result = await db(table)
    .where(column, 'like', pattern)
    .orderByRaw(`NULLIF(regexp_replace(split_part(??, '-', 3), '[^0-9]', '', 'g'), '')::bigint DESC NULLS LAST`, [column])
    .first()
    .select(column);

  let nextNum = 1;
  if (result) {
    const lastNum = parseInt(String(result[column]).split('-').pop(), 10);
    if (Number.isFinite(lastNum)) nextNum = lastNum + 1;
  }

  // padStart(4) is a minimum width, not a cap — 10000 renders as-is once passed.
  return `${prefix}-${year}-${String(nextNum).padStart(4, '0')}`;
}

/**
 * Generate a UUID v4
 */
function generateUUID() {
  return uuidv4();
}

module.exports = { generateDocumentNumber, generateUUID };
