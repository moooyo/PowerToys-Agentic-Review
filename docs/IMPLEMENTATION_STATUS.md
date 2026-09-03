# Implementation Status

Status date: 2026-09-04

> ADR 0025 selects per-Worker Bearer Token authentication. The Server and runnable TypeScript
> Worker use that profile and no longer use Worker mutual TLS, certificate binding, Server binding
> receipts, or the dormant signer-host direction. Native ServiceHost bootstrap schema v4 now makes
> the fixed Worker authentication file a Control-only data-root member and selects the Bearer
> client; production composition rejects historical schema v3 before opening any Worker credential.
> Signed outer-package v2 and split installer profile v2 now bind schema-v4 bootstraps without mTLS
> or package credential material; historical v1 remains schema-v3-only. Actual signed release
> material, root materialization/swap, and the production SCM installer remain incomplete. The
> verify-only destination evidence composition is now implemented. Historical
> source and verification evidence remain recorded below, but none of the superseded receipt or
> signer-host paths is a future production-enablement prerequisite.

The repository currently implements the Phase 0 control-plane foundation, the Phase 1a
authenticated read-only GitHub and Dashboard slice, immutable result projections, the static-review
execution components, and the split-service protocol and native Windows composition candidate
described in `ARCHITECTURE.md`. Candidate zero-slot TypeScript role supervisors are now present and
have passed remote Linux source and bundle verification. They have not passed native Windows
verification. The repository remains intentionally fail-closed while execution-capable role
runtimes, the release and installer pipeline, and native Windows runtime evidence are incomplete.

## Implemented

- TypeScript and pnpm monorepo configuration.
- Runtime TypeBox contracts for worker registration, claims, heartbeats, leases, and terminal
  submissions.
- Pure domain state-transition and lease-fencing helpers with focused unit tests.
- Fastify server with a dedicated `node:sqlite` Worker Thread and immutable SQL migrations.
- A separate dedicated `node:worker_threads` artifact-storage owner that keeps synchronous Linux
  filesystem operations off the Fastify event loop and the SQLite Worker, accepts only normalized
  data-only protocol messages, propagates terminal failures, and retains database-owner authority
  until a real storage Worker exit is observed during orderly shutdown.
- A composed artifact runtime in the production Server. Configuration enforces disjoint private
  database and artifact trees plus bounded byte and entry capacity; readiness waits for the first
  reconciliation sweep; one process lifecycle synchronously closes admission and drains Fastify and
  background database work before proving artifact Worker exit, closing SQLite, and releasing the
  owner lock. Fatal artifact failures log only a stable code and terminate the complete Server. A
  separate boolean probe supplies artifact health; the frozen four-method transaction port carries no
  coordinator close, fatal, or owner capability.
- A process-lifetime SQLite owner lock, lock-time migration rechecks, verified pre-migration
  online backups, atomic backup publication, and incomplete-backup cleanup.
- Atomic job claim, lease generation and token fencing, worker and attempt heartbeats, hard and
  no-progress deadlines, terminal submissions, and expired-lease recovery.
- Idempotent terminal completion and failure replay, with token fencing and explicit conflict
  responses for changed payloads or outcomes.
- Per-Worker Bearer authentication backed by a node-level database record with exact
  `pending`/`active`/`revoked` states, a Server-generated 256-bit Token, hash-only persistence,
  transactional create/activate/rotate/revoke operations, and equal management authority for every
  authenticated Dashboard user. Restored database backups intentionally restore the Token state
  captured in the backup, including older active or not-yet-revoked credentials.
- A shared Worker-route authentication boundary that accepts the Token only from the Bearer
  `Authorization` header, derives `workerNodeId` from the database mapping, permits pending Tokens
  only on registration, checks active state on every later request, rejects body identity
  overrides, and fails closed when the authentication database is unavailable.
- Remote Windows worker control loop over Server-authenticated HTTPS with the node Token loaded from
  the fixed canonical plaintext Control configuration file, plus registration, long polling,
  bounded slots, heartbeat commands, monotonic lease watchdogs, drain, and shutdown behavior. The
  Worker no longer loads or presents a TLS client certificate.
- Legacy WinSW deployment templates and a least-privilege, execution-disabled PowerShell installer
  skeleton.
- React and Ant Design Pro operations dashboard for work items, jobs, workers, approvals,
  publications, and system health.
- GitHub webhook HMAC verification, action-specific actor/target normalization, delivery
  deduplication, repository allowlisting, and issue/pull-request lifecycle projection.
- Read-only GitHub REST polling with ETag support, bounded pagination, rate-limit observation,
  durable reconciliation projections, and atomic event-batch plus checkpoint commits.
- Numeric GitHub identity authorization with self/allowlist policy, deny-unknown behavior,
  active request epochs, assignment/review-request removal, and revision inheritance.
- Composite pull-request comparison revisions that include both base and head object IDs.
- Trusted prompt loading, deterministic job envelopes, prompt/schema/config digests, and
  idempotent scheduling tied to immutable revisions and request epochs.
- OIDC Authorization Code plus PKCE BFF authentication, hashed opaque sessions in SQLite,
  subject allowlisting, login rate limiting, same-origin POST login, browser-generation fencing,
  a persistent authentication clock high-water mark, and authenticated Dashboard reads.
- Startup and periodic bounded cleanup for expired login transactions, sessions, and browser
  bindings.
- Production Dashboard HTTP adapter and Server read APIs for work items, jobs, workers, and
  system state.
- Codex static-review launch specifications, bounded JSONL parsing, strict PR/Issue result
  schemas, and canonical result digests in `packages/codex`.
- A strict TypeScript ProcessHost NDJSON client with bounded frames and output buffering,
  negotiated concurrency, replacement environments, abort propagation, hard-timeout handling,
  and fail-closed protocol validation.
- A native Go ProcessHost with suspended Windows process creation, restricted inherited handles,
  Job Object process and memory limits, `KILL_ON_JOB_CLOSE`, bounded output, and complete
  process-tree termination.
- A shared 512 KiB UTF-8 prompt budget enforced by scheduling, the execution envelope, Codex
  launch construction, and the ProcessHost protocol.
