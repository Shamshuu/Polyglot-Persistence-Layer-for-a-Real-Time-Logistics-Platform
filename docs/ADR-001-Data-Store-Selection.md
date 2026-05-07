# ADR-001: Data Store Selection for the Logistics Platform

**Status:** Accepted  
**Date:** 2023-10-27  
**Deciders:** Logistics Platform Architecture Team

---

## Context

The logistics platform must efficiently serve three fundamentally different query patterns from a single high-throughput event stream:

1. **Geospatial / Relationship queries** — "Which zone is driver X currently in?" and "Which drivers are in zone Y?" These queries traverse relationships between entities rather than filter rows by value.

2. **Append-only document history** — "Show me the full status timeline for package P." Each package accumulates an ordered sequence of status change events. The schema evolves over time (new fields may be added to status entries), and queries always retrieve a complete document rather than joining across tables.

3. **Transactional / financial records** — "Generate a billing report for customer C." Billing data demands ACID guarantees, strict schema enforcement, and the ability to run aggregate queries (SUM, GROUP BY) without risk of double-counting due to duplicate records.

Using a single database to serve all three patterns leads to:
- Over-normalised schemas that destroy write throughput for the append-only history use case.
- Lack of native relationship traversal, forcing expensive multi-hop JOINs for driver-zone queries.
- Schema rigidity that makes it difficult to evolve the structure of status events independently.

The solution is **polyglot persistence**: deploying three specialised stores, each chosen to excel at exactly one of the three patterns above.

---

## Decision

We will use three purpose-built data stores, one per query pattern:

| Query Pattern | Store | Technology |
|---|---|---|
| Driver–Zone relationship traversal | **Graph database** | Neo4j 5 Community |
| Package status history (append-only) | **Document database** | MongoDB 7 |
| Billing / invoicing (transactional) | **Relational database** | PostgreSQL 16 |

A single **Node.js event-router** service reads from `events.log`, routes each event to the correct store, and exposes a unified REST API (`GET /query/package/:id`) that aggregates data from all three stores into a single chronologically-sorted response.

---

## Consequences

### Graph Store — Neo4j

**Why it fits:**
- Neo4j natively models entities (Driver, Zone) as nodes and relationships (LOCATED_IN) as first-class citizens. The Cypher `MERGE` statement makes upsert-style operations on relationships idiomatic and efficient.
- Relationship traversal is O(relationship count), not O(table size) — it scales as the number of drivers grows without a full table scan.
- The browser UI (port 7474) provides instant visual graph exploration, useful for debugging and demos.

**Trade-offs:**
- Not suited for large-scale transactional writes or aggregate numerical queries (e.g., totals, averages over millions of rows).
- Community Edition does not support clustering, so it is a single point of failure in production. Enterprise Edition is required for high availability.
- The Bolt wire protocol adds a small overhead compared to simple key-value lookups.
- Operational complexity: the team must learn Cypher in addition to SQL.

---

### Document Store — MongoDB

**Why it fits:**
- Each package's history is a natural document: a top-level `package_id` with an embedded `status_history` array. MongoDB's `$push` operator appends a new status entry atomically without rewriting the whole document.
- Schema-less design means new fields on status events (e.g., adding a `carrier_code` to future events) require no migration.
- Mongoose provides a schema layer for validation and a clean ODM API, giving us the best of both worlds.

**Trade-offs:**
- No multi-document ACID transactions in the Community/default configuration. Two documents cannot be updated atomically without enabling transactions.
- Querying across packages (e.g., "all packages DELIVERED today") requires careful index design; ad-hoc queries can be slow on large collections without the right indexes.
- Data duplication is common (the same driver_id appears in every status entry). This is acceptable for a read-optimised history store but would violate normal form in a relational model.

---

### Relational Store — PostgreSQL

**Why it fits:**
- The `UNIQUE` constraint on `invoice_id` prevents duplicate billing records at the database level — a hard requirement for financial data.
- ACID transactions guarantee that a billing record is either fully inserted or not at all; there is no partial-write state.
- `SELECT * FROM invoices WHERE package_id = $1` is a trivially fast indexed lookup, and aggregate queries (`SUM(amount) GROUP BY customer_id`) are fully supported by the query planner.
- The `pg_isready` health check integrates cleanly with Docker Compose's `service_healthy` condition.

**Trade-offs:**
- Schema changes (ALTER TABLE) require migrations and careful coordination across services.
- Modelling a flexible, schema-evolving event history in a relational table would require either JSON columns (losing type safety) or a wide, sparse table (wasting space).
- Horizontal write scaling requires partitioning or external tools (e.g., Citus) which add significant operational complexity.

---

### Overall — Polyglot Persistence

**Benefits:**
- Each store is operated in its sweet spot; no store is asked to do something it does poorly.
- Independent scaling: the document store can be scaled out for read-heavy package history loads without affecting the billing database.
- Technology evolution: each store can be upgraded, replaced, or tuned independently.

**Costs:**
- **Operational complexity** significantly increases. Three database systems require three separate monitoring pipelines, backup strategies, and runbooks.
- **Eventual consistency** is introduced as a first-class concern. Because there is no distributed transaction spanning all three stores, the system must tolerate temporary inconsistency. The retry queue (`retry_queue.json`) and the reconciliation process mitigate this by ensuring billing events are only committed once their prerequisite (a DELIVERED package status in MongoDB) is confirmed.
- **Cross-store joins** must be handled in application code (see the unified query API). This shifts complexity from the database to the service layer and requires careful error handling when one store is unavailable.
- Developer experience requires familiarity with three different query languages and client libraries (Cypher, MongoDB Query Language / Mongoose, and SQL / pg).
