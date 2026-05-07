'use strict';

const fs       = require('fs');
const readline = require('readline');

const { handleDriverLocationUpdate } = require('./handlers/driverLocationHandler');
const { handlePackageStatusChange }  = require('./handlers/packageStatusHandler');
const { handleBillingEvent }         = require('./handlers/billingHandler');

const LOG_FILE = process.env.LOG_FILE || '/data/events.log';

/**
 * Route a single parsed event to the correct handler.
 * @param {object} event
 */
async function routeEvent(event) {
  switch (event.type) {
    case 'DRIVER_LOCATION_UPDATE':
      await handleDriverLocationUpdate(event);
      break;

    case 'PACKAGE_STATUS_CHANGE':
      await handlePackageStatusChange(event);
      break;

    case 'BILLING_EVENT':
      await handleBillingEvent(event);
      break;

    default:
      console.warn(`[Ingestor] Unknown event type "${event.type}" — skipping`);
  }
}

/**
 * Ingest and process every event in the log file sequentially.
 *
 * Behaviour:
 *   - Blank lines are silently skipped.
 *   - Malformed JSON lines are logged as errors and skipped (no crash).
 *   - Each valid event is routed synchronously before moving to the next line.
 *
 * @returns {Promise<{ processed: number, errors: number }>}
 */
async function ingestLogFile() {
  console.log(`[Ingestor] Starting ingestion of "${LOG_FILE}" …`);

  if (!fs.existsSync(LOG_FILE)) {
    console.error(`[Ingestor] ERROR: Log file not found at "${LOG_FILE}"`);
    return { processed: 0, errors: 0 };
  }

  const fileStream = fs.createReadStream(LOG_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  let processed  = 0;
  let errors     = 0;

  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();

    // Skip blank lines
    if (!trimmed) continue;

    // Parse JSON — log error and continue on failure
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (parseErr) {
      console.error(
        `[Ingestor] ERROR: Malformed JSON on line ${lineNumber} — skipping. ` +
        `Details: ${parseErr.message}. Content: "${trimmed.slice(0, 80)}"`
      );
      errors++;
      continue;
    }

    // Basic schema guard
    if (!event.type || !event.timestamp || !event.payload) {
      console.error(
        `[Ingestor] ERROR: Line ${lineNumber} missing required fields (type/timestamp/payload) — skipping`
      );
      errors++;
      continue;
    }

    try {
      await routeEvent(event);
      processed++;
    } catch (routeErr) {
      console.error(
        `[Ingestor] ERROR: Failed to process event on line ${lineNumber}:`, routeErr.message
      );
      errors++;
    }
  }

  console.log(
    `[Ingestor] Ingestion complete — processed: ${processed}, errors: ${errors}, total lines: ${lineNumber}`
  );

  return { processed, errors };
}

module.exports = { ingestLogFile };
