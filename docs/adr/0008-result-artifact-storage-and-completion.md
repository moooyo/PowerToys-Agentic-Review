# ADR 0008: Store and Complete Result Artifacts through a Fenced Content-Addressed Protocol

- Status: Accepted
- Date: 2026-09-02

## Context

ADR 0002 places the single active Server on Linux and makes one Node Worker Thread the sole owner
of SQLite. ADR 0003 requires every artifact association and completion to be fenced by the current
Server lease. ADR 0007 separates the Windows Control identity, which owns Server communication and
lease tokens, from the Executor identity, which produces untrusted result bytes.

Migration `0008_result_artifacts.sql` and the database artifact state machine establish durable
upload identities, immutable chunk receipts, immutable published artifact records, and terminal
tombstones. They intentionally do not write artifact bytes, expose HTTP routes, or decide how a
published result participates in completion. The filesystem and transport design must preserve the
database ordering guarantees across process crashes, response loss, lease expiry during I/O, and
concurrent exact retries.

This ADR freezes the minimum design for result artifacts. It does not claim that the current
candidate has passed its required Linux or Windows verification. The ADR number and SQL migration
number are independent namespaces: ADR 0008 does not imply that all of this decision belongs in SQL
migration 0008.

## Decision

### Scope and invariants

The first storage implementation supports exactly one `result` artifact per live run attempt. A
result artifact:

- is at most 2 MiB;
- consists of at most eight contiguous chunks of at most 256 KiB each;
- has media type `application/json`;
- uses a lowercase UUIDv4 client artifact ID, a bounded canonical name, and lowercase SHA-256
  digests; and
- uses canonical unpadded base64url on JSON transport.

SQLite stores upload state and artifact metadata only. It never stores artifact bytes, raw lease
tokens, filesystem paths exposed to clients, or duplicate lease-token hashes in artifact tables.
The Server accepts at most one attempt generation at a time; it does not promise physical
exactly-once execution or exactly-once HTTP delivery.

Every database phase, including an exact upload replay, verifies the complete lease fence: job,
run attempt, authenticated worker node, worker instance, lease generation, lease-token hash,
attempt and job state, lease deadline, execution deadline, no-progress deadline, current-attempt
ownership, and worker supersession state. The Server clock and the last database phase are
authoritative.

### Linux storage boundary

The Server uses a configured absolute artifact root on a local persistent Linux filesystem. NFS,
SMB, shared-disk active-active operation, and multiple active Servers are unsupported. The root and
every managed directory are owned by the Server user, mode `0700`, and bound to their inspected
device/inode identity. Managed regular files are mode `0600` and have one link outside the
explicitly bounded publication step described below.

The root has disjoint namespaces:

```text
<artifact-root>/
  staging/
  objects/
    sha256/
      <first-two-hex>/
        <64-lowercase-hex-digest>
```

Staging names are derived only from a database-generated upload UUID. Object paths are derived only
from a validated lowercase digest. Client names, route text, repository content, and media metadata
are never joined into a path. Temporary publication files are created in the destination digest
directory and include only Server-generated identifiers.

Every open uses create-new and no-follow semantics where Linux exposes them. The Server validates
the open descriptor and the path before and after security-sensitive operations. It rejects
symbolic links, reparse-like or unexpected file types, unrecognized directory entries, external
hard links, identity changes, permissive modes, ownership changes, and containment escapes. A
storage-integrity violation fails closed and is never repaired by overwriting an immutable object.

### Worker REST surface

The fixed Worker API surface adds these routes:

```text
POST /api/v1/worker/runs/:runAttemptId/artifacts
PUT  /api/v1/worker/artifact-uploads/:uploadId/chunks/:chunkIndex
POST /api/v1/worker/artifact-uploads/:uploadId/complete
POST /api/v1/worker/artifact-uploads/:uploadId/terminate
POST /api/v1/worker/runs/:runAttemptId/complete
```

The first four routes respectively create an upload, put one idempotent chunk, complete and publish
an upload, and explicitly abandon an upload. The run completion route keeps its existing path; its
exact request schema is selected from the completion mode durably bound to the attempt, not from a
caller-provided mode field.

