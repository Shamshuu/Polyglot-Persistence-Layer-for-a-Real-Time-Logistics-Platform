'use strict';

const mongoose = require('mongoose');

// ─── Package Schema ──────────────────────────────────────────────────────────

const statusEntrySchema = new mongoose.Schema(
  {
    status:    { type: String, required: true },
    timestamp: { type: String, required: true },
    location:  {
      lat: Number,
      lon: Number,
    },
    driver_id: { type: String },
  },
  { _id: false }
);

const packageSchema = new mongoose.Schema(
  {
    package_id:     { type: String, required: true, unique: true, index: true },
    status_history: { type: [statusEntrySchema], default: [] },
  },
  { timestamps: true }
);

const Package = mongoose.model('Package', packageSchema);

// ─── Connection helpers ───────────────────────────────────────────────────────

/**
 * Connect to MongoDB using environment variables.
 */
async function connect() {
  const user     = encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME || 'root');
  const password = encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD || 'password');
  const host     = process.env.MONGO_HOST || 'localhost';
  const port     = process.env.MONGO_PORT || 27017;
  const db       = process.env.MONGO_DB   || 'logistics_db';

  const uri = `mongodb://${user}:${password}@${host}:${port}/${db}?authSource=admin`;

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 30_000,
    socketTimeoutMS: 45_000,
  });

  console.log(`[MongoDB] Connected → ${host}:${port}/${db} ✓`);
}

/**
 * Gracefully close the Mongoose connection.
 */
async function close() {
  await mongoose.connection.close();
  console.log('[MongoDB] Connection closed');
}

module.exports = { connect, close, Package };