- Disposable exact-revision workspaces with anonymous Git fetches, replacement environments,
  attempt-local temporary/profile directories, and trusted OS working directories.
- A static Codex executor with strict-model-compatible output schemas, independent application
  schemas, periodic liveness reporting, bounded JSONL/result handling, and deferred cleanup after
  terminal submission.
- Per-attempt and aggregate workspace reservations, continuous disk monitoring, bounded orphan
  discovery, and fail-closed native adapter contracts for exclusive ownership and handle-bound
  deletion.
- Stable TLS-material reads, pinned executable verification, and a complete immutable installation
  manifest contract that requires native NTFS, DACL, reparse-point, and handle-identity evidence.
- Server-side authoritative result validation and immutable SQLite projections for pull-request
  findings and issue triage, committed atomically with the successful run and job transition.
- Server-only artifact-backed completion behind the durable attempt mode. The strict terminal
  request union has no caller mode selector; completion performs a read-only fenced database
  prepare, a bounded verified CAS read, strict UTF-8/JSON/schema and canonical-digest validation,
  and a final fenced transaction that commits the immutable artifact binding, result projection,
  attempt, and job together. Exact terminal replay rebuilds the stored response through the strict
  public schema and does not reread storage.
- A production identity-boundary decision that represents one logical Worker as separate Control
  and Executor Windows services connected by signed short-lived capabilities over a protected
  Named Pipe.
- A strict Control-Executor local protocol package with bounded ARWX framing, canonical JSON,
  lease-token-free Executor envelopes, P-256 low-S capabilities, exact renewal chains, boot-lifetime
  replay tombstones, streamed artifacts, terminal disposition, and attempt-level resource limits.
- A Control-side local execution boundary that projects Server envelopes into deeply frozen,
  lease-token-free Executor envelopes; snapshots the lease authority basis; binds artifact streams
  to the complete session and attempt context; and maps identity-checked Server terminal responses
  to local terminal dispositions.
- Runtime-authenticated local capability and renewal proofs, monotonic hard-deadline budgeting,
  permanent stale/cancel/terminal fences, strict snapshot projections, attempt-opaque issue revision
  bindings, verified terminal artifact provenance, and cancellation facades that cannot expose an
  `AbortSignal` reason to the local transport.
- A source-only, import-free single-attempt lifecycle reducer. It snapshots attempt identity,
  synchronously latches the first stop, joins verified terminal and zero-process facts, and orders one
  disposition and cleanup result. It is hash-pinned but has no production consumer or runtime effect
  adapter and is explicitly not an authority boundary. Its structured-data contract rejects
  non-plain objects, accessors, symbols, non-enumerable properties, and extra fields; hostile Proxy
  objects remain outside the caller contract so the reducer can retain a zero-import boundary.
- A fail-closed Go ServiceHost foundation with canonical role configuration, role-specific
  replacement environments, structural ARWX framing, byte-bounded bidirectional relay, bounded
  shutdown, a composed Windows platform adapter, and an explicitly unavailable non-Windows adapter.
- A schema-v2 dual-root release manifest shared by TypeScript and Go, with canonical cross-language
  digests, closed installation and trusted-configuration trees, separately hashed bootstrap
  configurations, strict role/root/content rules, and typed config-binding evidence.
- Reviewed Windows ServiceHost building blocks for first-instance, remote-rejecting Named Pipes;
  handle-relative configuration traversal; exact restricted virtual-service token verification;
  persisted non-exportable CNG P-256 local-capability signing; strict fixed-profile Worker Bearer
  loading; stable pipe-peer process and token verification; canonical role-local RPC; fixed-origin
  TLS 1.3 transport; stable WinSW observation; and suspended Node launch into a non-breakaway root
  Job. Bootstrap schema v4 selects the fixed canonical authentication profile and Bearer transport
  for Control, keeps the Token out of preflight evidence and runtime bootstrap, and gives Executor
  no Server transport. `production_windows.go` rejects schema v3 before credential acquisition and
  contains no production `wincert`, mTLS evidence, or legacy `NewClient` path. Signed package v1
  remains schema-v3-only; outer-package v2, installer profile v2, and the retained staged-evidence
  typed gate now accept only the matching schema-v4 pair.
- Exact private-key security-descriptor digests, fixed machine-scope Software KSP policy,
  Control-only key ACL semantics, detached key identities, key-reuse detection inputs, and canonical
  public-SPKI digests for the local Control-to-Executor capability signer. Historical mTLS key
  contracts are no longer part of Worker authentication.
- Pre-resume Node process and primary-token protected DACL application with exact readback, plus
  root-Job drain semantics that retain the lifetime handle whenever zero active processes cannot be
  confirmed.
- A per-launch, single-use HostControl Named Pipe prepared before Node starts and bound to the exact
  retained Node process, with a one-process bootstrap Job limit followed by verified activation of
  the configured process ceiling.
- A production Authenticode verifier that uses the retained file handle, requires one embedded
  SHA-256 primary signature, validates every timestamp countersigner and strong-signature chain,
  binds the exact leaf certificate DER digest, disables network retrieval, and always closes the
  WinTrust state.
- Handle-bound closed-tree installation verification with exact directory re-enumeration, File ID,
  hard-link, ADS, case-mode, reparse-point, content, manifest-role, and Authenticode checks.
- Production Windows installation ACL policy composition. It proves the fixed restricted service
  identity before filesystem access, parses complete self-relative DACLs, applies exact per-role
  read/execute profiles, and accepts only the bounded ambient rights used by standard Windows
  `Program Files` and `ProgramData` ancestors.
- Opaque preflight evidence that consumes concrete installation, local-capability-signing, and
  transport-configuration attestations rather than caller-assembled prerequisite booleans or
  credential identity values.
- A shared 16 MiB claim-response ceiling enforced by both Worker HTTP transport and the Server
  before a lease is committed; oversized stored jobs are dead-lettered without creating an attempt.
- A Windows ServiceHost composition path that connects compiled release authority, secure service
  bootstrap, installation and role-data verification, role-specific credentials, preflight, peer
  verification, runtime bootstrap, HostControl, guarded Node launch, role-local RPC, ARWX relay,
  lifecycle supervision, and bounded cleanup.
