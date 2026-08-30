# Implementation Status

Status date: 2026-08-31

The repository currently implements the Phase 0 control-plane foundation, the Phase 1 read-only
GitHub ingestion and immutable-result vertical slices, the static-review execution components, and
the first split-service protocol and native-host foundations described in `ARCHITECTURE.md`. It is
intentionally fail-closed where the production Windows identity and native filesystem security
boundaries are not yet complete.

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
- WinSW deployment templates and a least-privilege PowerShell installer skeleton.
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
- A fail-closed Go ServiceHost foundation with canonical role configuration, role-specific
  replacement environments, structural ARWX framing, byte-bounded bidirectional relay, bounded
  shutdown, and explicit unavailable Windows/non-Windows platform adapters.
- Reviewed but not yet platform-wired Windows ServiceHost building blocks for first-instance,
  remote-rejecting message-mode Named Pipes; persisted non-exportable CNG P-256 signing; handle-bound
  NTFS file and directory evidence; fixed-origin TLS 1.3 Worker API transport using a caller-supplied
  signer; stable WinSW wrapper observation; and suspended Node launch into a non-breakaway root Job.
- Pre-resume Node process and primary-token protected DACL application with exact readback, plus
  root-Job drain semantics that retain the lifetime handle whenever zero active processes cannot be
  confirmed.
- A shared 16 MiB claim-response ceiling enforced by both Worker HTTP transport and the Server
  before a lease is committed; oversized stored jobs are dead-lettered without creating an attempt.

## Deliberately Disabled

- `WORKER_EXECUTION_ENABLED=true` and the installer `-EnableExecution` option are rejected. The
  execution components are implemented, but production enablement requires the ADR 0007 split
  Control/Executor services, the Windows portion of `AgenticReview.ServiceHost.exe`, native
  installation/workspace security adapters, and Windows preflight evidence.
- Approval persistence, publication, and GitHub writes are not implemented. The production
  Dashboard therefore exposes the Phase 1 read-only surfaces only.
- Bounded artifact upload and artifact storage are not implemented yet.
- The native ProcessHost and ServiceHost sources are present, but signed release binaries and
  native Windows runtime verification are not part of this milestone. The new ServiceHost Windows
  primitives remain unreachable from the production platform factory. Secure configuration and
  complete ancestor validation, service-token verification, peer lineage/image/signature checks,
  certificate-store integration, role-local RPC, and the final orchestration layer are not yet
  implemented.
- Dynamic validation of untrusted pull-request code remains disabled.
- PR finding paths and line ranges are normalized but are not yet checked against an immutable
  server-side diff manifest; publication must remain disabled until that gate exists.

## Next Milestone

The next vertical slice should wire the reviewed ServiceHost primitives behind the Windows platform
factory, add the secure configuration and peer-verification adapters, build separate Control and
Executor TypeScript bundles, and connect the static executor in zero-slot shadow mode. The Control
bundle must exclusively own Server lease tokens and fixed-origin mTLS; the Executor bundle must
exclusively own Codex, Git, workspaces, and execution credentials. The slice must pass native
Windows token, ACL, Named Pipe, sandbox, Job Object, disk, cancellation, and tamper tests before
claims are enabled. Bounded artifact upload and immutable diff manifests should follow, then
publication drafts, digest-bound approvals, GitHub outbox reconciliation, and Dashboard write
actions. Dynamic validation remains a separate stronger-isolation milestone.

## Verification Evidence

The Phase 1a, local-protocol, and fail-closed ServiceHost-foundation candidate was verified on the
remote Debian `test-env` host with the official Node.js 24.20.0 Linux distribution. Its archive
checksum was validated against the Node.js release `SHASUMS256.txt`, and pnpm 11.24.0 was provided
through Corepack. No test, build, validation suite, or runtime probe was run on the local Windows
development machine.

The following TypeScript commands completed successfully for the combined candidate on 2026-08-31:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Combined TypeScript test results:

- 741 tests passed: 201 Server tests, 375 Worker tests, 86 Codex package tests, 58 local-protocol
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
```

The fail-closed ServiceHost foundation completed these checks with Go 1.26.7 on `test-env`:

```text
go test -count=1 ./...
go test -count=1 -race ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build -trimpath
GOOS=windows GOARCH=arm64 go build -trimpath
GOOS=windows GOARCH=amd64 go test -c ./internal/cng
GOOS=windows GOARCH=arm64 go test -c ./internal/cng
GOOS=windows GOARCH=amd64 go test -c ./internal/winfile
GOOS=windows GOARCH=arm64 go test -c ./internal/winfile
GOOS=windows GOARCH=amd64 go test -c ./internal/winpipe
GOOS=windows GOARCH=arm64 go test -c ./internal/winpipe
GOOS=windows GOARCH=amd64 go test -c ./internal/winprocess
GOOS=windows GOARCH=arm64 go test -c ./internal/winprocess
```

Runtime smoke results:

- The Server started against a fresh database, migrated it to schema version 5, reported SQLite
  3.53.4, returned HTTP 200 from readiness, served the built React application for an SPA route,
  and shut down cleanly after the smoke run.
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
  and fixed-origin mTLS behavior has not been exercised on a native Windows test machine. The
  secure configuration reader, peer verifier, role-local RPC, and production platform composition
  are still missing, so the real Codex executor remains disconnected from the production entrypoint.
- Real GitHub and external OIDC-provider integration were not exercised; their HTTP boundaries are
  covered with controlled test doubles and the local runtime smoke used the development auth mode.
- Browser-level visual and interaction testing was not run because the remote test environment has
  no browser runtime.
