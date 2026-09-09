# Implementation Status

Work is paused at the user's request on 2026-09-09. Read the
[current paused handoff](./handoff/2026-09-09-validation-platform-paused-handoff.md) before resuming.
The real Notepad++ Worker build passed, but UI acceptance remains blocked. A newly added native
regression reproduced `ownership_lost` (one failure; other tests not selected); the production
ancestry fix is not implemented. Historical passing checks below do not supersede that result.

Current status as of 2026-09-09: the multi-repository validation platform is under integration.
Contracts, persistence/routes, planners, execution components, evidence handling, and real
Windows/Web drivers have passing checks. Worker startup composition, automatic GitHub planning,
Dashboard evidence/actions, M19 repository access, M20a human decisions, M21 finding disposition,
and eight cross-host component cases are integrated and tested. M24 accepted actual public-source
headless installation, Web compilation, CI tests, original-source verification, HTTP result
projection, and cleanup after correcting production composition and tool-deployment defects.
M26 has accepted the real Web homepage theme scenario and a separate deliberate failure, including
their fifteen original evidence assets and Dashboard result/download/preview behavior. M27 closes
P0 current waiting diagnostics; M28 delivers durable Job admission, exact-episode lease guards,
automatic admission pumping, and pending/admitted projections with connected acceptance.
M29 completes configured repository/global limits, queue-credit recovery, repository/class
fairness, bounded claim continuation, 100,000-Job measurements, and connected acceptance. M30
adds separately authorized publication previews, immutable intents, a delivery outbox, and
conservative recovery with isolated connected acceptance against an in-memory GitHub transport.
M32 now includes scoped evaluation score previews, immutable assessment history, case details,
and Dashboard review/save workflows. Its assessment browser checks and lifecycle closure passed
the isolated synthetic scenarios recorded below; actual evaluation execution remains unaccepted.
M32 also adds a tested model-response observation and relay foundation, with complete call records
and pure consistency verification. The common Codex runner integrates parent-owned invocation
lifecycle and raw-output binding. ValidationJobResultV2 now carries original model content separately
from Worker evidence, with Server content binding, version-aware reads and schema 31 migration.
Explicit production startup composition now connects the app-server review backend, static parent
provider and invocation API to measured deployment files. Summary input freezing and explicit
ScopeV2 binding are now integrated, with verification recorded in the current summary-input handoff.
Accepted model execution and enabled evaluation execution remain outstanding.
Actual Windows application scenarios and further repository/toolchain acceptance remain outstanding.
The actual model probe denied controlled file writes but allowed a controlled loopback connection,
so model network isolation is not accepted. The
[implementation ledger](./handoff/2026-09-07-validation-platform-implementation.md)
records the evolving integration evidence and remaining work.

The previous architecture remediation passed Linux and explicitly authorized Windows regression
verification on 2026-09-06; its scope and logs are in the
[remediation handoff](./handoff/2026-09-06-architecture-remediation.md). The earlier runtime E2E and
environment closeout are in the [live validation handoff](./handoff/2026-09-05-windows-e2e-live-validation.md).
Those historical passes do not establish acceptance of the new profile-validation platform.

## Validation platform in the current working tree

| Area | Implemented component scope | Remaining integration boundary |
| --- | --- | --- |
| Repository and configuration management | M12/M13 managed repositories, immutable Prompt/profile versions, bindings, optimistic concurrency, and preview. M23 exposes scoped configuration audit lists and recorded snapshots through authenticated APIs and Dashboard activity views. | Old unpublished draft bodies were not retained. Private metadata access does not establish private checkout readiness. |
| Operator access | M19 session-bound repository roles, trusted platform-admin configuration, SQL-scoped reads, access rechecks after evidence verification, versioned membership changes, immutable audit history, and Dashboard session-cache isolation. M27 connected diagnostics verify access loss, removal of old DOM data, and restored scoped reads with isolated identities. | Deployed OIDC and the intended deployment's operator-role sessions remain unverified; diagnostic read acceptance does not establish every role's mutation workflow. |
| Human decisions | M20a immutable Run decision events, exact source/result-set binding, CAS and historical receipts, current policy checks, qualified overrides, comments and withdrawal, history, and Dashboard integration. M21 adds disposition-aware V2 snapshots while retaining V1 history. | Automated integration and connected synthetic administrator HTTP/browser acceptance pass for M20. Actual OIDC/lower-role browser acceptance remains outstanding. M22 reproduction is a separate measured workflow. |
| Publication | M30 complete body/target/revision previews, separately versioned repository policy, explicit confirmation, immutable scoped intent, dedicated publisher identity, fenced delivery, exact confirmation replay, GET-only reconciliation and policy/attempt history. Two-repository connected acceptance passed with one mock POST per target. | No actual GitHub publication was authorized or performed. Deployment credentials and live target/payload acceptance remain separate. Unknown delivery is never automatically resent; GitHub does not supply distributed exactly-once semantics. |
| Finding lifecycle | M21 complete result-scoped occurrences, immutable disposition audit and projection, context/CAS checks, policy v2, and conservative explicit result comparison. No disposition or resolution is inherited from a prior result. | Automated integration and connected synthetic administrator HTTP/browser acceptance pass. Actual deployment identities and model/runner execution are separate boundaries; development samples explicitly do not simulate disposition writes. |
| Prompt/profile evaluation assessments | M32 freezes evaluation inputs, projects result/evidence and explicit finding adjudications, and provides deterministic score previews, immutable assessment versions, bounded case reads with frozen expectations, and Dashboard history/save workflows. | Assessment verification includes blocked, unexecuted batch snapshots and synthetic completed profile-only results. Browser save/retry/history/access scenarios and lifecycle closure passed. Required model identity, actual evaluation Worker/model execution, and Windows application evaluation remain unaccepted. |
| Issue reproduction | M22 frozen cases, typed probe receipts, Windows/Web assertion capture, capability admission, independent Server assessment, and recorded/current case reads. Dashboard case authoring, profile observables, result comparison, evidence preview, pending reruns, and stale-source transitions passed connected fixture acceptance. | Acceptance uses an isolated local Git source and a fixture disk-monitor callback. Actual repository checkout, production model execution, and deployment-specific toolchain acceptance remain separate work. |
| Frozen review runs | M14 immutable plans/rendered prompts, request snapshots, job associations, operator creation, and bounded history reads. | Complete product acceptance must exercise real operators and the intended repository policies. |
| Validation results | M15 `ValidationJobResultV1` persistence and fenced completion, with runner checks, model review, lifecycle diagnostics, and evidence completeness kept separate. Legacy review result tables remain supported. | Current-source eligibility must be verified across full executions, reruns, cancellation, and evidence expiry. |
| Evidence | M16 bounded upload, scoped delivery, quotas/retention, and private Linux storage. Full hashes/scenario checks run in a bounded read-only Worker; the SQLite owner rechecks authority after preflight. Cold reads explicitly show pending verification. | Component upload/PNG delivery and concurrent heartbeat/cancellation/shutdown have passed. Intended deployment storage and retention still need operational acceptance. |
| Profile dispatch and admission | M29 extends durable Legacy/V2 admission with repository/global queue and active limits, CAS/audit configuration, queue-credit recovery, successful-service fairness, and durable bounded claim scans. Production lease races, lifecycle tests, a 100,000-Job owner fixture, and connected quota editing/recovery pass. | The measurements cover the declared isolated dataset and host; production workload and deployment-specific capacity still require operational monitoring. |
| Current scheduling diagnostics | Strict M29 V3 diagnostics add current policy, exact scoped usage/overage, and separate queue/active limit reasons; historical V1/V2 remain valid. Repository readers receive coarse platform capacity without foreign counts. | Observations do not reserve capacity or establish queue position or an ETA. Partial inventory cannot prove Worker absence; source/authorization observations do not add new claim gates. |
| GitHub routing | M18 source sequences and immutable legacy/ReviewRun routing per work item, authorization epoch, and source activation. | Automatic webhook/poller-to-profile execution is under integration verification. |
| Headless execution | Registered commands run setup/build/test/cleanup with typed outcomes. M24 passed actual anonymous Git checkout, frozen install, Web compilation, CI tests, original-source verification, HTTP result equality, Dashboard display, and cleanup on a pinned public repository using production disk accounting. | This accepted run explicitly disabled model execution and used synthetic Issue metadata. It does not establish PR model review, measured Issue reproduction, private checkout, or real UI scenarios. |
| Optional validation summary | A strict, bounded read-only model adapter is wired for UI/Issue validation and defaults to disabled. Runner facts and model advice remain separate. An explicit provider/endpoint/header/literal policy can classify approved public metadata; the common model-output path rejects known protected values. | M24's actual elevated model probe denied controlled file writes but allowed an owned loopback connection. Network isolation is not accepted. No actual provider metadata value has been declassified or actual model execution accepted by the classification/output changes. |
| Windows desktop UI | Real UI Automation driver, owned-window evidence, active-session checks, exclusive session lease, process identity/draining, and reset/quarantine behavior. | A passing fixture does not establish unattended deployment readiness. The PowerToys Settings readiness review identifies missing Spectre libraries and a need for a separate Windows user/session or restorable VM; replacing environment paths alone does not isolate its settings. |
| Web UI | M26 accepted anonymous pinned-source checkout, frozen dependency installation, actual homepage compilation, passing and deliberately failing UI scenarios, fifteen downloaded evidence assets, HTTP equality, Dashboard display/download/PNG preview, and process/workspace cleanup. Real source-capture progress now keeps valid bounded verification visible to the lease coordinator. | This homepage case does not establish extension/userscript integration, provider behavior, model execution, or measured Issue reproduction. |

