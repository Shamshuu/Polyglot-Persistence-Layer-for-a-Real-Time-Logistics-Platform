'use strict';

const { runQuery } = require('../db/neo4j');

/**
 * Handle DRIVER_LOCATION_UPDATE events.
 *
 * Uses Cypher MERGE to create or update:
 *   - A Driver node  (driverId, latitude, longitude)
 *   - A Zone node    (zoneId)
 *   - A LOCATED_IN relationship between them
 *
 * If the driver was previously associated with a different zone the old
 * LOCATED_IN relationship is deleted and a new one is created, ensuring the
 * graph always reflects the driver's *latest* zone.
 *
 * @param {object} event  Parsed event object from events.log
 */
async function handleDriverLocationUpdate(event) {
  const { driver_id, location, zone_id } = event.payload;
  const { lat, lon } = location;

  const cypher = `
    MERGE (d:Driver {driverId: $driver_id})
    SET   d.latitude  = $lat,
          d.longitude = $lon,
          d.updatedAt = $timestamp

    MERGE (z:Zone {zoneId: $zone_id})

    // Remove any stale LOCATED_IN relationships before creating the new one
    WITH d, z
    OPTIONAL MATCH (d)-[old:LOCATED_IN]->()
    WHERE NOT (d)-[:LOCATED_IN]->(z)
    DELETE old

    MERGE (d)-[:LOCATED_IN]->(z)
  `;

  await runQuery(cypher, {
    driver_id,
    lat,
    lon,
    zone_id,
    timestamp: event.timestamp,
  });

  console.log(`[Graph]  Driver ${driver_id} → Zone ${zone_id} (${lat}, ${lon})`);
}

module.exports = { handleDriverLocationUpdate };
