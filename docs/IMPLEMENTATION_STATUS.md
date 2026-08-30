# Implementation Status

Status date: 2026-08-31

The repository currently implements the Phase 0 control-plane foundation and the Phase 1
read-only GitHub ingestion vertical slice described in `ARCHITECTURE.md`. It is intentionally
fail-closed where a production security boundary is not yet complete.

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

## Deliberately Disabled

- `WORKER_EXECUTION_ENABLED=true` and the installer `-EnableExecution` option are rejected. The
  real Codex executor and native ProcessHost client are not implemented yet.
- Approval persistence, publication, and GitHub writes are not implemented. The production
  Dashboard therefore exposes the Phase 1 read-only surfaces only.
- The native `AgenticReview.ProcessHost.exe` implementation is not part of this milestone.
- Dynamic validation of untrusted pull-request code remains disabled.
- The Worker real-execution switch remains disabled until ProcessHost and the reviewed Codex
  executor are connected end to end on Windows.

## Next Milestone

The next vertical slice should connect the static-review Codex package to the signed Windows
ProcessHost boundary, add bounded artifact upload, and persist immutable review results. Approval
and GitHub publication should follow as a separate slice. Dynamic validation and GitHub writes
remain gated until their approval and isolation controls are implemented.

## Verification Evidence

The Phase 1a plus M0 stabilization candidate was verified on the remote Debian `test-env` host
with the official
Node.js 24.20.0 Linux distribution. Its archive checksum was validated against the Node.js
release `SHASUMS256.txt`, and pnpm 11.24.0 was provided through Corepack. No verification command
was run on the local Windows development machine.

The following commands completed successfully on 2026-08-31:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Test results:

- 228 tests passed: 176 Server tests, 25 Codex package tests, 21 domain tests, and 6 Worker tests.
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
- The native ProcessHost and real Codex executor are deliberately absent and therefore have no
  runtime verification.
- Real GitHub and external OIDC-provider integration were not exercised; their HTTP boundaries are
  covered with controlled test doubles and the local runtime smoke used the development auth mode.
- Browser-level visual and interaction testing was not run because the remote test environment has
  no browser runtime.