The architecture decision is [ADR 0031](./adr/0031-profile-validation-runs-and-bounded-evidence.md).
It replaces only ADR 0029's inline-only evidence restriction. It does not restore the unpublished
split Worker, installer, local RPC, or artifact-backed result compatibility designs.

### Identities and results that must remain distinct

- Run activation freezes configuration and source authority. An audited per-profile rerun within
  that plan creates a new job activation; infrastructure retries create attempts of the same job.
  New configuration or a new run requires a new frozen activation.
- M18 source sequence distinguishes A-to-B-to-A even when observation did not authorize execution.
  Transport replay or adding bindings later cannot create a second pipeline for an already pinned
  legacy/ReviewRun activation. Independent active authorization epochs may own separate runs.
- PRs use their exact authorized base/head pair. Issue reproduction separately binds authenticated
  operator authority to the run activation, current issue content revision, and selected commit.
  Issue triage remains snapshot-only and cannot grant that execution authority.
- V2 envelopes retain the existing `pull_request_review` and `issue_triage` job families while
  carrying the selected workflow/profile identity. Envelope V1 and historical V1/V2 review-result
  schemas are retained; envelope versions and model-result versions are different contracts.
- Worker checks determine validation outcomes. Model recommendations cannot supply runner evidence.
  Required original-source coverage, complete evidence, request/lifecycle blockers, and blocking
  findings determine eligibility; human decisions and GitHub publication are separate.
- UI checks represent typed scenarios, not successful launch commands. Required UI profiles need
  required scenarios, actual driver support, and evidence delivery on the same executor. Current
  UI profiles build their own exact source; build-artifact reuse is not implemented.

### M27 P0 verification and lifecycle boundary

The final Linux Server suite passed **4,068 tests with one skip across 95 files**; shared packages
passed **1,126 tests across 30 files**; Dashboard passed **2,678 tests across 63 files**. The focused
diagnostic suite passed **45/45**. Server build, Dashboard production build, and full type checking
passed. See [the M27 report](../artifacts/m27-scheduling-diagnostics-20260907/REPORT.md).

The original connected browser passed all 12 commands and closed with zero errors at
`2026-09-07T07:38:02.034Z`. An external `test-env` restart at approximately `07:40:40Z` removed its
original `/tmp` fixture, and no original `server-stopped` record is available; original graceful
Server closure is therefore unverified. Recovery used the same source and build under `/var/tmp`: all
eight real HTTP state checks reported `coreRowsUnchanged`, and the final five-command browser
session verified automatic Job/request refresh and finished at `2026-09-07T08:11:36.634Z` after
closing with zero errors. Earlier recovery
SSH signer and missing-`completedAt` orchestration failures remain recorded as failures. This is
aggregate evidence, not one uninterrupted or wholly passing recovery session.

The recovered Server explicitly closed HTTP and SQLite at `2026-09-07T08:11:47.350Z`, with no
cleanup errors or active fixture leases. The target Job remained queued with zero attempts, and
the no-Job request remained null. P0 acceptance did not execute that queued work or implement P1
capacity policy. Fixture/authentication operations remained isolated; no real PR/Issue write was
authorized by this verification. Final local and remote fixture ports had no listeners, and the
existing port 8000 Sample preview returned HTTP 200 at `08:15:11.300705Z` with its PID unchanged.

### M28 admission foundation verification

The final Linux Server suite passed **4,205 tests with one skip across 100 files**; shared packages
passed **1,178 tests across 33 files**; Dashboard passed **2,720 tests across 66 files**. Server
build, Dashboard production build, and full type checking passed. Migration `0024` adds
`job_admission` and `scheduling_state`, with production-parser backfill that preserves historical
bytes and marks introduced timestamps as migration backfill. Valid work without a Worker now
has a durable pending Job; a missing Prompt remains a structural no-Job prerequisite.