- HostControl I/O ownership that keeps overlapped operations, buffers, events, handles, and terminal
  publication ordered through cancellation, ambiguous completion, shutdown, and quarantine paths.
- Claim admission derived only from the role configuration sealed into the committed runtime
  bootstrap. The current foundation configuration disables execution, so Claim is rejected with a
  terminal `OPERATION_NOT_ALLOWED` response before dispatcher or request resources are acquired.
- A full role-activation barrier that keeps runtime handlers and startup side effects dormant until
  the connector returns the exact promoted HostControl owner and passes bootstrap, role, and
  nominal-session validation.
- Candidate Control and Executor zero-slot supervisors. They perform the signed local handshake,
  bind manifest, policy, preflight, node, session, nonce, and boot evidence, and permit Executor to
  publish only `ready=false`, `availableSlots=0`, and `reasonCode=EXECUTION_DISABLED`.
- A claim-free Control shadow adapter that exposes only registration, instance heartbeat, and local
  digest signing. Control registers a maximum of one slot but continuously advertises zero
  available slots and an empty active-lease set.
- Candidate post-dispatch shadow shutdown choreography: Control sends final `Drain`, Executor sends
  final `Drained`, and both role-local HostControl sessions arm and join their bounded transports.
  The Control-only relay asymmetry and HostControl half-close latch are present, but the complete
  choreography remains unverified. Pre-authorization forwarding lets a compromised Control payload
  force a bounded Executor shutdown, but grants no Claim, lease, or execution authority; the native
  attack matrix must explicitly cover this denial-of-service tradeoff.
- A candidate Control-only `ShutdownRequested` HostControl notification from Go to Node. It is
  single-use, bootstrap- and role-bound, serialized with local RPC responses, and carries one Unix
  millisecond deadline that Node maps to a non-extending monotonic deadline. Service cancellation
  keeps Node, HostControl, ARWX standard I/O, and both relays alive until the graceful barrier or
  that deadline; Executor rejects the notification and can shut down only from authenticated
  Control `Drain`.
- A dormant split-installation contract and exact Control/Executor WinSW source inputs. ADR 0013
  freezes enrollment-before-package ordering, clean-host initial installation, physical NTFS roots,
  same-basename wrapper/config payloads, demand-start and no-recovery maintenance fencing, complete
  pair replacement, destination re-verification, and recoverable post-commit SCM policy activation.
  The XML launches only the signed ServiceHost and is not an installer or installation evidence.
- The ADR 0014 trusted-enrollment-record and ADR 0022 through ADR 0024 Server-binding designs remain
  as historical decision records, but their executable TypeScript and Go contracts, persistence,
  coordinator, signer, signer-host, fixtures, and native node-enrollment/verifier packages were
  deleted after ADR 0025 selected simple per-Worker Token authentication.
- Migration `0012_server_binding_persistence_v1.sql` remains immutable compatibility history with a
  pinned SHA-256. Its four legacy tables are inert. The v12/v13 startup test inserts representative
  issuer, authorization, binding, and revocation rows, proves that startup preserves every row, and
  proves that no Worker credential is synthesized from them.
- The broad production runtime-loader and exact reviewed source/API guards formerly hosted by the
  Server-binding contract test now live in `production-source-boundaries.test.ts`. They retain the
  general zero-execution protections while removing the obsolete signer-host spawn allowance and
  every executable Server-binding contract test.
- A closed RoleConfig v2 package profile for the two exact WinSW wrapper and same-basename XML
  paths. Release preparation, finalized-document inspection, outer-index parsing, signing-digest
  construction, admission, and staged verification reject alternate paths or casing, wrong roots or
  roles, missing or duplicate slots, and architecture-field misuse.
- A dormant split-installer transaction-journal contract and pure data-model slice. ADR 0015 freezes
  the fixed namespace, protected single-writer model, journal-first inactive materialization,
  per-effect write-ahead intents, deterministic root-action plans, policy cursors, commit
  roll-forward, and failed-closed matrix. `installtransaction` now provides the exact typed records,
  closed pending-action union, fixed path derivation, strict bounded canonical codec, complete
  single-record validation, non-authorizing next-intent derivation, and a package-private source-only
  observation reducer. The reducer handles exact pending create, populate, and rename observations;
  preserves immutable transaction bindings; advances sequences without wraparound; and withholds
  every phase, SCM-policy, policy-action, and rollback-root evidence gate. No production code
  consumes it, and no journal store, filesystem mutation, SCM adapter, readiness boundary, or
  installer is implemented.
- A source-only, dormant Control result-artifact upload session. It binds one authenticated local
  attempt context to one private Server lease, accepts only the five result lifecycle facts, and
  drives a frozen `create`/`put`/`finalize`/`terminate` port with stable application identities,
  exact frozen request replay, bounded backoff, lease and hard deadlines, shutdown fencing, and
  explicit definitive, ambiguous, or lease-revoked failures. Late ignored-abort settlements cannot
  apply responses after the dispatch is fenced, and ambiguity remains sticky until a valid replay
  succeeds. The public state contains no raw lease token or chunk bytes. No production entrypoint,
  supervisor, barrel, or role bundle consumes this module.
- A split-service SCM policy contract. ADR 0016 fixes both service records, virtual accounts,
  restricted service SID type, one-privilege requirement, protected service-object rights,
  bootstrap query rights, minimal native handle masks, disabled-create then secured demand-start/
  no-recovery pre-start target, full-field maintenance read-back contract, Control-then-Executor
  stop order, and Executor-then-Control start order. It also proves that SCM effects require a new
  transaction-journal schema v2 rather than being hidden behind ADR 0015's v1 policy actions. The
  final delayed-start and restart schedule, failure-action clear ABI, preferred-node behavior,
  protected-DACL publication, preshutdown value, intermediate create-DACL evidence, pinned WinSW
  behavior, schema-v2 production composition, native adapter, and Windows evidence remain explicit
  production commit and rollback blockers.
