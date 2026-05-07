'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * Return the singleton pg connection pool.
 */
function getPool() {
  if (pool) return pool;

  pool = new Pool({
    host:     process.env.POSTGRES_HOST     || 'localhost',
    port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user:     process.env.POSTGRES_USER     || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'password',
    database: process.env.POSTGRES_DB       || 'logistics_db',
    max:      20,
    idleTimeoutMillis:    30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    console.error('[PostgreSQL] Unexpected pool error:', err.message);
  });

  console.log(`[PostgreSQL] Pool created → ${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}`);
  return pool;
}

/**
 * Verify connectivity and initialise the database schema.
 * Creates the `invoices` table if it does not already exist.
 */
async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        invoice_id   TEXT        PRIMARY KEY,
        package_id   TEXT        NOT NULL,
        customer_id  TEXT        NOT NULL,
        amount       NUMERIC(10, 2) NOT NULL,
        status       TEXT        NOT NULL DEFAULT 'PAID',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_invoice_id UNIQUE (invoice_id)
      );
    `);
    console.log('[PostgreSQL] Schema initialised — invoices table ready ✓');
  } finally {
    client.release();
  }
}

/**
 * Run a parameterised SQL query using the pool.
 * @param {string} text  SQL string with $1, $2, … placeholders
 * @param {any[]}  values  Bound parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, values = []) {
  return getPool().query(text, values);
}

/**
 * Drain all pool connections.
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[PostgreSQL] Pool closed');
  }
}

module.exports = { getPool, initSchema, query, close };