The final fresh connected browser passed all 20 commands with no errors. UI cancellation and an
activation-2 rerun preserved history; exact replay changed no business rows. Registering a Worker
let the production pump admit both the Legacy Job and rerun before the explicit private admission
check, which admitted zero additional Jobs. Every Job retained zero attempts and no lease was
granted. Five HTTP phases verified exact scope and unchanged core rows on GET; same-session
revocation removed old diagnostics and Run details before restored access. Five screenshots were
visually reviewed. Earlier fixture-bootstrap failures and the HTTP admission-filter failure remain
recorded; the missing route whitelist entry was fixed with nine route regressions.

The browser closed at `2026-09-07T10:06:29.175Z`; the API explicitly closed at
`2026-09-07T10:08:24.777Z`, before its fixed deadline, with no cleanup errors. Ports 3275 and 39711
were released. This is scheduling plan slice 2, with a bounded captured pending pass rather than
complete fairness or bounded claim scanning. See the
[M28 design](./design/2026-09-07-job-admission-foundation.md) and
[acceptance report](../artifacts/m28-admission-foundation-20260907/REPORT.md).

### M29 configured scheduling verification

Linux Server: **4,457 passed, one skipped, 108 files**. Shared packages: **1,210 passed, 35 files**.
Dashboard: **2,788 passed, 70 files**, with production build and type checking passed. The isolated
100,000-Job owner test reached its last eligible Job after 1,042 claims; maximum inspection was
128 candidates/14 repository keys per RPC. Claim and heartbeat RTT p95 were 435.606 ms and
439.191 ms; pending cancellation took 524.301 ms, all within the predeclared limits.

The final browser passed 37 commands, including two repositories/classes, quota edits/recovery,
pending cancellation/reruns, V1 and platform audit, scope denial, and same-cookie permission
loss/restoration with two automatic refreshed observations. No execution attempt or upstream
PR/Issue write occurred. Read-only permission refresh controls now remain available in the
configuration-event and Run drawers. Verified-principal rate budgets support normal polling
without sharing one operator quota across all clients on the same IP.

The browser and API closed at `13:17:47.770Z` and `13:18:00.406Z`; both ports and the owned
browser process were confirmed absent. See the [M29 report](../artifacts/m29-scheduling-policy-20260907/REPORT.md)
for exact artifacts, retained failures, source identity, and scope limitations.

### M32 assessment implementation and verification

The assessment APIs capture sealed evaluation state in the database owner and compute scores from
those inputs. HTTP clients cannot submit observations or scorer output. Repository readers can
preview scores and read immutable assessment summaries, history, and individual cases; saving an
assessment separately requires the current review permission. Publish requests contain only
`changeId`, `expectedVersion`, and `expectedInputDigest`, with compare-and-swap checks and exact
receipt replay. Recovery independently rejects new saves while retaining authorized exact replay.
Later assessment versions preserve prior reports and their frozen case titles, expected checks,
finding descriptions, and score details. Historical scorer V1 and V2 reports remain readable.

Summary/read responses are bounded to 2 MiB, mutation receipts to 256 KiB, and individual case
responses to 2 MiB. Dashboard workflows provide explicit preview/save actions, retain the original
request after an uncertain save, and separate a retry from a new report request. Report history and
case details remain scoped to the selected repository and evaluation.

Confirmed Linux verification: Server **5,470 passed, one skipped, 146 files**; shared packages
**1,852 passed, 49 files**. Windows Dashboard verification: **3,528 passed, 110 files**. The assessment targeted suite
passed **317 tests across 10 files**; these targeted counts overlap the broader suites. Server and
Dashboard production builds and type checks passed. The captured source is
`source-assessment-api-final.json`, SHA-256
`f30fcc4a9dcccbd8180ec473544f841e0b41ff1eddb5358eba5e8b3fdd24e974`.

The connected browser has verified reviewer preview/save, an intentionally lost successful save
response, retention of the original request through permission refresh, and retry of the same
`changeId` returning assessment version 1. An explicit new request saved assessment version 2;
version-1 history and case details remained readable. Access revocation cleared prior content, and
restored viewer access allowed reads while keeping save unavailable. These are assessment versions,
not scorer rules versions. The browser signed out; HTTP and database closed, background work
drained, the Server process exited, and the forwarding port was released. Shutdown reverified the
frozen source/runtime and unchanged four synthetic results/twelve assets, with zero fixture errors
or outbound fetch attempts. Two internal reports were stored. Exact scope and public evidence are
recorded in the [assessment delivery notes](../artifacts/m32-evaluations-20260908/assessment-delivery-notes.md).

Runtime tests include blocked, unexecuted evaluation snapshots and incomplete coverage. The browser
reports used synthetic completed profile-only results; no application, compiler, execution Worker
or model ran in that fixture. Neither establishes successful model execution. Actual evaluation Worker/model execution,
required model identity and confinement, and real Windows application scenarios remain separate
unfinished boundaries. No real PR/Issue write was authorized or performed by this verification.

### M32 Worker source and model-delegation integration

Evaluation source preparation now validates the full frozen V2 source/operator context and its
outer envelope before filesystem admission. Historical PR preparation fetches the exact base/head
object IDs; Issue preparation uses its own evaluation authority and selected commit. Ordinary PR
review and Issue authorization behavior remain unchanged. Source failures never fall back to the
current PR head. Component coverage includes moved references and source/authority tampering.

Profile model delegation now retains the complete V2 envelope through a separate model entry;
it no longer removes validation identity or rewrites the envelope to V1. A model workspace request
must match the original canonical envelope. The legacy entry stays V1-only, and all relevant
entries still reject evaluation execution before starting a workspace or model.

The optional [provider metadata policy](./operations/codex-provider-metadata.md) classifies only
exactly approved public literals. Unmatched values, authentication headers and same-text secrets
remain protected. All model results now pass a shared decoded-result check for known protected
values; a rejection returns `CODEX_RESULT_UNSAFE` without changing the model body or its digest.
Transport and protection use the same snapshot across asynchronous work. No actual provider
profile was read or changed and no actual metadata literal was declassified in this increment.

The final Windows Worker suite passed **1,483 tests with 28 conditional skips across 31 files**;
type checking and production bundling passed. The tested 967-file source archive is
`8125850b76fc4c206caa161f1bad8a127ab0a29eb11e4810cb1b6da3a429f5a7`.
Separate Windows source-preparation acceptance also passed against pinned public commits using
the real Git, ProcessHost, workspace provider and disk accounting. Both synthetic PR/Issue cases
retained their expected commits and clean worktrees, all 30 Git invocations exited zero, and the
two reservations/26 monitors and native host closed. It did not execute a Profile, build, model,
UI scenario or Server admission/completion. The
[Worker integration notes](../artifacts/m32-evaluations-20260908/worker-execution-notes.md)
retain test failures, source identity and the precise scope. Evaluation capability is still withheld
until actual model identity and the complete command/model side-effect boundary are accepted.