`runAttemptId` is authoritative on the run-scoped create and run completion routes. `uploadId` and
`chunkIndex` are authoritative on the upload-scoped routes. Any duplicated body value must match its
route parameter exactly, and an upload-scoped request remains bound to the upload's durable job and
run-attempt identity rather than a body override. `workerNodeId` always comes from the authenticated
mTLS certificate binding. A body claim may be required for compatibility and checked for equality,
but it can never override the authenticated identity. All schemas reject unknown properties and
have route-specific body limits.

Public responses expose only public artifact contracts. Route handlers explicitly map internal
database and storage DTOs to allowlisted public DTOs; they never serialize an internal result
directly. The mapping removes `prepareId`, `storageObjectKey`, artifact roots, staging and temporary
names, descriptors, and every other server-only field. `ARTIFACT_UPLOAD_CONFLICT` maps to a stable
`409` response with `retryable: false`; lost lease authority continues to map to `409 lease_lost`;
malformed bytes, digest mismatch, and storage-integrity failures have distinct stable non-retryable
codes. Capacity rejection happens before a new upload is created and returns a stable
insufficient-storage response.

### Pure chunk validation before database preparation

The chunk route performs a bounded, side-effect-free validation stage before any database request
or filesystem operation. It:

1. validates the strict route and request schema and global integer bounds;
2. validates canonical unpadded base64url, including zero trailing pad bits;
3. decodes exactly once into a bounded buffer;
4. requires the decoded byte length to equal `chunkBytes`;
5. computes SHA-256 over the decoded bytes and compares it with `chunkSha256`; and
6. validates bounded offset arithmetic without trusting JavaScript integer coercion.

A failure in this stage creates no upload receipt, file, cleanup record, or capacity reservation.
Cursor position, declared total size, upload binding, and lease authority remain database checks.

### Chunk durability protocol

All file operations for one `uploadId` execute under one FIFO Server-process lock. The lock covers
chunk upload, finalization, explicit termination, and reconciler cleanup. A separate bounded gate
serializes storage-capacity admission. These are sufficient only because ADR 0002 permits one active
Server; a multi-Server design requires a new cross-process coordination decision.

The synchronous Linux filesystem kernel runs only inside one dedicated artifact-storage child
process. It never runs on the Fastify event loop and never shares the SQLite Worker. The
asynchronous parent-side client owns bounded data-only requests, rejects all pending work after a
fatal error or exit, and applies an external watchdog that sends one `SIGKILL` to the isolated
storage owner when a synchronous syscall does not return. A timed-out owner is not reused. Only a
real child `exit` or `close` event proves owner absence; an IPC disconnect, shutdown acknowledgement,
or successful `kill()` call does not. The Server retains its database ownership lock until absence
is proven. Production deployment must run the Server under systemd with
`KillMode=control-group`, or under an equivalent container PID namespace and cgroup supervisor that
kills every storage child when the Server main process terminates. A bare `node` launch is not a
supported production topology: if the parent dies while the child is blocked in a synchronous
syscall, JavaScript cannot process the IPC disconnect and `detached: false` does not prevent an
orphan. This deployment-supervision proof is a production enablement gate that must be verified
before the retention and operations runbook phase and before artifact completion is enabled.

For each chunk the order is:

```text
pure validation -> DB prepare -> durable staging write -> DB commit
```

`DB prepare` rechecks the full active lease and returns the stable immutable prepare receipt plus the
complete, bounded sequence of committed chunk receipts from index zero through the durable database
cursor. The same transaction verifies that the receipt sequence is contiguous and ends exactly at
the reported committed offset. No HTTP field or process-local cache may synthesize this prefix.
The Server then opens or creates the staging file, verifies its identity and committed prefix,
writes exactly at the prepared offset, verifies the resulting length, synchronizes the file, and
synchronizes the staging directory when file creation must become durable. Only then may `DB commit`
mark the receipt committed and advance the monotonic cursor. The commit transaction again checks the
complete lease fence and the exact prepare receipt.

An exact retry uses the original receipt. If the receipt is prepared, the Server makes the same byte
range durable and retries the commit. If it is committed, the Server verifies that staging bytes
still cover and match the committed receipt before returning the replay response. Changed metadata
is a conflict. SQLite state is never rewound to conceal missing or corrupt staging bytes.

If the lease expires or the process crashes after the staging write but before DB commit, durable
bytes may be ahead of the committed cursor while the stable receipt remains prepared. They do not
become accepted state until an exact retry completes the second database phase. The reconciler may
remove them after the attempt loses authority.

