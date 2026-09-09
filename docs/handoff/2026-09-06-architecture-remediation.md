# Architecture Remediation

## Scope and status

The architecture review of baseline `896dbaf` is implemented on
`codex/architecture-remediation`. Linux and Windows-native regression verification
are complete. The user explicitly authorized local execution and testing for this
task before Windows verification began.

## Implemented changes

| Review concern | Result | Regression evidence |
| --- | --- | --- |
| Source events mixed with observation snapshots | Webhook retries preserve payload identity; polling refreshes snapshots without conflicting with historical source IDs or reviving closed authorization. | `github-ingestion-replay.test.ts` covers retry, reopen, unrelated items, and lifecycle convergence. |
| Duplicate execution from different triggers | Stable review inputs and configuration determine reuse. Delivery IDs, observation timestamps, and request transport do not affect the execution digest. | Real scheduling factory tests cover assignment/review-request and webhook/poll reuse. |
| Returning to a superseded revision | Explicit job activations preserve old terminal states while allowing A to B to A transitions, including an old attempt still cancelling. | Queued and running activation regressions; migration 0011. |
| Authorization inherited too broadly | PRs default to revision-scoped authorization. Inheritance requires explicit current and stored policy, an authorized original actor, and complete request evidence. | Domain/config tests, denied replacement tests, truncated polling and same-time ambiguity recovery. |
| Cancellation kills unrelated execution | Pending-start cancellation retains its original acknowledgement deadline and terminates only the matching process after acknowledgement. | 37 ProcessHost client tests, including active siblings and shutdown races. |
| Disconnected claims keep acquiring leases | Long polling stops when the waiting response connection closes. | Real HTTP disconnect and completed-request-body regression tests. |
| Dashboard queries materialize all history | SQL performs filtering, counting, ordering, and pagination with indexes. | Projection tests verify exact totals, filter equivalence, and bounded materialized rows. |
| Orphans and capacity shortages permanently drain nodes | Startup recovers all confirmed unowned attempts under the singleton. Capacity shortage pauses claims and rechecks before resuming. | Recovery, safety, capacity pause/resume, and late-grant regressions. |
| Each slot scans the entire workspace | One node timer and an in-flight scan serve active reservations; individual identity/quota checks and a fresh final scan remain. | Shared-scan, cancellation, quota, queue, and final-snapshot regressions. |
| Missing verification evidence and failure diagnosis | V2 results distinguish model statements from Worker-observed commands, exit codes, and final Git state. Failures retain bounded, redacted diagnostics. | V1/V2 execution and completion tests, credential redaction, migration preservation, and Dashboard mapping. |
| Quiet repositories appear unhealthy | Runtime ingestion configuration and per-repository polling outcomes determine health. | Tracker, route, and main lifecycle tests. |

## Configuration and storage

`AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY` defaults to
`require_new_authorization`. A PR request must carry its exact base/head revision;
historical polling actors cannot authorize a newly observed SHA. Operators may
explicitly select `inherit_authorized_epoch` when future revisions are trusted.
Issue triage retains its non-checkout snapshot workflow. ADR 0030 specifies the
policy and its audit behavior.

`WORKER_EXECUTION_ORPHAN_RETENTION_HOURS` was removed because startup recovery now
reclaims confirmed unowned attempts immediately after acquiring the singleton.
The node checks recoverable capacity shortages every five seconds and reports
zero available slots while paused.

The current database schema is 11:

- 0009 adds Dashboard query indexes.
- 0010 preserves V1 results while supporting V2 results and failure diagnostics.
- 0011 adds job activation identity and lookup/uniqueness indexes.

Startup supports transactional upgrades from the schema 8 single-Worker baseline
and later versions. Earlier unpublished prototypes remain clean-install only.
V1 queued templates and persisted results remain readable and executable.

Dashboard production minification runs in the existing process. The previous
CPU-count-based process fan-out exhausted the verification host's available memory.
Minification remains enabled.

## Linux verification

Verification ran through `ssh test-env`, using Node.js 24.20.0, pnpm 11.24.0,
PowerShell 7.6.5, and the repository's Go toolchain. This stage ran entirely on
`test-env`; the separately authorized Windows stage is recorded below.