### M32 model observation foundation verification

Strict runtime/scope/response/call contracts, a JSON/SSE observer, an invocation receipt recorder,
a loopback Responses relay, and independent domain hash/scope checks are implemented. Requested
configuration remains distinct from provider-reported model identity. The full call chain retains
failures and partial responses; final output must bind to the last completed response. The verifier
requires an independent authenticated closure seal and does not itself authenticate the collector.
Metadata budgets are reserved before another call is admitted, and timestamp precision matches the
millisecond ordering checks. The relay uses one fixed HTTPS endpoint, invocation-scoped credentials,
bounded transport and shutdown, and protected authorization metadata.

The captured 978-file source archive is
`48dd075e71a55ceb2c4ec3a105aebd60f5c7b62d0607f94feeec67094102f3ab`.
Windows Worker verification passed **1,685 tests with 28 conditional skips across 34 files**, full
type checking and production bundling. Linux shared packages passed **1,924 tests across 51 files**;
Server compilation and type checking and strict checks of the new shared test files passed.
The Worker totals include **111 observer, 17 recorder and 74 relay cases**. Relay cases use real
incoming loopback HTTP with synthetic upstream transport; no actual provider or model was called.
The [observation notes](../artifacts/m32-evaluations-20260908/model-observation-notes.md) retain
source identity, reports, corrections and scope.

The later registry increment below adds expected configuration registration and freezing. Measured
launch configuration, trusted authorization-helper composition, fenced Server receipt acceptance,
versioned result/scoring integration and actual network isolation remain unfinished. Production
evaluation capability remains withheld. The
[design](./design/2026-09-08-model-runtime-observations.md) describes the remaining integration gates.

### M32 expected model runtime registry

Migration 0029, authenticated registry routes/RPC, platform administration, repository-scoped model
options, immutable snapshots and separate selection controls are implemented. Evaluation creation
resolves a selected registration under the owner transaction. Compact cell references bind the full
configuration/plan/context snapshots without expanding the cell-manifest storage limit. Existing
unknown history remains unchanged. Registration does not enable required-model claim or completion.

The Dashboard adds System registration/control/history and per-arm evaluation selection, preserves
uncertain requests across transient same-session access failure, and clears them on confirmed
permission loss or logout. Sample mode does not fabricate registry mutations. Read the
[registry design](./design/2026-09-08-model-runtime-registry.md) for the precise semantics.

Linux verification passed **5,583 Server tests with one skip across 149 files**, **1,950 shared
tests across 53 files**, and **238 targeted tests across seven files** included in the Server total.
Windows Dashboard passed **3,628 tests across 114 files**; Worker passed **1,685 tests with 28
conditional skips across 34 files**. Type checking, Server and Worker builds, and an isolated
Dashboard production build passed. Server/shared source is `source-model-registry-regression.json`,
archive `b5e05108048401cb24711049185eaab57ef4dee78fa67f7f0465631e8c664689`; the later Dashboard
access-recovery refinement is in `source-model-registry-final.json`, archive
`f649c0490c195ab7d7d0041df6844b39a753b2be96b9815bc1795d21502680c1`. Both contain 995 files.
Connected browser acceptance then exercised two registrations, one comparison batch, candidate
disablement, preserved historical snapshots, and enabled-only selection through the real HTTP and
SQLite owner. A synthetic repository maintainer could read the existing batch and baseline option;
the System page and a different repository's evaluation page denied access. Direct browser
navigation to the registry API was blocked by the browser client and is not counted as an API
permission check. The fixture recorded four completed business mutations, no execution and zero
outbound fetch attempts. It closed HTTP, SQLite and background work at `2026-09-08T08:14:23.727Z`,
before its deadline; the temporary tab and local forward were closed. The local sample preview
remained available. These checks do not establish actual provider or model execution. See the
[registry acceptance notes](../artifacts/m32-evaluations-20260908/model-registry-notes.md).

### M32 independent invocation recording

Migration 0030 adds immutable attempt-bound openings, independent closure commitments and complete
ledger submissions. Worker HTTP APIs, a parent-owned relay/process coordinator and owner consistency
verification are implemented. Every submission explicitly retains `executionAccepted: false`.
The owner repeats current credential and lease checks; exact replay preserves the original record,
while new expired/cancelled/recovery writes are refused. Original failures cannot be removed by
uploading a shortened ledger. Runtime/control validators also reject inherited array serialization
getters before invoking them.

Final Linux Server verification passed **5,679 tests with one skip across 151 files**; shared
packages passed **2,113 tests across 55 files**, and the focused suite passed **121 tests across
five files** included in the Server total. Worker passed **1,798 tests with 28 conditional skips
across 36 files**. Server/Worker builds and type checking passed. The actual Worker HTTP client,
compiled route, RPC Worker and SQLite owner passed opening/seal/submission, exact replay and
recovery tests using synthetic protocol leases. These tests did not execute a model or grant a
required-model claim. No Dashboard source changed or was rebuilt in this increment.

The final Server source archive is `155f82b4438b0ecf51483b92aaeeaa643407cebc7175eb9697b2afc6d17815c9`.
It differs from the shared/Worker regression archive
`ab2515ea72cd67a124c74938285d64370c369d16479e9096ee75c301585394d9` only in two corrected migration-count
test assertions; both contain 1,011 files. Earlier preparation failures and raw reports are retained
in the [invocation acceptance notes](../artifacts/m32-evaluations-20260908/model-invocation-notes.md).

The coordinator is not yet composed into the production attempt lifecycle. Actual CLI/launch-policy
measurement, trusted provider setup, accepted command/network isolation, final model-output binding
and result/Dashboard integration remain open. Required-model claim/completion and advertised
evaluation capability remain unchanged. See the [design](./design/2026-09-08-model-invocation-control.md).

### M32 invocation diagnostics and collector prerequisites

Operators can read invocation history from any evaluation cell, including failed Jobs and cells
without a final result. The owner verifies current repository permission, the frozen cell and every
stored opening/seal/submission reference and digest. History remains readable after old Worker
credentials or leases expire. The Dashboard separately shows expected/recorded model identity,
call outcomes, incomplete collection reasons and unaccepted execution. Reads are explicitly
refreshed, with at most ten invocations per page; changed access/scope removes prior content.

