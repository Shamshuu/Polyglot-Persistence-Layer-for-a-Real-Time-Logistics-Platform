'use strict';

const express = require('express');

const neo4jDb   = require('./db/neo4j');
const mongoDb   = require('./db/mongo');
const postgresDb = require('./db/postgres');

const { ingestLogFile } = require('./ingestor');
const { runReconciler } = require('./reconciler');
const queryRouter        = require('./api/queryRouter');

const API_PORT = parseInt(process.env.API_PORT || '3000', 10);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[App] Received ${signal} — shutting down gracefully …`);
  try {
    await neo4jDb.close();
    await mongoDb.close();
    await postgresDb.close();
  } catch (err) {
    console.error('[App] Error during shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Polyglot Persistence — Logistics Event Router          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Step 1: Connect to all databases ────────────────────────────────────────
  console.log('\n[App] Connecting to databases …');

  try {
    await neo4jDb.connect();
  } catch (err) {
    console.error('[App] FATAL: Neo4j connection failed:', err.message);
    process.exit(1);
  }

  try {
    await mongoDb.connect();
  } catch (err) {
    console.error('[App] FATAL: MongoDB connection failed:', err.message);
    process.exit(1);
  }

  try {
    await postgresDb.initSchema();
  } catch (err) {
    console.error('[App] FATAL: PostgreSQL schema init failed:', err.message);
    process.exit(1);
  }

  // ── Step 2: Ingest the event log ─────────────────────────────────────────────
  console.log('\n[App] Starting event log ingestion …');
  await ingestLogFile();

  // ── Step 3: Run reconciliation for any deferred billing events ───────────────
  console.log('\n[App] Running reconciliation pass …');
  await runReconciler();

  // ── Step 4: Start the REST API server ────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Unified query endpoint
  app.use('/query', queryRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Generic error handler
  app.use((err, _req, res, _next) => {
    console.error('[App] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`\n[App] ✓ API server listening on http://0.0.0.0:${API_PORT}`);
    console.log(`[App]   GET /health`);
    console.log(`[App]   GET /query/package/:package_id`);
    console.log('\n[App] Ready.\n');
  });
}

bootstrap().catch((err) => {
  console.error('[App] FATAL: Unhandled bootstrap error:', err);
  process.exit(1);
});