- A source-only, dormant installer transaction schema-v2 lab. ADR 0020 independently restates the
  v1 filesystem action shapes, fixes the ADR 0016 maintenance, stop, disabled-create/configure, and
  Executor-before-Control start ordinals, and adds an explicit service-configured checkpoint. Every
  SCM plan stops before ordinal 1 at a state-derived checkpoint containing the exact ordered missing
  prerequisites. The schema has no `COMMITTED`, `ROLLED_BACK`, or `applied` value;
  `FAILED_CLOSED` is its only terminal phase. The package-private reducer and observations carry no
  effect authority and has no runtime consumer, filesystem operation, registry operation, SCM
  adapter, or native call. Its only non-test importer is the source-only ADR 0021 store contract;
  protected native storage and native SCM composition remain separate later reviews.
- A source-only dormant cross-version protected-store v2 lab. ADR 0021 permanently reuses the
  physical `writer-v1.lock` and `active-head-v1.json` paths, defines the one-way strict v2 head
  migration and bounded append-only hash-linked entry namespace, and closes entry-before-head
  publication and conservative crash recovery. `internal/installstorev2lab` implements strict
  ordinary Head, Predecessor, v1 inventory, and Entry codecs, fixed path/sequence derivation,
  package-private A-E/V residue and crash-transition models, opaque zero-value-invalid capability
  shapes, and lifecycle stubs that always return `ErrUnavailable`. It is the sole non-test importer
  of the ADR 0020 lab and has no production consumer. There is no filesystem operation, migration,
  permit issuer, native adapter, available store, or native Windows evidence.
- A source-only Artifact HostControl v2 contract and fixed-origin native transport capability. ADR
  0017 closes the surface to create, chunk, finalize, terminate, and artifact-backed run completion;
  Node supplies only route identities and opaque bounded bodies, while Go derives the exact method,
  path, origin, Server-TLS policy, Bearer authorization, and accepted status. Cross-language golden
  frames, operation-specific
  body and response ceilings, strict Server error parsing, and conservative unknown-outcome handling
  are covered without adding a production consumer. RPC1, RoleConfig v2, release compatibility, all
  entrypoints, and the zero-slot posture remain unchanged.
- Explicit Worker API retryability preservation. A strict Server `ErrorDetails` or decoded
  HostControl error now supplies the authoritative `retryable` bit even when its HTTP status suggests
  the opposite. Malformed error bodies retain the local status fallback. Remote messages, response
  bodies, request bodies, URLs, causes, and lease tokens are not retained on the mapped error.
- Source-only ARWX 1.1 and Job execution envelope v2 contracts. ADR 0018 fixes an exact minor-one
  profile with no compatibility range, requires both raw `resultSha256` and canonical
  `resultDigest` on `Complete`, and binds envelope version two to `result_artifact_v1`. The new
  modules reuse the production framing and version-one envelope constraints without changing their
  source, barrels, Claim schemas, producers, role bundles, or runtime consumers.
- A source-only RoleConfig v3 disabled-execution lab and data-only RuntimeBootstrapV2 lab contract.
  ADR 0019 fixes Control and Executor schemas to zero advertised slots and no execution authority,
  binds the exact dormant HostControl 2.0, ARWX 1.1, Job envelope v2, and artifact completion target,
  and carries the complete activation-blocker tuple. Go and TypeScript share canonical Control and
  Executor RoleConfig and bootstrap goldens. Neither implementation has an acknowledgement, commit,
  exchange, channel, Claim constructor, production import, or role-bundle export.

## Deliberately Disabled

- `WORKER_EXECUTION_ENABLED=true` and the installer `-EnableExecution` option are rejected. The
  native Windows ServiceHost composition is connected, and the Control and Executor TypeScript
  payloads contain a remotely verified zero-slot supervisor candidate. Executor can emit only the
  authenticated disabled `Ready` attestation; Control cannot claim and reports zero available
  slots. A static guard locks both production entrypoints to those supervisors and rejects any
  production import path into the dormant execution modules. The source-only attempt reducer is not
  exported or included in either role bundle and cannot make the zero-execution configuration
  effective. Its focused, full Worker, repository test, typecheck, build, and lint matrices passed on
  Linux `test-env`; this does not substitute for native Windows evidence. Production enablement still
  requires a compiled release profile, split-service packaging and installation, signing, and native
  Windows preflight and attack-test evidence.
- The shadow candidate remains unpublishable. The Go-to-Node shutdown-request bridge and zero-slot
  activation and lifecycle choreography have passed the Linux `test-env` matrices, but not the
  paired native Windows x64 and arm64 service-stop, deadline, partial-frame, race, and
  forced-termination matrix. Go does not synthesize ARWX business frames; Executor shutdown remains
  subordinate to authenticated Control `Drain`.
- Approval persistence, publication, and GitHub writes are not implemented. The production
  Dashboard therefore exposes the Phase 1a read-only surfaces only.
- The bounded Worker result-artifact HTTP adapter is implemented with pre-parse transport
  authentication, strict route/body identity binding, public response allowlists, and stable error
  mapping. `app.ts` is its sole production registrar; for artifact mutations it receives only the
  frozen transaction port from `main.ts`, while a separate boolean probe supplies artifact health.
  The storage Worker, coordinator, reconciler, readiness ownership, close order, and whole-Server
  fail-stop remain owned by the storage runtime and lifecycle. Route availability does not enable the
  data path: production claims still persist `inline_result_v1`, version-one envelopes expose no
  completion mode. The database fence rejects artifact uploads before capacity or filesystem
  mutation and rejects artifact-backed completion before artifact lookup or storage read. The
  Server completion slice is present but default-off and unreachable until a future versioned claim
  envelope and rollout policy select `result_artifact_v1`.
- The dormant Worker Control upload session and Artifact HostControl v2 adapter have no production
  consumer. The v2 codec and native fixed-origin capability are excluded from the legacy, Control,
  and Executor entrypoints; RPC1 rejects v2 and the release manifest still requires
  `serviceHostRpcVersion = 1`. They neither change the version-one ARWX envelope nor submit
  artifact-backed completion in production. Wiring remains forbidden until RPC2 compatibility,
  bootstrap and RoleConfig negotiation, ARWX result-digest versioning, signed matching artifacts,
  native Windows evidence, and a versioned claim envelope complete separate review.