### Finalization and no-replace CAS publication

Finalization uses this order under the same per-upload lock:

```text
DB prepare
-> verify complete staging size and raw SHA-256
-> create and synchronize a same-directory object temporary
-> atomically publish without replacement
-> synchronize the object directory and any newly created shard-directory parent
-> DB commit
```

The final object key is exactly `sha256/<first-two-hex>/<raw-artifact-sha256>`. Publication must use
a Linux primitive with atomic no-replace behavior, such as `renameat2(RENAME_NOREPLACE)`, or an
audited same-directory link/unlink protocol with equivalent create-if-absent semantics and explicit
crash reconciliation. An `exists` check followed by ordinary `rename`, and any operation that can
replace the destination, are forbidden.

If the final object already exists, the Server opens it without following links and verifies its
complete size and SHA-256 before reuse. A matching object is the same CAS value; a mismatch is a
storage-integrity failure and is never overwritten or deleted automatically. Any transient second
link created by an approved link/unlink publication protocol must be recognizable as
Server-created, bounded to the same directory and inode, removed during publication or recovery,
and followed by directory synchronization. All other hard links are rejected.

Only after publication and directory durability may `DB commit` insert the immutable `run_artifacts`
row and move the upload to `committed`. That transaction rechecks the lease and finalization
receipt. A published object may therefore outlive a failed DB commit, response loss, lease loss, or
Server crash. It is harmless only because it is immutable and a later exact finalization fully
verifies it. Upload cleanup never deletes a published object.

### Upload terminal authority and create replays

The public termination route has one possible disposition:

```text
state = abandoned
reason = client_abandoned
```

The Worker cannot request `corrupt`, supply a different reason code, terminate a committed artifact,
or use termination after losing the lease. The route rechecks the active lease and atomically writes
an immutable terminal tombstone before it asks the reconciler to remove staging data.

Only Server-authoritative code may record `corrupt` or terminate an upload whose presented lease is
already invalid. Corruption reasons are a closed internal set for verified staging, publication, or
metadata-integrity failures. Lease and attempt cleanup use a separate Server-authoritative database
operation; they do not call the Worker-facing termination operation and do not manufacture an
active lease.

Create is idempotent across terminal state. An exact create replay with the same `(runAttemptId,
clientArtifactId)`, lease binding, and immutable metadata returns the existing `abandoned` or
`corrupt` tombstone with `replayed: true`. It does not reserve capacity, create staging state,
resurrect the upload, or erase its reason and timestamp. Changed metadata is a conflict, and a
terminal client artifact ID is consumed permanently. A different client artifact ID is a new
admission, not an exact retry, and remains subject to the attempt mode, one-live-result rule,
capacity gate, and active lease. Active lease authority remains a prerequisite for the create
replay; after authority is gone, `lease_lost` takes precedence over returning the tombstone. A
Server-detected corrupt upload normally causes the attempt to fail and retry under a new generation
rather than silently creating a replacement in place.

### Raw artifact digest and canonical result digest

Two hashes protect different representations and must not be aliased:

- `artifactSha256` is SHA-256 over the exact uploaded bytes. Chunk verification, finalization,
  `run_artifacts.sha256`, and the CAS object key use this raw digest.
- `resultDigest` is SHA-256 over the Server's versioned canonical JSON representation after parsing
  and authoritative result-schema validation. Attempt completion, immutable review projections,
  approvals, and terminal replay identity use this canonical digest.

The values can be equal when the uploaded bytes already use the exact canonical encoding, but no
code may rely on that coincidence. The Server reads the bounded immutable object, verifies the raw
size and digest, parses one JSON value, validates it against the job's authoritative result schema,
canonicalizes it with the pinned algorithm version, and computes `resultDigest`. A Worker-supplied
digest is only a claim and must match the Server computation.

### Completion mode binding and downgrade prevention

The Server, not the Worker request, selects one versioned completion mode during the atomic claim:

```text
inline_result_v1
result_artifact_v1
```

Selection is derived from Server rollout policy and the registered, attested Worker protocol and
capabilities. It is persisted immutably on the run attempt before the granted claim response is
published. The matching job envelope version communicates the selected mode. Attempts created
under the legacy envelope are explicitly interpreted and migrated as `inline_result_v1`; they are
not unversioned.

