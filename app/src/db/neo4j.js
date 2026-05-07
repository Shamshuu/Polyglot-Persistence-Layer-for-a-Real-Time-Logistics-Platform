'use strict';

const neo4j = require('neo4j-driver');

let driver = null;

/**
 * Initialise and return the singleton Neo4j driver.
 * The driver is created lazily on first call and reused thereafter.
 */
function getDriver() {
  if (driver) return driver;

  const uri      = process.env.NEO4J_URI      || 'bolt://localhost:7687';
  const user     = process.env.NEO4J_USER     || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || 'password';

  driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30_000,
  });

  console.log(`[Neo4j] Driver initialised → ${uri}`);
  return driver;
}

/**
 * Verify connectivity to Neo4j.
 * Throws if the database is unreachable.
 */
async function connect() {
  const d = getDriver();
  await d.verifyConnectivity();
  console.log('[Neo4j] Connectivity verified ✓');
}

/**
 * Close the driver and release all connections.
 */
async function close() {
  if (driver) {
    await driver.close();
    driver = null;
    console.log('[Neo4j] Driver closed');
  }
}

/**
 * Run a Cypher query in its own auto-committed session.
 * @param {string} cypher
 * @param {object} params
 * @returns {Promise<import('neo4j-driver').QueryResult>}
 */
async function runQuery(cypher, params = {}) {
  const session = getDriver().session();
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

module.exports = { getDriver, connect, close, runQuery };