- The dormant ARWX 1.1 and Job execution envelope v2 modules are not exported from package barrels
  and are unreachable from the legacy, Control, and Executor production graphs. Production remains
  fixed to ARWX 1.0 and envelope v1. There is no minor fallback, Claim selection, RoleConfig v3,
  RuntimeBootstrap selection, enabled slot, or runtime consumer. Activation requires an atomic
  matching signed-package upgrade and native mixed-version rejection evidence.
- The RoleConfig v3 and RuntimeBootstrapV2 lab contracts remain permanently blocked under the
  `disabled-execution-lab-v1` profile. Their `protocolVersion = "2.0"` selects only the dormant local
  HostControl RPC2 target; it does not assert Worker API 1.1 or ARWX 1.1 readiness. The derived
  `DisabledReadinessProjection` is not an ARWX Ready message and grants no Ready or Claim authority.
  Production RoleConfig v2, RuntimeBootstrapV1, RPC1, Claim derivation, entrypoints, bundles, and
  release manifests remain source- and graph-pinned.
- The native ProcessHost and ServiceHost sources are present, but signed release binaries and native
  Windows runtime verification are not part of this milestone. Windows `platform.NewHost()` now
  selects the composed runtime. Ordinary builds still contain no compiled production release
  profile and fail closed before using installed configuration; non-Windows builds remain
  unavailable.
- Dynamic validation of untrusted pull-request code remains disabled.
- PR finding paths and line ranges are normalized but are not yet checked against an immutable
  server-side diff manifest; publication must remain disabled until that gate exists.

## Next Milestone

The next Worker step is release integration and native verification for the lifecycle candidate.
The `ShutdownRequested` bridge must run through a paired native Windows x64 and arm64 matrix
covering restart, reconnect, registration loss, heartbeat, drain, deadline, and failure behavior.
That verification must keep
`executionEnabled=false`, preserve the sealed HostControl Claim denial, and confirm that Control
alone owns the fixed Worker Token and Server transport while Executor has no Server, lease,
workspace, ProcessHost, Codex, or Git capability in this shadow milestone.

After the shadow runtime is verified and any findings are closed, the release pipeline must compile
the production release profile, produce signed role bundles and native binaries, and install the two
services, identities, ACLs, local capability-signing key, firewall policy, fixed plaintext Control
authentication profile, and machine-enforced Codex policy through a versioned ADR 0013 transaction.
The repository now has the versioned Token-aware outer-package and installation-profile contracts,
but still needs actual signed release material, root materialization and atomic swap, the production Go installer,
production-capable SCM schema and native adapter, a complete final recovery schedule, authenticated
installer readiness, and a pinned WinSW release. The ADR
0014 receipt reader, ADR 0021 protected receipt store, Server binding signer and trust material,
receipt authority, privileged enrollment writer, and ADR 0024 Linux signer-host matrix are
superseded historical work and are not future gates.
Native Windows x64 and arm64 hosts must then pass the ADR 0007 installation, token, ACL, Named Pipe,
Authenticode, sandbox, Job Object, disk, cancellation, tamper, restart, and attack tests before any
Claim authority is enabled.

The product data path can proceed in parallel by adding the Worker Control upload client while
keeping claim selection default-off, then introducing a versioned claim envelope and rollout policy
before any artifact-mode canary. Immutable server-side diff manifests, publication drafts,
digest-bound approvals, GitHub outbox reconciliation, and Dashboard write actions follow. Dynamic
validation remains a separate stronger-isolation milestone.

## Verification Evidence

On 2026-09-04, the installer destination slice added the only production consumer of
`BearerTokenInstallerV2Package`. The read-only composition accepts no caller-supplied path or
detached authority, borrows an exact one-shot view of the admitted index, envelope, and schema-v4
bootstraps, and reopens all three profile-fixed roots after a future installer swap. It validates
exact path casing, complete tree closure, every signed payload digest and size, exact metadata
index/signature bytes, exact bootstrap bytes, repeated compiled outer admission, role-scoped PE
Authenticode, and retained filesystem
identity/security evidence. The opaque result owns both source and destination handles, refuses
serialization, rejects repeated or post-close use, and propagates staged, native, and destination
cleanup-fatal state. Focused `installerdestination` and `stagedpackage` tests passed locally. This
does not implement archive extraction, candidate materialization, ACL writes, root swap, SCM, CNG
provisioning, readiness, or installer transaction recovery.

On 2026-09-04, the Worker Token release/recovery cleanup added outer-package index/profile v2,
split installer profile v2, schema-v4 admission, the retained staged-evidence typed installer gate,
and the fixed-path SecureString provisioning helper while keeping signature envelope/domain v1 and
historical outer-package v1 unchanged. It deleted 47 tracked files from the retired Server-binding,
signer-host, contracts, native verifier, and node-enrollment implementation island while retaining
migration 0012 and representative four-table v12/v13 compatibility coverage. The six-case recovery
matrix and `docs/operations/worker-token-recovery.md` cover lost create/rotate responses,
cross-restart revocation, snapshot rollback reconciliation, post-backup node loss, and pre-v13
restore. Local verification passed lint over 314 files, all-workspace typecheck and build, Dashboard
48/48, Server 235/235, Contracts 8/8, Worker 908/908 plus role guards 19/19, and a clean native-WSL
database/recovery matrix 170/170. Native focused package tests, `go vet ./...`, Windows amd64 and
arm64 builds, and PowerShell canonical/noncanonical/plaintext-input plus privilege-restoration smoke
checks passed. Physical ProgramData replacement remains part of the production installer lab. No
command used
`test-env`; Node 26.1.0 continued to emit the repository engine warning.

On 2026-09-04, the Worker Token follow-up completed the authenticated credential roster and
Dashboard create, rotate, revoke, copy, and one-time reveal flow; native schema-v4 Token composition;
and removal of the superseded Server binding coordinator from the production storage lifecycle.
Token-only database startup now preserves dormant migration-0012 rows without requiring a receipt
signer or creating an implicit Worker credential. Local verification passed all-workspace lint over
334 files, typecheck, and build; Dashboard 48/48; the Server Token and credential route matrix
235/235; Contracts 28/28; historical coordinator and persistence tests 50/50; Worker unit tests
908/908 plus role and architecture guards 19/19; a clean local WSL database matrix 164/164;
native focused tests, all-package
compilation, and `go vet ./...`;
and Windows amd64 and arm64 cross-builds. Browser verification covered desktop and 390-pixel layouts,
clipboard copy, and removal of the revealed Token from the DOM after closure. No command used
`test-env`; Node 26.1.0 continued to produce the repository engine warning.