The completion request contains no mode selector. The Server obtains the attempt's durable mode and
validates exactly that request form. An `inline_result_v1` attempt uses the existing bounded inline
payload. A `result_artifact_v1` attempt submits only the lease identity, committed result artifact
identity, and claimed canonical `resultDigest`; it cannot submit inline JSON as a fallback. A legacy
attempt cannot use an artifact request to change its terminal identity. Once Server policy requires
artifact completion for a Worker or rollout cohort, registration or claim downgrade cannot restore
legacy completion.

The two modes use separate internal database operations and durable terminal identities even if
they share the public route during migration. The artifact operation first prepares completion and
obtains the internal committed object metadata. Outside SQLite, the Server securely reads and
validates the immutable object and derives canonical result data. A final short `BEGIN IMMEDIATE`
transaction then rechecks the full lease, bound completion mode, artifact identity, raw artifact
digest, canonical result digest, current attempt ownership, and terminal receipt before atomically
persisting the result projection and terminal job/attempt state. Filesystem I/O never runs inside
the SQLite Worker transaction.

### Terminal exact replay

A successful terminal commit stores enough immutable identity to distinguish completion mode,
artifact identity when applicable, raw artifact digest, canonical result digest and
canonicalization version, worker identity, lease generation, and token hash. If the response is
lost, an exact resubmission from the same terminal lease identity returns the original terminal
response without creating another result or rerunning publication. It does not require the attempt
to remain active, because the first commit made it terminal, but it must match the original fenced
identity and terminal receipt exactly.

A changed payload, artifact, mode, digest, worker, token, or generation is
`terminal_submission_conflict`. If no terminal commit exists and the lease is no longer valid, the
request is `lease_lost`; the Server does not infer success from a published object alone.

### Reconciliation of every terminal path

All paths that can close authority participate in one Server-owned artifact reconciler. Normal
completion, failure, cancellation, stale-job fencing, lease expiry, worker supersession, explicit
client abandonment, storage corruption, shutdown recovery, and retry exhaustion either enqueue
cleanup in the same database transaction or are discovered by the reconciler's authoritative DB
query. Future terminal paths must use the same helper or satisfy the same durable invariant.

The reconciler performs bounded database batches and filesystem work outside SQLite transactions.
For a live upload whose attempt is terminal or whose lease is invalid, a dedicated DB operation
atomically records the appropriate Server-owned tombstone and durable cleanup intent. Under the
per-upload lock, the reconciler validates and deletes only that upload's staging and recognized
temporary files, synchronizes affected directories, and records cleanup completion or a bounded
retry. Committed CAS objects are never cleanup targets.

Startup and periodic reconciliation also perform bounded, identity-checked scans of staging and
object-temporary namespaces to recover files left between durable boundaries. Each pass has fixed
entry, byte, and time budgets and a non-starving continuation cursor. Unknown entries, unsafe file
types, or identity mismatches make storage unhealthy rather than inviting broad deletion. Cleanup
state is durable or derivable from a bounded scan; historical terminal rows are not rescanned
without limit on every interval.

Migration `0011_artifact_namespace_cleanup.sql` provides only the database foundation for that
future scan. A page classification, durable cleanup-intent update, and cursor advance share one
transaction; the database Worker exposes no independent cursor-advance operation. Observations bind
the target and parent inode identities, file ctime, ownership and mode, and any linked immutable
object peer. This foundation does not scan or unlink files. Filesystem session authority and
handle-bound cleanup verification remain a separate enablement step.

Namespace cleanup health reads are independently bounded for each status. Saturated pending,
retry-waiting, failed, or due counts are operational saturation: capacity admission becomes
uncertain and the reconciler fail-stops. Saturated completed or superseded counts are historical
saturation only. Historical counters are capped for display without disabling admission or a
healthy reconciliation pass.

### Capacity admission

New create operations pass a Server-wide capacity gate before the database creates a new upload.
The gate accounts for:

- configured hard byte and entry limits;
- actual filesystem free space and an operator-configured emergency reserve;
- immutable object bytes already present;
- durable reservations for live uploads; and
- worst-case simultaneous staging and same-sized publication temporary/final bytes.