The binary verifier now retains actual file SHA256, size, identity and verification time. A separate
relay-provider loader retains static upstream headers only in a parent-process authorization
callback. Unsupported authentication modes are explicit, and its declarations retain an unverified
effective policy. Neither change composes or enables the production model executor.

Final Linux Server verification passed **5,729 tests with one skip across 153 files**, shared
packages **2,208 tests across 56 files**, and the focused suite **222 tests across five files**
included in the Server total. Dashboard passed **3,766 tests across 117 files**; Worker passed
**1,837 tests with 28 conditional skips across 36 files**. Type checking, Server/Worker builds
and the isolated Dashboard production build passed. The final Server/build source archive is
`500ee4b4e48c554d736dae06fae0106fbaeefe9a0041f69c5b901d80d090dd5f`; it differs from the
Dashboard/Worker tested archive `7cccfc0083db95258a5694d614447b4d9586d3dac784a4dec1b5d4cbef7e38ec`
only in the corrected operator-cookie test fixture. Both contain 1,026 files.

The connected browser verified opening-only, sealed-but-not-submitted, matched collection and
provider-failed/cancelled collection views, actual recorded model names, expanded identifiers,
read-only repository access and removal of old data when repository B was denied. Five screenshots
were visually checked. All observations and both SQL protocol attempts were synthetic; no model,
Codex CLI, ProcessHost or target application was executed and no final validation result was produced.
The Server closed HTTP, SQLite and background work at `2026-09-08T09:56:47.027Z`, before its fixed
deadline, with no errors and zero outbound fetch attempts. The temporary tab and forward were
closed, and the local sample preview remained available. See the
[diagnostics acceptance notes](../artifacts/m32-evaluations-20260908/invocation-diagnostics-notes.md)
for original failures, exact source/build/fixture evidence and scope limitations.

### M32 prepared model runner integration

The common Codex runner now consumes a parent-owned invocation session, compares the complete
scope with the actual prompt and output schema, attaches its managed process and rejecting stream
drain promise, and closes with the validated raw model-output digest. It replaces provider launch
inputs and uses the workspace provider's fresh per-attempt Codex home. Previously protected values
remain protected even when provider launch settings are replaced. Startup does not yet construct
these sessions, and collection still does not accept the execution boundary or final model result.

The stable parent attempt signal prevents redispatch through a fresh wrapper, nonce or runner
instance. Uncertain seal/submission transport receives one exact replay without a second process.
Progress callback exceptions cannot bypass process and disk-monitor cleanup; a late termination
request failing after process exit cannot override actual exit and stream-closure evidence.

Final Windows Worker verification passed **1,942 tests with 28 conditional skips across 38 files**,
with Worker build, dependency compilation and type checking passed. The 1,030-file source archive
is `b7fcace26fac124cc5b7e1c58b132bb4de2cf20f8755b87f17d6ef509b86cd6b`.
The full suite includes the pure provider-launch cases, cancellation and cleanup regressions, and
an actual loopback relay/coordinator case using synthetic ProcessHost, Server API and provider
transport. No actual Codex/provider, target Windows application or upstream repository write was
executed. Earlier assertion failures remain recorded in the
[runner acceptance notes](../artifacts/m32-evaluations-20260908/model-runner-collection-notes.md).
See the [lifecycle design](./design/2026-09-08-prepared-model-invocation-lifecycle.md).

### M32 versioned model-output results

`ValidationJobResultV2` preserves one original model object and its invocation reference separately
from Worker execution evidence. Its runner report excludes model summaries and model-authored
checks. Worker review/profile/summary components retain the original digest, validate captured
recording requirements and respect the shared 2 MiB envelope budget without truncating facts.

The owner validates actual raw content against the frozen workflow, full Job/attempt scope and
independent opening/seal/ledger records. Result, evidence, finding, reproduction, decision and
evaluation reads now decode both stored versions while preserving their actual bytes and outer
digests. Matching collection remains unaccepted execution and supplies no trusted model scoring
identity. Required-model claim/completion gates and startup session composition remain closed.

Migration `0031_validation_model_outputs.sql` preserves V1 rows, byte content, rowids, foreign keys,
indexes and current trigger definitions through a startup-owned rebuild. A schema/type/name/table
allowlist prevents same-name views from impersonating known triggers; the M28 rebuild received the
same correction. Historical migration files 0001 through 0030 are unchanged.

Final Linux verification passed **5,802 Server tests with one skip across 156 files**, **2,255
shared-package tests across 57 files**, and **308 focused tests** included in the Server total.
Windows Worker passed **1,981 tests with 28 conditional skips across 39 files**; Dashboard passed
**3,766 tests across 117 files**. Server/Worker builds and type checking passed. The final Linux
source archive is `faccf4b687db88fb6a9d7688046be6dadda1afd32d642688abe0af77edccd94e`;
the local suites used `21d0a4b305869204de1c60c94bcaa5ba0d0c566c67509901d3f2cb5345d6c822`.
Both contain 1,043 files; only Server test fixtures and migration-version expectations differ.
The initial failed checks and their corrections are retained in the
[V2 acceptance notes](../artifacts/m32-evaluations-20260908/validation-model-output-notes.md).
See the [V2 design](./design/2026-09-08-validation-model-results-v2.md) for the exact scope.

### M32 frozen model scope and pinned CLI policy

The Worker now binds model invocation scopes to complete evaluation envelopes, including frozen
source, profile/Prompt/schema, registration and lease identity. Ordinary production contexts and
composite Prompt digests cannot impersonate the V1 evaluation binding. The combined scope/relay
capture passed 2,033 Worker tests with 28 conditional skips, type checking and build; execution
gates remain unchanged.

Actual Codex 0.145.0 bytes match the recorded binary pin. Its generated stable/experimental
schemas and bounded same-process RPC probes confirm named-profile selection, disabled optional
tool features and the expected local workspace. The new homes report `updateRequired`; no
Windows sandbox setup or command-level isolation acceptance occurred. Config/profile observations
do not supply a trusted effective-policy digest.

A no-tool CLI run completed one exchange with an owned synthetic Responses provider and verified
the complete Prompt/schema mapping and final JSON. The relay now accepts the six observed
`client_metadata` keys as bounded opaque strings while preserving exact request bytes; unknown
keys, malformed values and excess sizes are rejected before dispatch. These fields cannot supply
identity or permission evidence. A separate replay of the captured request through production
relay/observer/recorder code passed, preserving request/response bytes, all eight SSE events and
the final output binding, with all handles closed. No real model/provider, PR/Issue mutation or network boundary
was accepted. See the [scope and runtime notes](../artifacts/m32-evaluations-20260908/model-scope-runtime-policy-notes.md).

### M32 same-process app-server transport