On 2026-09-04, the per-Worker Bearer Token implementation completed explicitly authorized local
verification without using `test-env`. All-workspace lint, typecheck, and build passed; the Server
Token, configuration, rate-limit, Worker-route, and artifact-route matrix passed 185 tests with 5
platform skips; the Worker passed 908 unit tests plus 19 role and architecture guards; and the
database migration, startup, backup, Token state, and artifact matrix passed 156/156 from a clean
local WSL dependency installation. Focused native Worker transport, Control RPC, artifact RPC,
configuration, preflight, platform, and data-root tests and vet passed, and every native Go package
compiled on Windows. Independent reviews found no remaining P0-P2 findings after canonical-profile
and operation-specific Server-error mapping fixes. The full local workspace test was also attempted:
the Server's 97 failures were confined to its deliberate POSIX database-owner guard and the
superseded Linux signer-host real-child suite. The local Node runtime was 26.1.0 rather than the
required `>=24.20.0 <25`, so pnpm emitted an engine warning.

On 2026-09-03, the dormant Server binding persistence v1 slice completed its explicitly authorized
local Windows verification. No command was run on `test-env`. With pnpm 11.24.0, the exact candidate
passed all-workspace typecheck and build, including Dashboard Webpack, Worker bundles, and Server
output; Biome checked 312 files; Contracts passed 27/27; the nine-file S0/S1, persistence, shutdown,
health, artifact, and runtime-focused matrix passed 174 tests with 6 platform skips; the focused
DatabaseClient capability matrix passed 5 tests with 66 unrelated tests skipped; the database
startup owner-exit helper passed with 9 unrelated tests skipped; and Worker role-bundle plus
zero-execution architecture verification passed 19/19. Independent final reviews found no remaining
P0-P2 findings after the clock, transaction, settlement, signer, handle-ownership, lifecycle, and
production-reachability fixes.

The local Node runtime was 26.1.0 while repository engines require `>=24.20.0 <25`, so pnpm emitted
an engine warning. The complete database-startup and migration-backup files were attempted locally;
their POSIX ownership cases failed closed on Windows as designed (6 failed, 4 passed, 7 skipped).
Those platform failures were not waived as Linux evidence, and no remote replacement run was made
because this task explicitly authorized local verification instead of `test-env`.

On 2026-09-03, the source-only signer-host A1 protocol and lifecycle foundation completed its
explicitly authorized local Windows verification. No command was run on `test-env`. All-workspace
typecheck and build passed, including Dashboard Webpack, Worker bundles, and Server output; Biome
checked 316 files. The protocol, lifecycle, and Server binding architecture matrix passed 53/53.
The non-platform Server selection passed 680 tests with 36 skips across 45 files, and the remaining
supported Worker-route cases passed 23 tests with one excluded baseline case. Codex passed 86,
local-protocol 92, Contracts 27, Domain 21, Worker 897, and Worker role-bundle/zero-execution guards
19 tests.

The complete local workspace test was also attempted and is not reported as passing; the exact
final Server rerun was 712 passed, 43 skipped, and 86 failed. Eighty-five failures came from five
existing database/backup suites whose secure ownership path requires POSIX behavior unavailable on
Windows.
The remaining deep-JSON Worker-route assertion returned 409 instead of 413 under unsupported Node
26.1.0 and reproduced unchanged on the pre-A1 `main` source. These failures were neither changed nor
waived as Linux or supported-Node evidence. A1 remains source-only and does not claim child-process,
real-exit, or Linux transport verification.

On 2026-09-03, the dormant signer-host A2 direct-child client, unavailable profile, source-excluded
fixture, and production-reachability guards completed their explicitly authorized focused local
Windows verification. No command was run on `test-env`. The signer-host protocol, reducer, profile,
fake-process, real-child, and Server binding architecture matrix passed 88 tests. All-workspace
typecheck and build passed, including Dashboard Webpack, Worker bundles, and Server output; Biome
checked 321 files. The built Server tree contained no signer-host fixture basename, scenario
selector, private-key marker, or fixture stderr marker. The local runtime was Node 26.1.0 while
repository engines require `>=24.20.0 <25`, so pnpm emitted an engine warning. These results exercise
generic Node child lifecycle behavior on Windows; they are not evidence for Linux signals, process
reaping, credentials, executable ownership, cgroups, or parent-death semantics. ADR 0025 later
cancelled that Linux signer-host verification requirement.

On 2026-09-03, the dormant signer-host A3 source bridge was implemented between the A2 direct-child
client and the existing S1 signer/coordinator ownership model. The host-provider remains
package-private with zero production consumers, while the production provider, host-profile, and
trust loaders remain unavailable and `main.ts` cannot reach the bridge. Local verification was
explicitly authorized and no command was run on `test-env`. The nine-file signer-host, provider,
signer, coordinator, and architecture matrix passed 153/153; all-workspace typecheck and build
passed; Biome checked 323 files; and the built Server tree contained none of four pinned fixture,
scenario, private-key, or stderr markers. Independent final reviews found no remaining P0-P2
findings. The local runtime was Node 26.1.0 while the repository requires `>=24.20.0 <25`, so pnpm
emitted an engine warning. These local results are not Linux evidence; ADR 0025 later cancelled the
ADR 0024 Linux process matrix because signer-host is no longer a production direction.

On 2026-09-02, the source-only package-private installer observation reducer completed the full
ServiceHost Go 1.26.7 unit, race, and vet suites on Linux `test-env`. The exact source also compiled
the focused `installtransaction` test binary for Windows amd64 and arm64, and both architectures
completed all-package builds and cross-platform vet. The reducer remains unexported and has no
production consumer; every idle phase, pending SCM policy action, policy-plan continuation, and
final rollback-root verification returns an external-evidence requirement without publishing a
successor record. No validation ran on the local Windows machine. These checks prove pure reduction,
binding, overflow, and source-compatibility behavior only; they are not journal durability,
filesystem mutation, destination verification, SCM, readiness, or native Windows runtime evidence.
An independent final static review found no remaining P0-P2 issues in this reducer slice.

