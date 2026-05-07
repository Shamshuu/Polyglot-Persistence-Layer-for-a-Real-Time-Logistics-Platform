# Polyglot Persistence Layer for a Real-Time Logistics Platform

A production-grade, event-driven data pipeline that ingests a stream of logistics events and routes them to **three purpose-built databases** — each chosen for a specific query pattern. A unified REST API aggregates data from all stores into a single, chronologically-sorted response.

---

## Architecture Overview

```
events.log
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│                   event-router (Node.js)                │
│                                                         │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────┐  │
│  │DriverLocation  │  │ PackageStatus   │  │ Billing  │  │
│  │   Handler      │  │   Handler       │  │ Handler  │  │
│  └───────┬────────┘  └───────┬─────────┘  └────┬─────┘  │
│          │                   │                  │       │
│          ▼                   ▼                  ▼       │
│       Neo4j              MongoDB           PostgreSQL   │
│    (Graph Store)      (Document Store)  (Relational)    │
│                                            │            │
│                                       retry_queue.json  │
│                                       ◄── Reconciler    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Express REST API (port 3000)            │   │
│  │   GET /query/package/:id  ←─ all three stores    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

| Store | Technology | Purpose |
|---|---|---|
| Graph | Neo4j 5 | Driver–Zone relationship traversal |
| Document | MongoDB 7 | Append-only package status history |
| Relational | PostgreSQL 16 | ACID billing / invoicing records |

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/) ≥ 2.20 (plugin, **not** the legacy `docker-compose` binary)

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Shamshuu/Polyglot-Persistence-Layer-for-a-Real-Time-Logistics-Platform
cd Polyglot-Persistence-Layer-for-a-Real-Time-Logistics-Platform

# 2. Create your .env file from the template
cp .env.example .env

# (Optional) Edit .env to change credentials — the defaults work out of the box

# 3. Start all services
docker compose up --build

# The event-router will automatically:
#   ① Connect to all three databases
#   ② Initialise the PostgreSQL schema
#   ③ Process every event in events.log
#   ④ Run the reconciliation pass on the retry queue
#   ⑤ Start the REST API on port 3000
```

Wait for the line `[App] ✓ API server listening on http://0.0.0.0:3000` in the logs.

To run in the background:

```bash
docker compose up --build -d
docker compose logs -f event-router
```

---

## Stopping the Stack

```bash
docker compose down          # stops containers, keeps volumes
docker compose down -v       # stops containers AND deletes database volumes
```

---

## REST API

### Health Check

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "timestamp": "2023-10-27T10:00:00.000Z" }
```

---

### Unified Package History — `GET /query/package/:package_id`

Returns a chronologically-sorted JSON array of all events related to a package, pulled from all three data stores.

**Response schema:**

```json
[
  {
    "source_system": "document_store | relational_store | graph_store",
    "timestamp": "ISO 8601 string",
    "event_details": { ... }
  }
]
```

**Example — full package history:**

```bash
curl http://localhost:3000/query/package/pkg-complete-history-101
```

**Example — package with out-of-order billing (will be in retry queue initially):**

```bash
curl http://localhost:3000/query/package/pkg-out-of-order-123
```

**Example — package with duplicate invoice (only one record stored):**

```bash
curl http://localhost:3000/query/package/pkg-abc-123
```

---

## Verifying Database State

### PostgreSQL

```bash
docker exec -it logistics_postgres psql -U logistics_user -d logistics_db \
  -c "SELECT * FROM invoices;"
```

### MongoDB

```bash
docker exec -it logistics_mongo mongosh \
  --username logistics_user --password change_me_mongo \
  --authenticationDatabase admin \
  logistics_db --eval "db.packages.find().pretty()"
```

### Neo4j

Open http://localhost:7474 in your browser (login: `neo4j` / `change_me_neo4j`), then run:

```cypher
MATCH (d:Driver)-[:LOCATED_IN]->(z:Zone) RETURN d, z
```

Or via the CLI:

```bash
docker exec -it logistics_neo4j cypher-shell \
  -u neo4j -p change_me_neo4j \
  "MATCH (d:Driver)-[:LOCATED_IN]->(z:Zone) RETURN d.driverId, z.zoneId"
```

---

## Retry Queue

If a `BILLING_EVENT` arrives before its package is marked `DELIVERED`, it is deferred to `retry_queue.json`. After the main ingestion pass, the reconciler re-checks each deferred event.

To inspect the queue:

```bash
cat retry_queue.json
```

To manually trigger another reconciliation pass, restart the container:

```bash
docker compose restart event-router
```

---

## Project Structure

```
.
├── docker-compose.yml          # Orchestrates all 4 services
├── .env.example                # Environment variable template
├── events.log                  # Sample event stream (mounted read-only)
├── retry_queue.json            # Deferred billing events
├── docs/
│   └── ADR-001-Data-Store-Selection.md
└── app/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── index.js            # Entry point (connect → ingest → reconcile → serve)
        ├── ingestor.js         # Line-by-line log reader & event router
        ├── reconciler.js       # Retry queue processor
        ├── db/
        │   ├── neo4j.js        # Neo4j driver singleton
        │   ├── mongo.js        # Mongoose connection + Package model
        │   └── postgres.js     # pg Pool + schema init
        ├── handlers/
        │   ├── driverLocationHandler.js  # → Neo4j
        │   ├── packageStatusHandler.js   # → MongoDB
        │   └── billingHandler.js         # → PostgreSQL (with retry queue logic)
        └── api/
            └── queryRouter.js  # GET /query/package/:id
```

---

## Architecture Decision Record

See [docs/ADR-001-Data-Store-Selection.md](docs/ADR-001-Data-Store-Selection.md) for the full rationale behind the choice of Neo4j, MongoDB, and PostgreSQL.

---

## Environment Variables Reference

| Variable | Description | Default (in .env.example) |
|---|---|---|
| `POSTGRES_USER` | PostgreSQL username | `logistics_user` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `change_me_postgres` |
| `POSTGRES_DB` | Database name | `logistics_db` |
| `POSTGRES_HOST` | Hostname (inside Docker: `postgres`) | `postgres` |
| `POSTGRES_PORT` | Port | `5432` |
| `MONGO_INITDB_ROOT_USERNAME` | MongoDB root username | `logistics_user` |
| `MONGO_INITDB_ROOT_PASSWORD` | MongoDB root password | `change_me_mongo` |
| `MONGO_HOST` | Hostname (inside Docker: `mongo`) | `mongo` |
| `MONGO_PORT` | Port | `27017` |
| `MONGO_DB` | Database name | `logistics_db` |
| `NEO4J_USER` | Neo4j username | `neo4j` |
| `NEO4J_PASSWORD` | Neo4j password | `change_me_neo4j` |
| `NEO4J_URI` | Bolt connection URI | `bolt://neo4j:7687` |
| `API_PORT` | REST API port | `3000` |