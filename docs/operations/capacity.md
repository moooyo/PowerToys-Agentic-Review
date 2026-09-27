# Capacity observation and deferred acceptance

This document describes the implemented observation interface and the production
acceptance procedure. The subsequent [four-GiB workflow handoff](../handoff/2026-09-27-four-gib-workflow-acceptance.md)
records targeted software checks and a short synthetic capacity observation. That
bounded result does not establish compaction, sustained throughput, or production capacity.

## Administrator snapshot

`GET /api/operations/status` uses the production password session and requires a
current account with `isAdmin: true`. A Worker token and an ordinary operator's
repository permissions do not grant access. The route applies the same host and
network restrictions as the existing runtime operator authenticator. Authentication
and the administrator check run on every request, including cache hits. Responses,
including authentication failures, use `Cache-Control: no-store`.

The response is versioned as `InvestigationOperationsStatusV1`. It contains only
aggregate counts, policy values, process timing, and storage measurements. It does
not contain database paths, account names, repository identities, task or attempt
IDs, source content, credentials, or raw filesystem errors. Do not make this endpoint
public or forward its response to ordinary Dashboard users.

| Field | Meaning |
| --- | --- |
| `sampleStartedAt` / `sampledAt` | UTC timestamps delimiting collection of this sample. |
| `runtime.processStartedAt` | Start time estimated once from the observer's clock and process uptime, then fixed for its lifetime. Compare it across samples to detect a new process even when uptime is larger than the previous observation. |
| `runtime.processUptimeSeconds` | Process uptime when the sample completed. It does not prove continuous Worker availability. |
| `runtime.nodeVersion` | Node.js version used by the running Server. A release revision belongs to the separately sealed deployment manifest. |
| `storage.investigation.schemaVersion` | Investigation database schema version supported by this runtime. |
| `storage.investigation.sqlite.pageSizeBytes` | SQLite page size. |
| `storage.investigation.sqlite.pageCount` | Pages in SQLite's current logical database snapshot. |
| `storage.investigation.sqlite.freePageCount` | Pages on SQLite's free list that may be reused by later writes. |
| `storage.investigation.sqlite.logicalBytes` | `pageSizeBytes * pageCount`, as an exact decimal string. |
| `storage.investigation.sqlite.reusableBytes` | `pageSizeBytes * freePageCount`, as an exact decimal string. |
| `storage.investigation.sqlite.journalMode` | Current SQLite journal mode; normally `wal` for the persistent investigation store. |
| `storage.{investigation,authentication}.files.{database,wal,sharedMemory}` | File state and logical length. `wal` and `sharedMemory` describe the SQLite `-wal` and `-shm` sidecars. |
| `storage.{investigation,authentication}.fileSystem` | Platform-reported filesystem capacity for the database file, after resolving its real path. |
| `tasks.total` / `tasks.byState` | Count of all stored Tasks, including terminal history, with fixed state keys. |
| `resourceLeases.total` / `resourceLeases.byPoolAndState` | Count of all resource lease records, including released history. |
| `evidence.retainedBytes` / `evidence.count` | Existing logical artifact quota counters. |
| `evidence.maximumBytes` / `evidence.maximumCount` | Configured evidence quota limits. |
| `evidence.retentionSeconds`, `cleanupIntervalSeconds`, `cleanupBatchSize` | Existing retention policy; this endpoint does not trigger cleanup. |

File `status` is `present`, `missing`, `unavailable`, or `in_memory`. Only `present`
has a decimal-string `byteLength`; all other states have `null`. A missing WAL can
be normal, but a missing persistent database is not a successful database measurement.
Do not silently turn missing or unavailable measurements into zero.

Filesystem `status` is `available`, `unavailable`, or `in_memory`. Available results
have decimal-string `totalBytes`, `freeBytes`, and `availableBytes`. The last value
is capacity available to the current process according to the filesystem API; free
space reserved for other users may be excluded. Unsupported APIs, denied reads,
missing files, and other failures produce `null` values with `unavailable`. In-memory
stores skip filesystem calls. The authentication store exposes file lengths and
filesystem capacity, not account rows or a second SQLite connection.

Byte strings preserve values above JavaScript's maximum safe integer. Read them as
arbitrary-precision integers, not floating-point values. The two database files may
share a filesystem; their reported free space must not be added together.

The fixed Task state keys are `queued`, `running`, `completed`, `blocked`, `failed`,
`cancelled`, `interrupted`, and `unknown`. Resource pools are `static`, `e2e`, and
`unknown`; states are `held`, `needs_cleanup`, `released`, and `unknown`. Invalid or
unexpected stored dimensions count as `unknown` instead of leaking arbitrary keys
or disappearing from totals. Occupancy includes `held` and `needs_cleanup`, not
`released`. Occupancy can exceed a newly lowered concurrency setting. These counts
are not a guarantee of Worker health or a throughput measurement.

