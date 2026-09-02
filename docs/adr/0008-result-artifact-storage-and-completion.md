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

The synchronous Linux filesystem kernel runs only inside one dedicated Node Worker Thread. It never
runs on the Fastify event loop and never shares the SQLite Worker. The asynchronous parent-side
client owns bounded data-only requests and rejects all pending work after a fatal protocol, runtime,
timeout, or Worker-exit condition. The client synchronously enters its terminal state, closes its
artifact admission, rejects pending requests, and settles its terminal-failure signal before it
requests `worker.terminate()`. The transaction coordinator observes that signal through a Promise
reaction bound during construction and then enters fail-stop; coordinator propagation is
asynchronous. A timed-out storage Worker is never reused. Only the real Worker `exit` event proves
owner absence; a closed message port, shutdown acknowledgement, or request to
`worker.terminate()` alone does not. The transaction coordinator retains the database ownership
lock until that exit is observed during an orderly shutdown.

The Worker is created with `trackUnmanagedFds: true`. The storage kernel uses only Node's reviewed
`node:fs` descriptor operations and receives no transferred descriptors or native-addon handles.
The pinned Node runtime must be integration-tested to prove that a raw descriptor deliberately left
open by the Worker is absent from the process descriptor table after forced Worker exit. That proof
does not cover an uninterruptible Linux D-state syscall, which remains a whole-Server and host
failure rather than a bounded-recovery claim.

The artifact-storage Worker shares the Server process lifetime, so this design introduces no
child-process or artifact-specific cgroup contract. A storage failure whose outcome is fatal or
indeterminate triggers whole-Server fail-stop. If the storage Worker does not exit within its
bounded termination window, the composed Server must stop coordinating further shutdown work and
terminate as a whole; the external process supervisor may start a replacement only after the old
Server process has exited. Production enablement therefore requires a composed lifecycle proof over
the real Server: client admission becomes unavailable synchronously, the bound coordinator reaction
propagates fail-stop, queued and active artifact mutations settle or fail within their bounds, the
storage Worker exits before SQLite closes and the owner lock is released during orderly shutdown,
and every fatal storage path terminates the complete Server.
It does not require a child-specific systemd unit, cgroup cleanup proof, or installed-profile
verifier.

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

After an upload is committed, its staging cleanup may already be durable. A committed chunk replay
therefore verifies the requested range against the complete immutable CAS object identified by the
database prepare result; it never requires or recreates staging data.

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

A committed finalization replay similarly verifies the immutable CAS object directly before the
database replay phase. It does not call publication again and does not depend on a staging file that
the cleanup journal is already authorized to remove.

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

Migration `0011_artifact_namespace_cleanup.sql` provides the durable database foundation for that
scan. A page classification, durable cleanup-intent update, and cursor advance share one
transaction; the database Worker exposes no independent cursor-advance operation. Observations bind
the target and parent inode identities, file ctime, ownership and mode, and any linked immutable
object peer. The dedicated storage owner builds one bounded immutable manifest per scan session and
revalidates the full observation before deleting only a staging or publication-temporary name.
Filesystem traversal remains bounded by the configured storage `hardEntries`; immutable CAS objects
are inspected for namespace integrity but do not consume the separate 65,536-entry cleanup-manifest
limit. Exceeding either explicit bound is fatal rather than being reported as a completed sweep.

The Linux implementation anchors child lookup below an open directory descriptor through
`/proc/self/fd`. Node currently exposes neither `openat2` nor an inode-conditional `unlinkat`, so
this design does not claim `openat2` path-resolution guarantees against a hostile process running
with the same effective user ID. The storage root remains private to the Server user, every lookup
uses server-derived grammar and no-follow opens, and identity is revalidated immediately before
unlink. An unknown unlink or directory-fsync outcome terminates the storage owner.

Artifact HTTP routes and artifact-mode completion remain disabled in this slice. The internal
transaction foundation now places create, chunk, finalization, termination, and reconciliation
under one cancellable, bounded Server-process mutation gate. A writer holds the gate from before its
database prepare through its filesystem durability phase and final database commit or definitive
failure. A reconciliation pass holds the same gate while a filesystem manifest session is active,
through every page classification and the session's final or explicit close. Upload and namespace
cleanup cannot run between pages of that manifest.

One manifest session has an independent page bound and one fixed page size. The page size and the
effective page count are chosen so their product never exceeds the namespace cleanup batch that the
same pass can drain. Classification therefore cannot create cleanup authority faster than a healthy
pass consumes it. Reaching the bound explicitly closes the storage scan, preserves the last
transactionally classified database cursor, and releases the gate. A later pass creates a new
manifest and resumes after that durable cursor. This retains the non-starving wrap semantics without
allowing a writer to mutate a file represented by a still-active immutable manifest. Page I/O yields
the event loop, and the session boundary allows FIFO writer admission; the absolute pass deadline
remains the fail-stop bound for an already dispatched unknown outcome.

`DatabaseClient`, `ArtifactStorageClient`, and `DatabaseOwnerLock` each issue one opaque transaction
handle. After a handle is consumed, the original owner cannot directly dispatch artifact database
operations, mutate or close storage, request database shutdown, or release the owner lock. An
unconsumed handle can be revoked only by its original owner as part of orderly abandonment. The
top-level transaction coordinator is the only consumer and owns readiness, fatal propagation, and
the close order: stop admission, close reconciliation and any scan session, cancel queued mutation
callbacks, drain the active callback, close and prove storage-owner exit, close SQLite, then release
the owner lock. Database and storage handles also bind terminal-failure signals. A failure observed
during startup or normal operation synchronously poisons admission; normal shutdown does not settle
those signals, and shutdown failures remain governed by the ordered close result. Test-only handle
factories live only inside files excluded by the production TypeScript build. A package-local Node
prebuild validates and removes only `apps/server/dist` before TypeScript runs, so a production build
contains no stale reusable fake-owner adapter and never cleans referenced package outputs.

Readiness is a live state, not merely the settled first-sweep promise. It requires a completed first
namespace sweep, certain capacity accounting, no exhausted or invalid upload-cleanup retry identity,
no failed namespace cleanup, and no operational namespace-health saturation. Fatal and closing
transitions synchronously disable admission. This foundation intentionally has no consumer in
`main.ts`, `app.ts`, Worker routes, claim selection, or Server configuration; production composition
and external reachability require separate reviewed changes.

Namespace cleanup health reads are independently bounded for each status. Saturated pending,
retry-waiting, failed, or due counts are operational saturation: capacity admission becomes
uncertain and the reconciler fail-stops. Saturated completed or superseded counts are historical
saturation only. Historical counters are capped for display without disabling admission or a
healthy reconciliation pass.

If maintenance cannot enter the shared gate before its admission deadline, the last capacity
snapshot is immediately marked uncertain. Already queued mutations recheck readiness before their
first database operation and are rejected, allowing the FIFO to drain so a later maintenance pass
can refresh health. This prevents continuous otherwise-valid traffic from starving reconciliation
while an old healthy snapshot remains authoritative.

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