ProcessHost now offers explicitly enabled, bounded interactive stdin with per-process stream IDs,
ordered acknowledgements and independent cancellation. Default single-shot launches remain
unchanged. The Worker client and app-server JSONL transport handle input/output backpressure,
request identity, timeout/exit races and asynchronous notification delivery without replaying
uncertain operations.

Corrected-source Worker verification passed **2,231 tests with 28 conditional skips across 41
files**, type checking and build. Full Windows native tests/vet and amd64/arm64 builds passed;
Linux native race checks passed. Real blocked-pipe tests confirmed peer control, cancellation,
the ten-second input timeout, Job draining and handle closure. A new compiled Host, production
Worker transport and pinned Codex 0.145.0 process completed eight metadata RPCs, then closed both
streams and exited 0. No model request or sandbox setup occurred; new-home readiness remained
`updateRequired`. The first real integration's queue-handoff failure and its correction are retained.

This transport stage did not change main startup or evaluation/model gates; subsequent startup
composition is described below. Model execution and policy acceptance remain open, and previous
trusted binary copies/pins were not replaced. See the [transport design](./design/2026-09-08-process-host-interactive-stdin.md)
and [delivery evidence](../artifacts/m32-evaluations-20260908/interactive-stdin-delivery-notes.md).

### M32 single-turn output and attempt ownership

Worker attempt identity now survives derived Profile and Summary cancellation contexts. A child
budget signal cannot acquire a second model invocation for the same original attempt. The new
app-server launch builder rejects legacy sandbox overrides and uses dedicated interactive input.
Transport progress observes actual response and diagnostic bytes. The output collector and
single-turn driver validate thread/turn/item identity, raw structured output, protected decoded
values, canonical digests and command evidence, independently of physical process draining.

The pinned Codex 0.145.0 and real ProcessHost completed a controlled synthetic turn using the
production builder, transport, collector and driver. All 19 notifications were delivered; the exact
prompt and output schema reached the owned provider, and the validated result matched its final
message. Both streams, the CLI, Host and provider closed normally. No tool call or real upstream
request was issued. Captured-notification regression also covers early turn responses and missing
typed completion. This proves protocol/output compatibility, not real model or OS confinement.

Strict CLI configuration exposed an unsupported `tools.view_image` setting. Its rejection and
the failed runs are retained; the synthetic provider still advertised `view_image` after that
invalid field was removed. This must not be described as an effective tool restriction.
PreparedRunner backend selection is implemented in the subsequent integration below. Production
startup is connected in the subsequent startup stage below. Command/network isolation and Windows
application acceptance remain open; model/evaluation execution gates remain unchanged.
See the [turn-output design](./design/2026-09-08-codex-app-server-turn-output.md) and
[delivery evidence](../artifacts/m32-evaluations-20260908/app-server-turn-delivery-notes.md).

### M32 parent invocation factory and session-policy integration

The prepared runner now selects the app-server backend explicitly, requires a parent invocation,
and retains the existing single-dispatch/close-intent/recording rules. The driver and physical
drain promise attach before RPC. Actual session configuration, CLI version and the opening's
runtime binding must match before any turn is sent. Both backends share disk/progress lifecycle;
app-server input/output does not use exec result files or fabricate exec events.

A parent factory derives evaluation ScopeV1 from the complete frozen envelope, verifies its runtime
registration and retains one preparation/open promise per original job attempt. Changed lease
identities cannot reopen the same attempt. Root and child cancellation both propagate. Protected
value budgets are aligned across the prepared runner, driver and collector without truncation.

The versioned policy observer records actual merged configuration and requirements, profile/feature
metadata and thread policy. Exact dynamic path/relay substitutions and locale-independent ordering
produce a stable configuration projection; full provenance remains bound by a separate raw digest.
Three actual Windows metadata cases confirmed generated review/summary compatibility and stable
review hashes across distinct temporary layouts and ports. All reported `updateRequired`, refused
execution, issued zero provider requests and closed their owned resources normally.

This does not establish OS enforcement or real model acceptance. Production startup is connected
in the next stage; the evaluation-only/composed-input guards remain in place.
See the [session-policy design](./design/2026-09-08-codex-app-server-session-policy.md)
and [integration evidence](../artifacts/m32-evaluations-20260908/app-server-integration-delivery-notes.md).

### M32 production model startup composition

The explicitly configured app-server review backend now receives the production invocation API,
verified Codex measurement, static parent authorization, classified output-protection values and
model parameters. Startup verifies the actual `worker.mjs` entry and Node executable under the
deployment-owned trusted root. The implementation digest includes their measured bytes, running
Node version and supported interpreter arguments; the relay policy uses its actual limits.
Ordinary PR/Issue review and optional summaries retain their prior backend. Evaluation model
factories are selected from the complete frozen envelope, without copying upstream credentials
into CLI arguments or environment.

The new policy preserves declared reasoning effort, context window and automatic compaction
threshold and checks their actual configuration/thread observations. Authentication values echoed
inside otherwise valid model JSON remain subject to the parent output guard; explicitly public
metadata retains its existing classification. Startup snapshots its inputs and waits for both file
verifications to settle on failure. The existing start command's `--enable-source-maps` flag is
supported and included in the implementation identity.

Configured composition is not execution acceptance: no evaluation capability is advertised, the
execution boundary still refuses evaluation work. Evaluation summaries use the subsequent independently
frozen input integration below. No Windows sandbox setup or real repository write
is performed by this integration. See the [startup design](./design/2026-09-08-evaluation-model-startup.md)
and [verification evidence](../artifacts/m32-evaluations-20260908/startup-composition-delivery-notes.md).

### M32 frozen summary input integration

The shared summary assembler now produces the same canonical context and Prompt bytes for Worker
and Server use. The authenticated input-freezing operation stores the complete runner/evidence
context in immutable schema-32 records before a summary invocation opens. Worker factories verify
the entire receipt against their frozen envelope and retain one preparation per original attempt.
ScopeV2, OpeningV2 and ReceiptSetV2 keep original and composed Prompt identities separate; V1
history remains readable. Final summary-result binding rechecks the original runner facts and
allows only later model-stage lifecycle additions.

Input freezing remains restricted to required-model summary workflows with a frozen registration;
profile-only evaluation does not acquire model authority. The existing mapped evaluation
reproduction restriction, execution-boundary guard and absent evaluation capability remain in
place. This implementation does not establish real model execution, Windows sandbox readiness or
deployment acceptance. See the [input design](./design/2026-09-09-frozen-validation-summary-input.md)
and [integration evidence](../artifacts/m32-evaluations-20260908/summary-input-delivery-notes.md).

### M32 evaluation profile and model routing

