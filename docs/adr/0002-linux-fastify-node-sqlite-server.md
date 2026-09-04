# ADR 0002: Run the Control Plane on Linux with Fastify and node:sqlite

- Status: Accepted
- Date: 2026-08-30

## Context

The Server is a single control plane responsible for GitHub ingestion, scheduling, leases, approvals, publication, and the dashboard API. The expected initial scale does not justify an external database service, but blocking database work must not stall the HTTP event loop.

## Decision

Run the Server on Linux using Node.js 24 LTS, TypeScript, and Fastify.

Use the built-in `node:sqlite` module. A dedicated Node Worker Thread is the only owner of the SQLite database connection. It uses `DatabaseSync` internally and exposes an asynchronous message-based API to the Fastify main thread.

The database will use:

- A local persistent Linux volume, never NFS or SMB.
- WAL mode, foreign keys, `synchronous=FULL`, `trusted_schema=OFF`, and a busy timeout.
- Explicit, versioned SQL migrations with immutable checksums.
- Prepared statements and short `BEGIN IMMEDIATE` transactions for lease-critical operations.
- The built-in SQLite backup API plus externally retained backups.

The deployment supports one active Server process. SQLite stores control-plane state and bounded
inline review results. ADR 0029 removed the unpublished artifact metadata and file-storage path.

## Consequences

- No third-party SQLite Node addon or external database service is required.
- Fastify request handling remains asynchronous while database ordering stays deterministic.
- Node.js patch versions must be pinned because `node:sqlite` behavior is part of the persistence boundary.
- Horizontal Server replicas and shared-disk active-active operation are out of scope. A different database would be required before adding them.
- Database Worker Thread failure makes the Server unready and prevents new lease claims.
