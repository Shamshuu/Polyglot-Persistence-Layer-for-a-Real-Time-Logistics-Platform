'use strict';

const { Package } = require('../db/mongo');

/**
 * Handle PACKAGE_STATUS_CHANGE events.
 *
 * Upserts the package document in MongoDB:
 *   - If the package doesn't exist → creates it with a new status_history array
 *   - If the package exists        → appends the new status entry to status_history
 *
 * @param {object} event  Parsed event object from events.log
 */
async function handlePackageStatusChange(event) {
  const { package_id, status, location, driver_id } = event.payload;

  const statusEntry = {
    status,
    timestamp: event.timestamp,
    location,
    driver_id,
  };

  await Package.findOneAndUpdate(
    { package_id },
    { $push: { status_history: statusEntry } },
    { upsert: true, new: true }
  );

  console.log(`[Document] Package ${package_id} → status "${status}" appended`);
}

module.exports = { handlePackageStatusChange };