Worker frozen-envelope validation now distinguishes evaluation authorization from ordinary Issue
source authorization. Model selection follows the frozen model requirement: profile-only evaluation
does not invoke model factories, and a required model cannot become optional because configuration
is missing. Explicitly pinned evaluation summary composition is independent of ordinary optional
summary opt-in. Required failures retain runner facts in the recorded-result format.

New Server completion rejects embedded or completed model content for profile-only evaluation,
while retaining ordinary summaries and historical V1 reads. Neither Worker execution guard, the
evaluation capability restriction, nor required-model Server completion acceptance is relaxed.
See the [routing design](./design/2026-09-09-evaluation-profile-model-routing.md) and
[verification records](../artifacts/m32-evaluations-20260908/profile-routing-delivery-notes.md).

### M32 mapped Issue evaluation

Dedicated reproduction selection, arm mappings, Server preview and frozen-plan reads now connect
the original immutable Issue claim to each selected evaluation profile. Separate bounded definition
and cell records are bound by a small reproduction manifest and CellManifestV2. Missing mappings
remain blocked and cannot be represented as a missing Worker capability or an unmapped V1 batch.

The owner rechecks mapping readiness across runtime entry points. Worker and Server reproduction
assessment use independent evaluation authorization while retaining ordinary Issue authorization.
Migration 0033 preserves existing data and manifest versions. Dashboard input changes invalidate
their previews; blocked previews remain valid configuration outcomes. Evaluation/model execution
gates are still closed pending their separate acceptance. See the
[mapping design](./design/2026-09-09-evaluation-reproduction-mappings.md) and
[verification records](../artifacts/m32-evaluations-20260908/mapped-reproduction-delivery-notes.md).

## Remaining product work

- **Integration acceptance:** complete static/build, Windows UI, Web UI, and issue-reproduction flows
  through Server, Worker, and Dashboard, including stale sources, evidence upload, failed assertions,
  rerun/cancel, process draining, and environment restoration.
- **P0 deployment boundary:** M27 current waiting diagnostics are complete, alongside M19 repository
  ACL/membership audit reads and M23 configuration audit reads. Deployed OIDC and the intended
  multi-user deployment still require acceptance beyond the isolated connected diagnostic cases.
- **P1 workflow acceptance:** M29 completes the configured scheduling plan. M20a human decisions,
  M21 finding disposition/history, and M22 measured issue reproduction still need the intended
  repository and deployment acceptance. Passing generic checks alone does not prove reproduction.
- **P2:** actual Prompt/profile evaluation execution/comparison acceptance. M31 actionable
  notifications passed connected acceptance with synthetic source events. M32 assessment APIs and Dashboard workflows passed isolated browser acceptance and
  lifecycle closure; required model execution remains unaccepted. M30 publication
  preview/outbox is implemented and accepted with isolated mock transport; deployed publisher
  credentials and any exact live target/payload require separate acceptance and authorization.

Automated tests must not write any repository's PRs/issues without the user's explicit approval
of the exact targets, operations, and content. General implementation or local/test-env approval
does not grant that authority. Existing explicit approval remains valid within its stated scope;
actions outside that scope require new approval. See [AGENTS.md](../AGENTS.md).

## Retained architecture baseline

### Server

- Fastify control plane with Linux-only production SQLite ownership.
- GitHub webhook ingestion and optional authenticated polling.
- Repository and actor admission policy.
- Immutable issue and pull request projections.
- Job scheduling, retries, claims, leases, heartbeats, fencing, and terminal replay handling.
- Inline result validation and immutable result persistence.
- Per-Worker Bearer Token creation, rotation, revocation, and authentication.
- Operator Dashboard APIs and static Dashboard serving.
- Authenticated Job detail reads with structured PR-review and issue-triage result projections.
- Explicit `loopback` or `oidc` operator authentication.
- Loopback-only database recovery-maintenance mode.
- The earlier baseline used migrations `0001` through `0011`; current platform integration extends
  that schema through `0033` without rewriting legacy review results.

### Windows Worker

- One production Worker entry point and bundle: `apps/worker/dist/worker.mjs`.
- Real execution is wired when `WORKER_EXECUTION_ENABLED=true`.
- Worker registration, long-poll claims, Worker and lease heartbeats, drain, and fenced terminal
  reporting.
- Pinned Git, Codex, and ProcessHost executable paths and SHA-256 verification.
- Replacement child environments that exclude the Worker Bearer Token.
- A dedicated persistent Codex home, read-only canonical-directory and overlap checks before orphan
  cleanup, and allowlisted model/provider/auth configuration loading.
- Native Codex provider header variables separated from argv and the seven-variable build/test
  shell environment; neither shell authentication paths nor Worker/GitHub credentials are exposed.
- Fixed `--ignore-user-config`, workspace-write/approval settings, project config suppression with
  `untrusted` project trust, and disabled MCP/plugins/hooks/notifications/inherited extra write roots.
- Pinned native Codex 0.145.0 compatibility, using `--config approval_policy="never"` for exec.
- Native ProcessHost supervision with Windows Job Object lifetime and resource limits.
- A Windows global named mutex, held by ProcessHost, that prevents two execution Workers from using
  the same resolved data root concurrently.
- ProcessHost closure on initialization failure, plus resolved Node.js and normalized PATH handling
  in the deployment launch helper.
- Per-attempt disk reservation and shared node-wide monitoring, complete startup orphan recovery,
  and automatic capacity pause/resume without consuming queued attempts.
- One persistent shared bare Git repository per configured public GitHub repository.
- Bounded shared-repository accounting with a total cache limit, minimum-free-disk guard, bounded
  scans, conservative age-based reflog expiry and GC, and node drain when reclamation is insufficient.
- A cancellable global shared-cache mutation lock for whole-root accounting and bare-repository
  setup/cleanup, plus per-repository operation ordering.
- Full-history fetch of the immutable `baseSha` and GitHub pull request head ref, supporting arbitrary
  base branches without a `main` assumption or fallback and disabling fetch auto-maintenance.
- Immutable base/head commit checks, merge-base validation, detached worktree creation, and final
  `HEAD` verification.
- Codex workspace-write execution with outbound network access for trusted admitted code.
- Legacy pull request prompt authorization to inspect, edit, build, and test inside its disposable
  worktree. Profile execution keeps model edits separate from original-source runner validation.
- Inline schema-validated result submission.
- V2 inline results separate model verification claims from captured command exits and final
  worktree state; bounded redacted failure diagnostics are persisted and shown in job details.
- V1 queued templates and stored results remain supported across the schema 8+ upgrade path.
- Progress deadline refreshes only on observed Codex stdout/stderr activity; silent execution no
  longer receives synthetic keepalive progress.

### Dashboard and repository gates

