'use strict';

const fs   = require('fs');
const path = require('path');

const { Package } = require('../db/mongo');
const postgres     = require('../db/postgres');

const RETRY_QUEUE_FILE = process.env.RETRY_QUEUE_FILE || '/data/retry_queue.json';

// ─── Retry Queue Helpers ──────────────────────────────────────────────────────

/**
 * Read the retry queue from disk.
 * Returns an empty array if the file is missing or unreadable.
 * @returns {object[]}
 */
function readRetryQueue() {
  try {
    const raw = fs.readFileSync(RETRY_QUEUE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Overwrite the retry queue file with the given array.
 * @param {object[]} queue
 */
function writeRetryQueue(queue) {
  fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

/**
 * Append a single event to the retry queue file.
 * @param {object} event
 */
function appendToRetryQueue(event) {
  const queue = readRetryQueue();
  queue.push(event);
  writeRetryQueue(queue);
  console.log(`[Billing] Event deferred → retry_queue.json (invoice: ${event.payload.invoice_id})`);
}

// ─── Database Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether a package has been delivered in the document store.
 * @param {string} packageId
 * @returns {Promise<boolean>}
 */
async function isPackageDelivered(packageId) {
  const doc = await Package.findOne({ package_id: packageId }).lean();
  if (!doc) return false;
  return doc.status_history.some((entry) => entry.status === 'DELIVERED');
}

/**
 * Insert a billing record into PostgreSQL.
 * Catches duplicate-key violations and logs them without re-throwing.
 * @param {object} payload  The billing event payload
 * @returns {Promise<boolean>}  true if inserted, false if duplicate/error
 */
async function insertInvoice(payload) {
  const { invoice_id, package_id, customer_id, amount } = payload;

  try {
    await postgres.query(
      `INSERT INTO invoices (invoice_id, package_id, customer_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [invoice_id, package_id, customer_id, amount]
    );
    console.log(`[Billing] Invoice ${invoice_id} inserted into PostgreSQL ✓`);
    return true;
  } catch (err) {
    if (err.code === '23505') {
      // Unique constraint violation — duplicate invoice_id
      console.error(
        `[Billing] ERROR: Duplicate invoice_id "${invoice_id}" — insertion skipped`
      );
    } else {
      console.error(`[Billing] ERROR: Failed to insert invoice ${invoice_id}:`, err.message);
    }
    return false;
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Handle BILLING_EVENT events.
 *
 * Eventual consistency logic:
 *   1. Query MongoDB to check if the package is DELIVERED.
 *   2. If yes  → insert into PostgreSQL invoices table.
 *   3. If no   → defer to retry_queue.json for later reconciliation.
 *
 * @param {object} event  Parsed event object from events.log
 */
async function handleBillingEvent(event) {
  const { invoice_id, package_id } = event.payload;

  console.log(`[Billing] Processing invoice ${invoice_id} for package ${package_id} …`);

  const delivered = await isPackageDelivered(package_id);

  if (delivered) {
    await insertInvoice(event.payload);
  } else {
    console.warn(
      `[Billing] Package ${package_id} is NOT DELIVERED yet — deferring invoice ${invoice_id}`
    );
    appendToRetryQueue(event);
  }
}

module.exports = {
  handleBillingEvent,
  isPackageDelivered,
  insertInvoice,
  readRetryQueue,
  writeRetryQueue,
};