The final source snapshot is under
`/root/.cache/agentic-remediation-20260906-r1`. Logs are under
`/tmp/agentic-remediation-20260906-*` on `test-env`.

| Gate | Outcome |
| --- | --- |
| Frozen-lockfile dependency installation | Passed |
| Workspace typecheck | Passed |
| Node regression tests | 1,354 passed; 14 Windows-only tests skipped |
| All production builds | Passed, including Dashboard and Worker bundles |
| Biome | Passed; two informational template-literal suggestions |
| ProcessHost `go test -count=1 -p 1 ./...` | Passed |
| ProcessHost `go vet -p 1 ./...` | Passed |
| Windows amd64 and arm64 ProcessHost cross-builds | Passed |
| PowerShell evidence collector regressions | Nine passed; native process inspection fixture skipped |
| PowerShell launcher regressions | Passed |

Node test totals: Dashboard 18, Contracts 74, Codex 168, Domain 33, Server 484,
Worker 577. Package test execution and builds used workspace concurrency 1;
Vitest used two workers. The final build used a 1 GiB V8 heap limit and retained
production minification.

Primary logs:

- `/tmp/agentic-remediation-20260906-final-typecheck.log`
- `/tmp/agentic-remediation-20260906-final-test.log`
- `/tmp/agentic-remediation-20260906-final-build.log`
- `/tmp/agentic-remediation-20260906-final-lint.log`
- `/tmp/agentic-remediation-20260906-native-test.log`
- `/tmp/agentic-remediation-20260906-native-vet.log`
- `/tmp/agentic-remediation-20260906-powershell.log`
- `/tmp/agentic-remediation-20260906-launcher-tests.log`

## Authorized Windows verification

The user explicitly approved local execution and testing on 2026-09-06. A source
snapshot was created at
`C:\Users\moooyo\AppData\Local\Temp\ar-remediation-92445873\repo`.
Verification used Node.js 24.20.0, pnpm 11.24.0, Go 1.26.3 windows/amd64, and Git
2.54.0.windows.1. The system's default Node.js 26.1.0 was not used for the Worker
gates.

| Gate | Outcome |
| --- | --- |
| Frozen-lockfile dependency installation | Passed |
| Windows Worker typecheck | Passed |
| Windows Worker regression tests | 591 passed; zero skipped |
| Windows Worker bundle build | Passed |
| Native ProcessHost `go test -count=1 -p 1 -timeout 5m ./...` | All three packages passed |
| Native ProcessHost `go vet -p 1 ./...` | Passed |
| Native ProcessHost build | Passed |
| PowerShell evidence collector regressions | Ten passed; zero skipped |
| PowerShell launcher regressions | Passed |
| Deployment script parsing | Three scripts passed; zero syntax errors |

The Windows run covers all 14 Worker tests that were skipped on Linux, including
the real filesystem cleanup and churn suites. Windows build tags also enable the
native process and singleton tests in the ProcessHost suite.

The 264 non-document source files in the working tree were compared byte-for-byte
with the verified Windows snapshot; there were no differences. The Linux stage
also verified the same non-document source snapshot.

Windows logs are retained at
`C:\Users\moooyo\AppData\Local\Temp\ar-remediation-92445873\logs`:

- `windows-install.log`
- `windows-worker-typecheck.log`
- `windows-worker-tests.log`
- `windows-worker-build.log`
- `native-process-host-test.log`
- `native-process-host-vet.log`
- `native-process-host-build.log`
- `native-process-host-summary.log`
- `windows-deploy-e2e-r1.log`
- `windows-start-worker-r1.log`
- `windows-deploy-parse-r1.log`

## Acceptance scope and closeout

The architecture remediation and its Linux/Windows regression gates are complete.
Test fixtures performed their own cleanup; the isolated verification snapshot,
logs, and native build artifact remain available for audit. No real Codex review,
publication, or deployment was performed for this remediation. The historical
live E2E exercise remains a separate record for its explicitly identified commit.