- The Jobs page exposes an on-demand detail drawer for execution state, failures, result digests,
  PR findings, and issue-triage projections.
- Repository CI runs Node typecheck, tests, builds, and lint on Linux; ProcessHost tests, vet, and
  Windows cross-builds on Linux; and Worker typecheck/tests/build, ProcessHost tests, and
  deployment-script checks on Windows.
- Manual Windows deployment has a complete configuration template, guarded launch helper, and an
  explicit E2E evidence runbook. The evidence helper records per-repository and per-attempt
  observations across capture stages, never certifies acceptance, and preserves previous captures.
  Standalone PowerShell regression checks cover the collector and run in Windows CI.

### Removed unpublished prototypes

The following are deliberately absent and have no migration or compatibility layer:

- Control/Executor Worker services and role bundles;
- the TypeScript and native local RPC protocols between those roles;
- the native ServiceHost, split installer, Worker package, and Ed25519 release-signing path;
- the original result-artifact contracts, storage/reconciliation, and artifact Worker
  Threads; and
- artifact-backed completion modes and their unpublished compatibility paths.

ADR 0029 remains the decision for these removals. The new bounded M16 evidence channel is governed
by ADR 0031; it must not be described as the restoration of those prototypes.

## Retained foundation contracts

This section records the earlier architecture baseline. The current validation-platform tables
above describe its later extensions and acceptance boundaries.

- Worker authentication: one node-scoped Bearer Token stored at
  `C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json`.
- Operator authentication: explicit `loopback` or `oidc` mode.
- Pull request repository cache: `<git-shared-root>\repository-<githubRepositoryId>.git`.
- Shared repository policy: bounded total bytes and free-space guard with conservative Worker-owned
  maintenance only when worktree metadata is inactive.
- Local execution singleton: one global ProcessHost mutex per resolved Worker data root.
- Task checkout: detached worktree below the per-attempt workspace directory.
- Codex identity: persistent `WORKER_EXECUTION_PROFILE_DIRECTORY`, provisioned under the Worker
  account with `config.toml` and supported file/keyring or provider-command authentication.
- Completion: bounded inline `{ resultDigest, result }`; profile results reference independently
  finalized evidence without introducing an artifact-backed completion mode.
- Evidence: Worker/lease-scoped uploads, Server-derived manifests and storage paths, bounded
  quotas/retention, and authenticated repository/run/job/attempt-scoped reads.
- Scheduling diagnostics: authorized current observations with separate claim-gate, prerequisite,
  and observation reasons; bounded inspection preserves uncertainty and does not allocate work.
- UI runtime: registered trusted code, owned process trees, an exclusive interactive Windows
  session or owned Web loopback service, and explicit reset. These controls are not an adversarial
  same-user or network sandbox.
- GitHub credentials: owned by the Server; not sent to the Worker or child processes.

## Scope excluded from the earlier foundation

This historical list is not a current backlog. In particular, M29 scheduling controls and M30
publication preparation/outbox now have the implemented scope and remaining acceptance boundaries
recorded above.

- Automatic Worker package distribution, installer, upgrade, repair, rollback, or signature
  verification.
- Private repository checkout credentials.
- Configured repository/global concurrency and queue limits with CAS/audit, queue-credit recovery,
  repository/class fairness, and bounded claim continuation with large-fixture latency acceptance.
- GitHub review publication or merge operations.
- General-purpose artifact distribution, reusable build packages, and video evidence.
- A repository checkout for issue-triage jobs.
- A repository-managed Windows service wrapper, automatic restart policy, or service installer.

## Verification requirements

Repository verification defaults to `test-env`; local validation requires explicit authorization
for the current task. The authorization for the 2026-09-05 exercise does not authorize local
verification of subsequent changes. The required branch gate is:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

ProcessHost Go tests and Windows cross-compilation are separate checks. Windows-native validation
is required in addition to Linux CI, which cannot establish Windows process, path, ACL, Git, or
Codex runtime behavior. The historical runtime exercise below predates the current remediation.

The 2026-09-06 remediation passed all Linux gates, 1,354 Linux Node tests, 591 native Windows Worker
tests with no skips, native Windows ProcessHost tests/vet/build, and the deployment PowerShell
checks. This includes all 14 Worker tests skipped on Linux. The remediation handoff records the
explicit authorization and separates these regression gates from historical live Codex E2E. The
current platform's authorized checks are tracked separately in the implementation ledger. The
latest M28 full Linux Server suite passed 4,205 tests with one skip across 100 files; Dashboard
passed 2,720 tests across 66 files, type checking, and production build; shared
contracts/domain/Codex packages passed 1,178 tests across 33 files.
These gates and the synthetic cross-host acceptance do not replace real-repository and production
model acceptance or complete the remaining product scope.

## Verified remote baseline

On 2026-09-05, implementation commit `3826a40` passed on `test-env` with Node.js 24.20.0 and pnpm
11.24.0:

- workspace typecheck;
- 63 test files and 961 tests: Codex 86, Contracts 8, Domain 21, Dashboard 53, Worker 387, and
  Server 406;
- all workspace builds, including the Dashboard production bundle and single Worker bundle; and
- Biome checks across 198 files.

ProcessHost passed `go test ./...` and `go vet ./...` with Go 1.26.7. The same source cross-compiled
for Windows amd64 and arm64. The repository CI additionally runs ProcessHost tests and deployment
PowerShell parser checks on a native Windows runner. At that baseline, the operator-driven Windows
E2E exercise remained outstanding; its subsequent outcome is recorded below.

The E2E acceptance follow-up fixed misleading evidence heuristics and documented the supported
GitHub authorization lifecycle used to create and cancel real review jobs. Its portable collector
regressions passed on Linux `test-env` with PowerShell 7.6.5, and Biome still passed across 198
files. These checks do not establish Windows process inspection or real release acceptance.
Those earlier checks were preparation; the subsequent authorized Windows runtime evidence is
recorded below.

## Windows runtime acceptance and closeout

The user explicitly authorized local verification and the selected real public PR targeting `dev`.
Production commit `3cf2ef9b04b03ea5e0849ed3d609e49042eb9e98` has green CI, and manual correlation
establishes healthy real success, Codex-launched build/test execution, one accepted result, fresh
active cancellation with zero accepted results, cache reuse, and recovered cleanup without drain.
The independent native audit reports no required runtime evidence gaps. The collector's automatic
`unverified` status remains intentional; the manual decision and precise evidence are linked in the
[live validation handoff](./handoff/2026-09-05-windows-e2e-live-validation.md).

Test processes are stopped, the test Worker credential is revoked, and remote token/database
cleanup is complete. The handoff records the local private-copy cleanup outcome separately from
the completed runtime acceptance, including the execution-policy block after explicit deletion
approval.