## Measurement limits

These quantities serve different purposes:

- Evidence quota bytes count original artifact bytes admitted by the evidence store.
  Content is stored as Base64 within JSON, and metadata, reports, output, indexes,
  and other collections add storage beyond that quota.
- A file's logical length comes from its file metadata. It is not the filesystem's
  actual allocated block count, nor proof of physical disk reclamation. Compression,
  sparse allocation, snapshots, and filesystem behavior can change actual allocation.
- SQLite logical bytes describe its page view, which can include changes still held
  in the WAL. Do not add this value to the main file length and call the result disk
  usage. WAL bytes can include historical or reusable frames and do not equal live
  row bytes.
- Free-list pages are reusable inside SQLite. They remain within its logical file
  capacity and are not equivalent to free space returned to the operating system.
- Filesystem free space also changes because of other applications and volumes.
  It cannot attribute every decrease to this Server.

The SQLite counters and aggregates share one short read transaction, completed
before asynchronous filesystem calls. Filesystem observations are not atomic with
SQLite or with each other. Concurrent writes, checkpoints, or sidecar removal can
change files within the reported time window. A SQLite read failure returns a generic
HTTP 503 rather than an old sample or fabricated zero. Filesystem failures keep the
remaining measurements available and explicitly mark the missing ones.

The existing session authenticator advances its durable clock in the authentication
database to protect against clock rollback. An authenticated status request therefore
can generate authentication database or WAL writes, just like other authenticated
reads. Snapshot collection itself does not write the investigation database. Include
the chosen observation traffic in the baseline; do not attribute all authentication
WAL growth to the synthetic workload or bypass session checks to suppress that cost.

Samples are cached per runtime for five seconds and concurrent requests share an
in-flight sample. `sampledAt` is unchanged on a cache hit. Task and lease aggregation
happens in SQLite and returns bounded results, but it still scans stored JSON rows.
Use at least a 30-second sampling interval for acceptance and increase it when the
database is large. This interface is not intended for aggressive health polling.

## Acceptance after the Worker is available

Before running a capacity exercise, record the release manifest, intended duration,
workload and concurrency, observation interval, allowed queue and cleanup backlog,
minimum free space, and maximum storage growth. Choose thresholds for the intended
machine and workload. No universal capacity threshold is assumed by the Server.
Missing thresholds mean an observation can be recorded, but not declared passed.

Use isolated synthetic task data and mocked upstream transports for the initial
exercise. Verification must not write to actual repository PRs or Issues without
explicit approval for the exact targets, operations, content, and run scope.

Collect a baseline, sustained-load samples, a settled sample after normal cleanup,
and another sample after the controlled restart planned by the deployment runbook.
Evaluate:

1. Queue and completion rates for the recorded workload, with distinct explanations
   for a missing Worker, exhausted concurrency, and cleanup-pending leases.
2. Main database, WAL, and shared-memory file lengths; logical page and free-list
   growth; evidence counters; and available filesystem capacity independently.
3. Retention under the configured age, batch, and interval limits. Retained source
   artifacts and active task protections must remain intact.
4. Restart recovery using the fixed process start identifier and uptime, retained
   task state, lease cleanup, and operation receipts. A read-only capacity snapshot
   does not itself exercise recovery or completion.
5. Tail behavior after the workload settles: a released logical quota with a stable
   larger database file can be expected reuse, not a failed retention cleanup.

Retain the sample timestamps, threshold configuration, workload description,
duration, and all unavailable measurements alongside the acceptance decision.
Keep failed historical receipts; a newer successful run does not rewrite them.

## SQLite maintenance boundary

The snapshot route does not run `wal_checkpoint`, `VACUUM`, `incremental_vacuum`,
delete records, or change SQLite pragmas. It does not automatically block tasks
because of a disk threshold. Existing SQLite checkpoint behavior remains in effect.

Checkpointing and compaction need a separate scheduled maintenance procedure:
take a consistent backup, control writers, confirm the intended database and spare
disk capacity, preserve active Task and cleanup journals, and record before/after
measurements. A checkpoint transfers eligible WAL frames; it does not by itself
promise a smaller main database. Busy readers can prevent complete WAL reclamation.
Compaction may require a database rewrite and additional temporary storage. Do not
use it as an unreviewed response to low disk space or run it on every status read.

If maintenance is later required, implement and review that procedure with the
deployment owner. This change provides observation and a future acceptance basis;
it does not claim that physical disk reclamation has been performed or accepted.