Database growth also has attempt-local protocol limits independent of filesystem cleanup. One run
attempt may create at most eight distinct result-upload identities, and the sum of
`expected_total_bytes` declared by all of its upload identities may not exceed 16 MiB. The create
transaction counts every status, including `abandoned` and `corrupt`; a terminal tombstone and its
chunk receipts remain charged permanently. An exact create replay of an existing identity does not
consume the limits again. Checking both limits in the same `BEGIN IMMEDIATE` transaction that
creates the upload prevents an active lease from growing SQLite by repeatedly terminating an upload
and choosing a new `clientArtifactId`.

Admission reserves at least twice the declared result size until publication or cleanup resolves
the staging copy. It also limits live upload count, staging entries, publication temporaries, and
cleanup backlog. Exact create replays, including terminal tombstones, are resolved before new
admission and do not consume another reservation. A crash cannot erase the reservation because live
upload rows and bounded filesystem reconciliation reconstruct it. When accounting is uncertain,
the cleanup backlog exceeds its high-water mark, or the safety reserve would be crossed, the Server
rejects new uploads before DB or filesystem mutation. This ADR does not authorize deleting
immutable objects to recover capacity.

### Control and native HostControl ownership

ADR 0007's ownership split remains unchanged:

- Executor produces bounded artifact frames under a signed local execution capability. It has no
  Server route, mTLS key, raw Server lease token, Server upload ID authority, or completion
  authority.
- Control TypeScript owns the application protocol: it consumes verified ARWX artifact frames,
  tracks upload and receipt identity, computes and checks digests, chooses exact retries, preserves
  artifact ordering, holds the Server lease token, finalizes the result artifact, and requests
  completion only in the mode delivered by the granted claim.
- Control ServiceHost owns the non-exportable mTLS key and the fixed-origin HTTPS transport. Its
  role-local HostControl surface is extended with separate, typed create, chunk, upload-complete,
  terminate, and run-completion operations mapped to the exact methods and path templates in this
  ADR.

ServiceHost treats bounded request JSON as opaque application data after enforcing operation,
route-identifier, frame, timeout, concurrency, and response limits. It cannot accept a raw URL,
arbitrary method, header, certificate, proxy, redirect, path, or filesystem locator. It does not
spool artifact files, decide completion mode, invent retry identity, canonicalize results, convert a
failure into success, or automatically replay an ambiguous mutating request. Control performs an
exact replay with stable identifiers when its live lease still permits one.

Artifact frames cross the verified Executor-Control ARWX channel and then bounded HostControl calls;
Control never gains access to the Executor workspace, and Executor never gains access to
HostControl or the Server API. A broken ARWX or HostControl channel follows ADR 0007: Control does
not guess an ambiguous terminal outcome, and fencing plus Server reconciliation decides when live
authority is gone.

## Consequences

- SQLite cannot claim that chunk or artifact bytes are committed before those bytes are durable.
- A durable CAS object can exist without a `run_artifacts` row after a crash or lease loss; it is
  reusable only after full verification and is otherwise future GC work.
- Process-local serialization is deliberately coupled to the one-active-Server deployment.
- Completion rollout requires a schema migration for immutable attempt mode and terminal artifact
  identity, plus compatible claim-envelope and Control/HostControl protocol versions.
- The Server requires storage capacity configuration, health reporting, bounded reconciliation,
  and operational alerting before artifact-mode claims are enabled.
- Result artifacts remain untrusted input. Publication and approval gates are not weakened by
  successful upload or completion.

## Out of Scope

This ADR does not define:

- Dashboard artifact counts, status, download, or read views;
- retention or garbage collection of unreferenced immutable CAS objects;
- log artifacts, multiple result artifacts, or arbitrary media types;
- immutable diff manifests, publication drafts, approvals, GitHub outbox reconciliation, or GitHub
  writes; or
- a shared-filesystem, multi-Server, or external artifact-service deployment.

## References

- [ADR 0002: Run the Control Plane on Linux with Fastify and node:sqlite][adr-0002]
- [ADR 0003: Coordinate Remote Windows Workers with Pull Leases][adr-0003]
- [ADR 0007: Isolate Windows Worker Control and Execution Identities][adr-0007]

[adr-0002]: 0002-linux-fastify-node-sqlite-server.md
[adr-0003]: 0003-remote-windows-worker-leases.md
[adr-0007]: 0007-windows-control-executor-isolation.md