On 2026-09-02, integration commits `c34d377` and `1f64c20` combined the live fenced artifact
routes and dormant installer-transaction model. The exact merged source completed the full
TypeScript typecheck, test, build, and lint matrix on `test-env` with Node.js 24.20.0 and pnpm
11.24.0. It passed 86 Codex tests, 84 local-protocol tests, 21 domain tests, 813 Worker tests plus
15 role-bundle and zero-execution architecture tests, and 695 Server tests in 45 files. Biome
checked 284 files. The exact installer-model source separately passed focused and all-package Go
1.26.7 unit, race, and vet suites, plus Windows amd64 and arm64 all-package test compilation,
builds, and cross-platform vet before its conflict-free merge. Independent reviews found no
remaining P0-P2 issues. No validation ran on the local Windows machine. These results keep normal
claims inline and do not constitute native Windows installer, signing, or execution evidence.

On 2026-09-02, integration commit `edd92c0` combined the RoleConfig v2 zero-slot shadow branch and
the dark artifact-storage branch without source conflicts; only this status document required a
union of their independent evidence sections. The exact merged source completed the full
TypeScript matrix on `test-env` with Node.js 24.20.0 and pnpm 11.24.0. It passed 86 Codex tests, 84
local-protocol tests, 21 domain tests, 813 Worker tests plus 15 role-bundle and zero-execution
architecture tests, and 693 Server tests in 45 files. The Dashboard, Worker, Server, and shared
packages built successfully, and Biome checked 284 files.

The same merged source completed ServiceHost and ProcessHost Go 1.26.7 unit, race, and vet suites.
Every package compiled as Windows amd64 and arm64 test binaries, both architectures passed cross-
platform `go build` and `go vet`, and no validation ran on the local Windows development machine.
This merge gate proves source compatibility and preserves zero execution; it is not signed-package,
installer, or native Windows runtime evidence.

After pre-installer trust contracts were merged at `f4ca0ce`, the exact combined source repeated the
full TypeScript typecheck, test, build, and lint matrix with the same passing counts. The first test
attempt correctly returned `ARTIFACT_STORAGE_CAPACITY` when the shared `test-env` root filesystem
reported zero available blocks after repeated cross-builds. Removing only this task's generated test
binaries and Go build cache restored 1.5 GiB of available space; the real storage-Worker integration
then passed five consecutive focused runs and the complete 693-test Server suite. This was an
observed fail-closed capacity condition, not a waived test failure.

On 2026-09-02, the artifact storage owner was changed from an OS child process to a dedicated Node
Worker Thread and verified on the remote Debian `test-env` host with Node.js 24.20.0 and pnpm
11.24.0. No validation ran on the local Windows development machine. The exact candidate completed:

```text
pnpm install --frozen-lockfile --prefer-offline
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

The final run passed 86 Codex tests, 84 local-protocol tests, 21 domain tests, 651 Worker tests plus
9 role-bundle verifier tests, and 650 Server tests in 40 files. Biome checked 265 files. The real
Linux Worker integration proved normal storage operations, shutdown, forced termination of an
`Atomics.wait` stall, a real nonzero Worker exit, and cleanup of a deliberately unclosed
`openSync` descriptor through `trackUnmanagedFds: true`. It does not claim D-state coverage. The
local and remote nine-file code manifests matched at SHA-256
`76f9b70f685fc9a3d440000a37302179aefc434032c933e3564d54c4807f6e62`; the three former
`artifact-storage-process` source and test files were absent on both sides. Independent final
review reported no P0-P2 findings for this transition.

On 2026-09-02, the composed dark artifact runtime completed a fresh full matrix on `test-env` with
Node.js 24.20.0 and pnpm 11.24.0:

```text
pnpm install --frozen-lockfile --prefer-offline
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

The run passed 86 Codex tests, 84 local-protocol tests, 21 domain tests, 651 Worker tests plus 9
role-bundle verifier tests, and 693 Server tests in 45 files. Biome checked 275 files. Real Server
smoke tests started the composed runtime with private, disjoint database and artifact trees,
observed coarse `200` liveness and readiness, confirmed the artifact upload route remained `404`,
performed a clean `SIGTERM` exit, and restarted with the same roots. A second smoke injected an
unknown staging entry after readiness; periodic reconciliation logged exactly one stable
`ARTIFACT_TRANSACTION_STORAGE_INTEGRITY` code and terminated the complete Server with exit code 1.
After the entry was removed, the same database and artifact roots restarted and shut down cleanly,
proving owner-lock release across both graceful and fatal paths. No validation ran on the local
Windows development machine.

On 2026-09-02, the generation-one enrollment-record contract and exact WinSW package slots completed
a fresh ServiceHost matrix on `test-env` with Go 1.26.7: full unit tests, race tests, and `go vet`,
followed by all-package Windows amd64 and arm64 builds, test-binary cross-compilation, and cross-
platform vet. Independent reviews found no remaining P0-P2 issues in the enrollment contract, WinSW
profile, or ADR 0015 state and recovery model. No validation ran on the local Windows machine. The
Windows enrollment reader still returns `ErrUnavailable`; these results are contract and
cross-compilation evidence, not enrollment, installation, signing, or native runtime evidence.

On 2026-09-02, the dormant `installtransaction` model completed the full ServiceHost matrix on
`test-env` with Go 1.26.7: all-package unit, race, and vet suites, followed by Windows amd64 and
arm64 all-package test compilation, builds, and cross-platform vet. The exact package also passed
focused unit, race, and vet runs. Independent review found no remaining P0-P2 issues. No validation
ran on the local Windows machine. This proves the pure codec, validation, path, and next-intent
contracts only; it is not Windows journal durability, filesystem mutation, SCM, readiness, or
installer runtime evidence.

The 2026-09-02 ADR 0013 and split WinSW input snapshot was transferred to `test-env` as a four-file
archive. Its local and remote SHA-256 was
`5f0025814efa8e7bed9c9c3e7e832abaf7035433a07a29b6d7a5d70aa5634723`. Both XML documents parsed
successfully and a remote semantic check confirmed their exact IDs, ServiceHost executable and
bootstrap paths, working directory, dependency, stop timeout, log roots, and absence of environment,
service-account, start-mode, delayed-start, failure-action, and execution fields. Independent final
review reported no P0-P2 findings. This is source-input verification, not native Windows installation
evidence.

