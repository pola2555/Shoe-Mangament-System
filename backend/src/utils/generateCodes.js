const { v4: uuidv4 } = require('uuid');

/**
 * Generate a sequential document number.
 * Format: PREFIX-YYYY-NNNN (e.g., "PI-2026-0001")
 * 
 * @param {string} prefix - e.g., 'PI', 'S', 'TR', 'WI', 'CR', 'SR'
 * @param {object} db - Knex instance
 * @param {string} table - Table to check for existing numbers
 * @param {string} column - Column that stores the number
 * @returns {string} Next sequential number
 */
async function generateDocumentNumber(prefix, db, table, column = 'invoice_number') {
  const year = new Date().getFullYear();
  const pattern = `${prefix}-${year}-%`;
  
  const result = await db(table)
    .where(column, 'like', pattern)
    .orderBy(column, 'desc')
    .first()
    .select(column);

  let nextNum = 1;
  if (result) {
    const lastNum = parseInt(result[column].split('-').pop(), 10);
    nextNum = lastNum + 1;
  }

  return `${prefix}-${year}-${String(nextNum).padStart(4, '0')}`;
}

/**
 * Generate a UUID v4
 */
function generateUUID() {
  return uuidv4();
}

module.exports = { generateDocumentNumber, generateUUID };
