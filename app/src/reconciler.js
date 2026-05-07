'use strict';

const {
  readRetryQueue,
  writeRetryQueue,
  isPackageDelivered,
  insertInvoice,
} = require('./handlers/billingHandler');

/**
 * Reconciliation process for the eventual consistency retry queue.
 *
 * Reads retry_queue.json and, for each deferred BILLING_EVENT, re-checks
 * whether the package is now marked DELIVERED in the document store.
 *
 * Events that can now be processed are inserted into PostgreSQL and removed
 * from the queue. Remaining events stay in the file for future runs.
 *
 * @returns {Promise<{ reconciled: number, remaining: number }>}
 */
async function runReconciler() {
  const queue = readRetryQueue();

  if (queue.length === 0) {
    console.log('[Reconciler] Retry queue is empty — nothing to reconcile');
    return { reconciled: 0, remaining: 0 };
  }

  console.log(`[Reconciler] Starting reconciliation of ${queue.length} deferred event(s) …`);

  const stillPending = [];
  let reconciled = 0;

  for (const event of queue) {
    const { invoice_id, package_id } = event.payload;

    console.log(`[Reconciler] Re-checking invoice ${invoice_id} for package ${package_id} …`);

    try {
      const delivered = await isPackageDelivered(package_id);

      if (delivered) {
        const success = await insertInvoice(event.payload);
        if (success) {
          console.log(`[Reconciler] ✓ Reconciled invoice ${invoice_id} — removed from queue`);
          reconciled++;
        } else {
          // Insert failed (likely a duplicate that slipped in) — don't retry again
          console.warn(
            `[Reconciler] Insert failed for invoice ${invoice_id} — dropping from queue`
          );
        }
      } else {
        console.log(
          `[Reconciler] Package ${package_id} still not DELIVERED — keeping in queue`
        );
        stillPending.push(event);
      }
    } catch (err) {
      console.error(
        `[Reconciler] ERROR processing invoice ${invoice_id}:`, err.message, '— keeping in queue'
      );
      stillPending.push(event);
    }
  }

  // Persist the remaining unprocessed events
  writeRetryQueue(stillPending);

  console.log(
    `[Reconciler] Done — reconciled: ${reconciled}, remaining in queue: ${stillPending.length}`
  );

  return { reconciled, remaining: stillPending.length };
}

module.exports = { runReconciler };