The earlier Phase 1a, local-protocol, and fail-closed ServiceHost security-contract candidate was
verified on the remote Debian `test-env` host with the official Node.js 24.20.0 Linux distribution.
Its archive checksum was validated against the Node.js release `SHASUMS256.txt`, and pnpm 11.24.0
was provided through Corepack. No test, build, validation suite, or runtime probe was run on the
local Windows development machine. The TypeScript counts below are the historical 2026-08-31
snapshot. The 2026-09-02 zero-slot supervisors, full-activation barrier, bundle policy, entrypoint
architecture guard, and lifecycle changes have since passed exact-source Linux `test-env` focused,
Worker, typecheck, build, and lint matrices. Those remote results are not native Windows evidence and
do not make the candidate publishable without actual signed material, a production installer, and
physical installation evidence.

The following TypeScript commands completed successfully for the historical combined candidate on
2026-08-31:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Combined TypeScript test results:

- 749 tests passed: 201 Server tests, 383 Worker tests, 86 Codex package tests, 58 local-protocol
  tests, and 21 domain tests.
- Database integration coverage includes atomic multi-worker claims, lease fencing, lease expiry,
  superseded worker instances, heartbeats, idempotent terminal replay, migration backups,
  single-owner locking, startup-failure cleanup, and canonical digest validation.
- GitHub coverage includes webhook HMAC verification, delivery deduplication, event normalization,
  actor authorization, revision inheritance, ETag polling, conservative incomplete-result handling,
  permanent historical-item errors, and atomic projection/checkpoint reconciliation.
- Authentication coverage includes OIDC session persistence, browser-generation fencing,
  out-of-order callback and logout races, database-authoritative expiry, clock rollback resistance,
  subject allowlisting, login rate limiting, origin-checked login/logout, and the guarded loopback
  development bypass.
- The Dashboard, Server, shared packages, and bundled Worker all built successfully. The Windows
  Worker artifact is `apps/worker/dist/worker.mjs` and includes its non-native runtime dependencies.
- The combined candidate used Node.js 24.20.0 and pnpm 11.24.0 on `test-env`; Biome checked 184
  files without applying changes.

The native ProcessHost completed the following checks with Go 1.26.7 on `test-env`:

```text
go test -count=1 ./...
go test -count=1 -race ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build -trimpath
GOOS=windows GOARCH=arm64 go build -trimpath
GOOS=windows GOARCH=amd64 go test -c ./internal/host
GOOS=windows GOARCH=arm64 go test -c ./internal/host
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=windows GOARCH=arm64 go vet ./...
```

The 2026-08-31 fail-closed ServiceHost foundation completed these checks with Go 1.26.7 on
`test-env`:

```text
go test -count=1 ./...
go test -count=1 -race ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build -trimpath
GOOS=windows GOARCH=arm64 go build -trimpath
GOOS=windows GOARCH=amd64 go test -c <each ServiceHost package>
GOOS=windows GOARCH=arm64 go test -c <each ServiceHost package>
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=windows GOARCH=arm64 go vet ./...
```

On 2026-09-01, the ServiceHost candidate through commit `2b8c7d6` completed a fresh remote Debian
`test-env` Go unit, race, and vet matrix plus Windows amd64 and arm64 package cross-compilation and
vet checks. That matrix covers the hardened HostControl ownership, sealed zero-execution Claim gate,
and composed Windows platform source. The Windows checks compiled and analyzed Windows code; they
did not execute it and are not native Windows runtime security evidence. No new TypeScript test
count is claimed for this native-only candidate.

Runtime smoke results:

- An earlier Server smoke run, before migration 0006, started against a fresh database, migrated it
  to schema version 5, reported SQLite 3.53.4, returned HTTP 200 from readiness, served the built
  React application for an SPA route, and shut down cleanly after the smoke run.
- Anonymous Dashboard API access returned 401. Login by GET returned 404, POST without the exact
  Origin returned 403, and the same-origin loopback development login returned 303 and
  established an HttpOnly SameSite session; authenticated session, system, and work-item reads
  returned 200; same-origin logout returned 204 and invalidated the session.
- A second Server using the same database path exited with code 1 while the owning Server remained
  ready; the owner then released the lock during a clean SIGTERM shutdown.
- An earlier, now-historical production mutual-TLS test returned 401 without a client certificate,
  200 for a valid certificate bound to the claimed worker node, and 403 when that certificate
  claimed a different worker node. ADR 0025 replaced this authentication path.

Not yet verified:

- The Worker service, WinSW template, and installer have not been exercised on a Windows test
  machine.
- The native ProcessHost has compile-time and non-Windows protocol/lifecycle verification, but its
  Windows process creation, Job Object, descendant termination, and resource limits have not been
  exercised on a Windows test machine. ServiceHost contracts and Windows building blocks compile for
  x64 and arm64, but their Named Pipe, CNG local-capability signer, filesystem, process/token DACL,
  root Job, wrapper-watch, fixed Worker authentication profile, Server-certificate verification,
  role-local RPC, and fixed-origin HTTPS behavior has not been exercised on a native Windows test
  machine. The production Authenticode and
  installation-verification code has only fake-provider execution plus Windows cross-compilation;
  real signed PE fixtures and Windows ABI checks remain release gates. The native platform
  composition is connected, and the TypeScript zero-slot supervisors have passed the remote Linux
  source and bundle matrix but have not been exercised on native Windows. The native Control-only
  relay asymmetry, Control HostControl half-close latch, and shutdown-request bridge also lack native
  Windows verification.
  Executor's candidate emits only the disabled ARWX `Ready`; ordinary builds have no production
  release profile, Claim remains denied, and the real Codex executor
  remains disconnected from the production entrypoint.
- Real GitHub and external OIDC-provider integration were not exercised; their HTTP boundaries are
  covered with controlled test doubles and the local runtime smoke used the development auth mode.
- Browser-level visual and interaction testing was not run because the remote test environment has
  no browser runtime.
