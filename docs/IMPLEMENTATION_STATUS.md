# Implementation Status

Status date: 2026-09-02

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
- A process-lifetime SQLite owner lock, lock-time migration rechecks, verified pre-migration
  online backups, atomic backup publication, and incomplete-backup cleanup.
- Atomic job claim, lease generation and token fencing, worker and attempt heartbeats, hard and
  no-progress deadlines, terminal submissions, and expired-lease recovery.
- Idempotent terminal completion and failure replay, with token fencing and explicit conflict
  responses for changed payloads or outcomes.
- HTTPS worker authentication using client-certificate validation and an explicit certificate
  fingerprint-to-worker-node binding.
- Remote Windows worker control loop with mTLS, registration, long polling, bounded slots,
  heartbeat commands, monotonic lease watchdogs, drain, and shutdown behavior.
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
  handle-relative secure configuration traversal; exact restricted virtual-service token
  verification; persisted non-exportable CNG P-256 signing; Local Machine certificate-store mTLS
  acquisition; stable pipe-peer process and token verification; canonical role-local RPC;
  fixed-origin TLS 1.3 transport; stable WinSW observation; and suspended Node launch into a
  non-breakaway root Job.
- Exact private-key security-descriptor digests, fixed machine-scope Software KSP policy, Control-only
  key ACL semantics, detached key identities, key-reuse detection inputs, and canonical public-SPKI
  digests for both mTLS and local-authority signing paths.
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
- Opaque preflight evidence that consumes concrete installation, CNG, and certificate attestations
  rather than caller-assembled prerequisite booleans or credential identity values.
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
- Bounded artifact upload and artifact storage are not implemented yet.
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
alone owns Server and mTLS authority while Executor has no Server, lease, workspace, ProcessHost,
Codex, or Git capability in this shadow milestone.

After the shadow runtime is verified and any findings are closed, the release pipeline must compile
the production release profile, produce signed role bundles and native binaries, and install the two
services, identities, ACLs, keys, firewall policy, and machine-enforced Codex policy through the
ADR 0013 transaction. The repository still needs trusted enrollment evidence, destination evidence,
the production Go installer and journal, authenticated installer readiness, and a pinned WinSW
release. Native Windows x64 and arm64 hosts must then pass the ADR 0007 installation, token, ACL,
Named Pipe, Authenticode, sandbox, Job Object, disk, cancellation, tamper, restart, and attack tests
before any Claim authority is enabled.

The product data path can proceed in parallel in this order: bounded result-artifact upload and
storage, immutable server-side diff manifests, publication drafts, digest-bound approvals, GitHub
outbox reconciliation, and Dashboard write actions. Dynamic validation remains a separate
stronger-isolation milestone.

## Verification Evidence

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
- An earlier ephemeral production TLS test returned 401 without a client certificate, 200 for a
  valid certificate bound to the claimed worker node, and 403 when that certificate claimed a
  different worker node.

Not yet verified:

- The Worker service, WinSW template, and installer have not been exercised on a Windows test
  machine.
- The native ProcessHost has compile-time and non-Windows protocol/lifecycle verification, but its
  Windows process creation, Job Object, descendant termination, and resource limits have not been
  exercised on a Windows test machine. ServiceHost contracts and Windows building blocks compile for
  x64 and arm64, but their Named Pipe, CNG, filesystem, process/token DACL, root Job, wrapper-watch,
  certificate store, secure configuration, peer verification, role-local RPC, and fixed-origin mTLS
  behavior has not been exercised on a native Windows test machine. The production Authenticode and
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
