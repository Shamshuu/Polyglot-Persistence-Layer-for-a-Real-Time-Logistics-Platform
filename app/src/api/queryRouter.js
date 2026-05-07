'use strict';

const express = require('express');

const { Package } = require('../db/mongo');
const postgres     = require('../db/postgres');
const neo4j        = require('../db/neo4j');

const router = express.Router();

// ─── Response Formatter Helpers ───────────────────────────────────────────────

/**
 * Map MongoDB status_history entries into the unified response schema.
 * @param {object[]} history
 * @returns {object[]}
 */
function mapDocumentEvents(history) {
  return history.map((entry) => ({
    source_system: 'document_store',
    timestamp:     entry.timestamp,
    event_details: {
      status:    entry.status,
      location:  entry.location,
      driver_id: entry.driver_id,
    },
  }));
}

/**
 * Map PostgreSQL invoice rows into the unified response schema.
 * @param {object[]} rows
 * @returns {object[]}
 */
function mapRelationalEvents(rows) {
  return rows.map((row) => ({
    source_system: 'relational_store',
    timestamp:     row.created_at.toISOString(),
    event_details: {
      invoice_id:  row.invoice_id,
      customer_id: row.customer_id,
      amount:      parseFloat(row.amount),
      status:      row.status,
    },
  }));
}

/**
 * Map Neo4j query records into the unified response schema.
 * We store the driver's updatedAt timestamp as the event timestamp.
 * @param {import('neo4j-driver').Record[]} records
 * @returns {object[]}
 */
function mapGraphEvents(records) {
  return records.map((record) => {
    const driver = record.get('d').properties;
    const zone   = record.get('z').properties;
    return {
      source_system: 'graph_store',
      timestamp:     driver.updatedAt || new Date(0).toISOString(),
      event_details: {
        driver_id: driver.driverId,
        latitude:  driver.latitude,
        longitude: driver.longitude,
        zone_id:   zone.zoneId,
      },
    };
  });
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * GET /query/package/:package_id
 *
 * Fetches and merges events for a package from all three data stores:
 *   1. MongoDB   → package status history
 *   2. PostgreSQL → billing invoices
 *   3. Neo4j     → driver zone location (looked up via driver_id in the history)
 *
 * Returns a JSON array sorted ascending by timestamp.
 */
router.get('/package/:package_id', async (req, res) => {
  const { package_id } = req.params;

  console.log(`[API] GET /query/package/${package_id}`);

  try {
    // ── 1. MongoDB: fetch package history ────────────────────────────────────
    const packageDocPromise = Package.findOne({ package_id }).lean();

    // ── 2. PostgreSQL: fetch invoices ─────────────────────────────────────────
    const invoicesPromise = postgres.query(
      'SELECT * FROM invoices WHERE package_id = $1',
      [package_id]
    );

    // Run 1 & 2 in parallel; we need the package doc first to get driver_id
    const [packageDoc, invoicesResult] = await Promise.all([
      packageDocPromise,
      invoicesPromise,
    ]);

    // ── 3. Neo4j: fetch driver zone using driver_id from history ──────────────
    let graphEvents = [];

    if (packageDoc && packageDoc.status_history.length > 0) {
      // Find the driver_id from the DELIVERED entry, or fall back to any entry
      const deliveredEntry = packageDoc.status_history.find(
        (e) => e.status === 'DELIVERED'
      );
      const anyEntry = packageDoc.status_history[packageDoc.status_history.length - 1];
      const driverEntry = deliveredEntry || anyEntry;
      const driverId = driverEntry && driverEntry.driver_id;

      if (driverId) {
        try {
          const graphResult = await neo4j.runQuery(
            `MATCH (d:Driver {driverId: $driverId})-[:LOCATED_IN]->(z:Zone)
             RETURN d, z`,
            { driverId }
          );
          graphEvents = mapGraphEvents(graphResult.records);
        } catch (graphErr) {
          console.error('[API] Graph query error:', graphErr.message);
          // Non-fatal — continue without graph data
        }
      }
    }

    // ── Aggregate & sort ──────────────────────────────────────────────────────
    const documentEvents   = packageDoc ? mapDocumentEvents(packageDoc.status_history) : [];
    const relationalEvents = mapRelationalEvents(invoicesResult.rows);

    const allEvents = [...documentEvents, ...relationalEvents, ...graphEvents];

    if (allEvents.length === 0) {
      return res.status(404).json({
        error:   'Not Found',
        message: `No data found for package_id "${package_id}"`,
      });
    }

    // Sort ascending by ISO 8601 timestamp (lexicographic sort works correctly)
    allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return res.status(200).json(allEvents);
  } catch (err) {
    console.error('[API] Unexpected error in /query/package/:package_id:', err.message);
    return res.status(500).json({
      error:   'Internal Server Error',
      message: err.message,
    });
  }
});

module.exports = router;
