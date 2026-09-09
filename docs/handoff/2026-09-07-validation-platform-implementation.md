# Validation Platform Implementation Ledger

Status: in progress. The accepted scope is the [validation platform roadmap](../design/2026-09-06-validation-platform-roadmap.md).

Work is paused at the user's request on 2026-09-09. The current stop point, remaining tasks and
resumption instructions are in the [paused handoff](2026-09-09-validation-platform-paused-handoff.md).
The latest added native reproduction fails with `ownership_lost`; its production fix is not
implemented. Earlier passing test counts below precede that regression.

## Current Windows application integration

The real Notepad++ Worker checkout and Release/x64 build passed at pinned commit
`2f50e44ffe9aa607a0e50e1f2ab143e0daed1391`. Actual metadata inspection exposed a shared automation ID
between a toolbar Button and a MenuItem. Windows locators now support an optional control type;
107 contract/configuration tests, 60 Windows driver tests with native fixtures, 616 selected Linux
Server/shared tests, Worker type checking and fresh Worker/Dashboard builds passed.

The first production UI execution still returned an ownership/ancestry blocker. Its original-source
build result and incomplete UI evidence were persisted; the negative case was not activated.
The Worker, Host, attempt workspace, desktop lease, Server and SSH forward were closed. Actual
Windows UI acceptance remains open while the interaction between transient launch-helper children
and native ancestry refresh is investigated. See the [retained first-run record](../../artifacts/m34-windows-acceptance-20260909/FIRST-RUN.md).

## Current integration status: real Issue reproduction

The actual public `fishjar/kiss-translator` Issue #1064 now has a measured reproduction at the
reported v2.0.32 commit `7dfc03ebc7f10530681109f6a5aec982a5573936`. A normal model-free WorkerService
checked out the exact source and executed the original timedtext preprocessing and built-in rule
segmentation through a reviewed, read-only probe. The reported screenshot sample produced a
3,000 ms duration rather than reaching the later newline at 9,630 ms. A punctuation-space control
produced the same end time. Nineteen typed observations were accepted in one complete inline receipt.

The frozen claim, Worker assessment, independent Server calculation and current/history projection
agree on `confirmed` with complete coverage of this single configured case. The production Dashboard
showed the exact source, current and recorded case states, and expected/actual values. Initial browser
readback failed because the fixture omitted the normal signed-out route; a separate read-only
service fixed that fixture route and read the existing result without another execution. Both
histories are retained. Nineteen selected business tables and 26 rows remained unchanged, and all
observed processes, listeners and the temporary browser tab closed.

The real Issue identity, content, author and open state are retained. Assignment authority and
operator/Worker credentials are explicitly isolated fixture data, not a real GitHub assignment.
This acceptance covers the reported shared timing behavior, not installed-extension interaction,
video playback, full VTT serialization or a translation provider. The earlier real Web profile
acceptance remains separate. See the [real Issue acceptance](../design/2026-09-09-real-issue-acceptance.md)
and [execution record](../../artifacts/m33-real-issue-20260909/REPORT.md).

## Previous integration status: model-free execution

The explicit `WORKER_MODEL_EXECUTION_ENABLED=false` mode no longer requires Codex executable,
version or provider/profile configuration. Its runtime-derived opt-out excludes mandatory-model
tasks at shared Server admission/claim matching and at the Worker execution boundary. Optional
summaries cannot silently activate in this mode. Evaluation capability and execution remain closed.

The captured implementation passed 2,691 Worker tests with 28 conditional skips, 2,346 shared tests,
and 5,970 Linux Server tests with one platform skip. Real Windows factory startup executed Git and
closed its native Host without model configuration. A connected production WorkerService then
registered, claimed and completed the ten reviewed Node script tests from the pinned public
`moooyo/kiss-translator-m3` commit. The Server retained original source and no model request. A second
task reached an actual owned wait process, received heartbeat cancellation, reported
`CANCELLED_BY_SERVER`, and removed its attempt workspace. The Server, Worker, Host and SSH forward
closed, with no remaining observed processes or listeners.

The original client harness exited one because its observer marked only fulfilled completion
promises as settled; normal cancellation rejects that promise after the native exit. Its failed
report is preserved. Independent Server/audit reads, production lifecycle inspection, process
absence and workspace checks resolve the acceptance without rerunning tasks or rewriting history.
See the [connected delivery record](../../artifacts/m32-evaluations-20260908/model-free-worker-service-delivery-notes.md).

Mapped historical Issue evaluation configuration, owner observations, adjudication and persisted
assessment interfaces have also been integrated since the older increments below. Their connected
fixtures do not establish actual Evaluation/model execution. Existing M24 headless and M26 Web
project acceptance remain separate, valid records for their tested scenarios.

Populated schema-27 history has now upgraded through the current production owner to schema 33:
74 old tables and 101 rows preserved their types, bytes, rowids and foreign keys; the finalized
evidence retained its inode and hash. Twelve readers and five exact old-receipt replays passed.
The notification query clock was checked separately from immutable historical timestamps. This
uses synthetic data and tmpfs, with a pending publication and no delivery transport; it does not
claim publication-attempt history or power-loss recovery. See the
[upgrade acceptance](../../artifacts/m32-evaluations-20260908/populated-upgrade/REPORT.md).

Remaining delivery work is real model/command boundary acceptance and Evaluation execution, actual
Windows application scenarios, and the intended deployment's
OIDC, multi-user and persistent-storage acceptance. Private checkout configuration
and build artifact reuse remain separate unresolved scope/implementation items. The connected run
above tests ordinary headless execution; it does not establish complete project build/UI coverage,
an approval recommendation, or production deployment. No real PR/Issue write is authorized or
performed by these tests.

## Previous increment: evaluation evidence delivery

Evaluation results now have dedicated evidence-list, manifest and content APIs. Every content
chunk rechecks repository read access and exact sealed result/report membership; the shared
ordinary/evaluation stream validator pins metadata and checks content integrity. The Dashboard
previews PNG and bounded strict text/JSON, verifies complete downloaded bytes, cancels stale
reads and releases preview URLs. A selected-file 404 triggers access revalidation.

Connected browser acceptance proved result selection, image and text display, actual downloaded
file hashes, mid-download grant revocation, viewer restoration and repository switching. The
isolated fixture used real Server/storage/session/evidence machinery and synthetic observations;
it did not execute a repository command, model or Windows application. The final fixture closed
with unchanged immutable data and zero errors. Failed preparation/timing attempts remain explicit.
Full regression passed 5,195 Server tests plus one Windows-only skip, 1,777 shared tests and 3,405
Dashboard tests; the final 404 branch also passed 71 targeted tests and a fresh production build.
See [evidence delivery records](../../artifacts/m32-evaluations-20260908/evidence-delivery-notes.md).

Actual Windows/Web evaluation execution, model identity/confinement, owner observations, human
adjudication, persisted assessments and the wider roadmap remain open.

## Previous increment: evaluation result reads

Evaluation cells now have an independent, repository-scoped result endpoint and Dashboard drawer.
The owner binds the selected result to the complete sealed V2 source/configuration, Job and
successful attempt. It checks current read permission before asynchronous evidence verification
and again in the final synchronous projection, where it consumes the operation-scoped proof.
Ordinary V1 result/approval semantics are not reused. The display separates checks, execution
diagnostics, current evidence state and normalized model advice; original finding ordinals retain
stable result-bound occurrence IDs. No evidence proof means unavailable evidence, even when a
historical database bit says complete.

Real synthetic-file acceptance exposed the old upload guard's V1-only context check. A dedicated
V2 upload branch now verifies the complete sealed execution template and current lease, active
batch and enabled repository. Cancellation and disablement reject further upload/finalization,
while authorized historical reads remain possible. Tests use an actual compiled verifier Worker
for file hashes; the test fixture never executes a repository command or a model.

The scorer now emits `explicit-matching-v2`: an owner-projected non-required model dimension is
excluded from model/finding denominators while check and execution coverage stay independent.
Version 1 reports remain readable and frozen scoring plans retain their original bytes/digests.
The owner observation/adjudication/assessment publication pipeline remains to be implemented.

The result drawer validates all available matrix/source/configuration/Job/attempt identities,
hides stale content during refresh or failure, and supports an explicit evidence refresh. It
currently lists real evidence IDs; evaluation-scoped file preview/download is still outstanding.
Connected result-drawer browser acceptance, real Windows/Web evaluation execution and the wider
roadmap are also open. Verification details and failed-then-corrected test harness records are in
[the result-read increment notes](../../artifacts/m32-evaluations-20260908/result-read-notes.md).

## Product decisions

- Repository identity is the numeric GitHub ID, with a stable internal ID. Repository names may change.
- PR static/build and PR UI are separate workflows. Windows desktop and Web are both required product targets.
- Prompts and execution profiles are independently versioned. New bindings apply to future authorized activations; queued and running jobs retain their snapshots.
- UI execution needs actual assertions, environment lifecycle management, and evidence delivery. A target selector or a successful launch command does not establish UI coverage.
- Model advice, runner checks, policy eligibility, human decisions, and GitHub publication remain separate facts.
- Ant Design is retained. Functional completeness takes priority over another visual redesign.
- The user explicitly prohibits automated test writes to any repository's PRs/issues without
  approval of the exact targets, content, and operations. Local/test-env execution approval does
  not grant external-write authority. [AGENTS.md](../../AGENTS.md) records the persistent rule.

## Integrated foundation

- Migrations 12 and 13 add the managed repository registry, configuration audit, immutable Prompt/profile versions, bindings, and binding history.
- Authenticated management APIs provide repository resolution and connection checks, optimistic concurrency, Prompt drafts/preview/publication, and profile publication/bindings.
- Dashboard repository scope is an exact server-side query constraint. PR and Issue workspaces remain separate. Management pages consume strict contracts and preserve unsaved drafts during a temporary scope-confirmation failure.
- Prompt preview renders the same work-item context as job creation and hashes the rendered content. Stored context is checked against authoritative repository, work-item, and revision identities.
- Managed GitHub runtime configuration reads repository policy and published Prompt bindings from the database. Legacy environment configuration is a one-time bootstrap, not an ongoing overwrite source.
- Paused repositories and former reviewers continue observing closure and withdrawal. Observation alone cannot schedule work. Admission rechecks current repository policy inside the database transaction.
- Result contracts distinguish Worker check evidence from model summaries. Approval policy rejects missing required coverage, old revisions, plan mismatches, incomplete evidence, and modified-source verification.

## Run, result, and execution components

- M14 persists immutable execution plans, frozen rendered prompts, request snapshots, job associations, and audit records. Same-intent operator retries return the original plan.
- M15 stores typed validation results separately from legacy review results. Completion validates lease ownership, revision, profile/prompt identity, required checks, diagnostics, and immutable replay.
- M16 provides bounded resumable evidence upload, finalization, scoped reads/downloads, quotas, retention, and cleanup. Production storage is Linux-only and verifies regular single-link files, identity, size, and SHA-256.
- Production completion and result reads use a dedicated read-only verifier for whole-file hashes and UI step semantics. Screenshot references must be finalized, belong to the same check, and match the frozen scenario and steps file. The SQLite owner consumes scoped proofs synchronously after rechecking current authority.
- M17 adds bounded pending dispatch, repository rotation, rerun idempotency, cancellation, and control audit. Initial operator creation and dispatch share a transaction; the existing lease-reaper loop also scans pending requests.
- M18 adds automatic GitHub source activation and legacy/new-run routing. Source sequences distinguish A-to-B-to-A changes; dispatch and result eligibility reject obsolete automatic activations. Existing legacy jobs remain pinned for their source activation and epoch. Strict authorization policies never turn a denied revision observation into new execution authority.
- Independent assignment/review-request authorization epochs own separate runs. Two active epochs may therefore produce two runs for the same revision; transport replays reuse the epoch and run. Matching profile jobs share a concurrency key.
- Run list/detail/history/result APIs expose bounded projections. Authenticated rerun/cancel APIs enforce scope, session, Origin, and recovery read-only mode.
- Headless checks execute setup/build/test/cleanup phases. Failed compilation completes execution with failed validation checks, rather than fabricating an infrastructure failure.
- Windows UI Automation and Chromium/Playwright drivers execute deterministic assertions with evidence, readiness, reset, cancellation, and cleanup. Windows requires an active unlocked interactive session and an exclusive session lease.
- ProcessHost provides precise Windows process creation identity. Owned processes are drained before capacity is reused; uncertain desktop restoration quarantines the lease.
- The Worker evidence uploader streams bounded chunks and remaps local screenshot IDs into finalized server IDs in a separate normalized steps file.
- Validation and model review use separate workspaces with the same real lease identity. Issue validation checks out only the explicitly authorized commit; triage stays snapshot-only.
- Runtime configuration validates command registrations, protected secret references, browser/driver assets, and target prerequisites. Composite executor/startup and Dashboard evidence/action wiring are complete, with cross-host component and connected-browser acceptance recorded below. Web also validates the PowerShell ownership probe; capability labels reflect actual prepared components rather than deployment-supplied claims.
- Required launch readiness is read from lifecycle diagnostics, not a nonexistent launch check. UI model advice is optional; static review and issue triage still require their model result. Deterministic UI coverage remains independent of model advice.

UI profiles currently build their own exact source; build artifact reuse is not implemented. Web navigation and process-ownership checks are not an OS/network sandbox. Driver readiness alone does not establish full product acceptance.

## Verification recorded so far

- Pinned local Node 24.20 is used for authorized unit tests and frontend checks. Production SQLite/server verification uses an isolated Linux `test-env` workspace.
- Repository routes: 139 tests passed. Prompt/profile routes: 190 tests passed.
- Repository persistence and Prompt preview: 80 tests passed after fixing relational identity checks.
- Dashboard passed 1,120 tests before the final M18 freshness adjustment; that adjustment passed 231 targeted tests, type checking, and production build. The sample preview was restored at port 8000. The TypeBox declaration mismatch was fixed by consuming contracts package exports.
- The M18 full server regression passed 2,173 tests with one skip and one old-schema fixture failure. The fixture was corrected to construct a real M14 database before upgrading, and all 111 tests in that file passed. No production compatibility bypass was introduced.
- The final read-model/evidence/result/dispatch integration regression passed all 325 tests on Linux after the last changes. Contracts, domain, Codex, and production source-boundary suites passed all 618 tests in the clean Linux source snapshot.
- Worker production build and the full suite passed 1,088 tests with 18 optional native checks skipped in that invocation. The composite executor has 31 focused passing cases; real native driver checks are recorded separately below.
- Real Linux completion integration passed 15 tests, including failed validation, terminal replay, lease/cancellation fences, evidence scope, and old V1/V2 compatibility.
- Production read-model tests passed 160 cases on Linux, including valid-SHA forged steps, incorrect assertions/order, invalid UTF-8, size bounds, screenshot references, required launch, optional UI advice, and M18 source freshness.
- Run creation, action routes, dispatch, and background integration passed 251 targeted tests after initial wiring. Workspace tests passed 94 cases after exact issue-source and separate model-workspace changes.
- Windows and Web drivers and the UI coordinator passed real process-based fixtures, including failed assertions, screenshots, exclusive lease handling, cancellation, and process draining. The Web fixture used installed Chromium Headless Shell; an unsupported system Chrome launch was correctly blocked.
- Evidence uploader/HTTP tests include a real loopback interrupted-chunk retry and final digest verification. All 46 Linux evidence filesystem tests passed, including 34 valid finalized references and rejection beyond the per-check limit.
- Cross-host component assembly passed eight cases: real compilation success/failure, Web and Windows UI success/failure, fabricated steps remaining ineligible, and cancellation fencing. All cases ended with zero active ProcessHost requests. The [acceptance report](../../artifacts/profile-assembly-20260907/ACCEPTANCE.md) explicitly records fixture checkout/disk callbacks and a model stub; this does not establish real-repository/model acceptance.
- Browser verification found and fixed two presentation errors: completed validation jobs were shown as review-ready with a legacy empty-result panel, and successful UI runs without optional model advice were rejected by the client. The primary result action now opens the current run and its tracks. All 1,137 frontend tests, type checking, and production build passed; connected browser checks confirmed real PNG rendering, preserved history, and rerun/cancel. Browser download-file creation could not be independently confirmed, although authenticated downloads and exact bytes were verified by the cross-host harness.

## Latest integration verification

- Optional UI/Issue model summaries are wired through runtime configuration, the shared Codex process layer, the summary adapter, and `ProfileJobExecutor`. `WORKER_VALIDATION_SUMMARY_ENABLED` defaults to false. A single adapter budget accounts for the remaining hard/no-progress deadlines and teardown/submission reserves. Runner checks, source state, finalized evidence, and Issue conclusions remain separate from optional model advice. The full Worker suite passed 1,199 tests with 18 optional native checks skipped; type checking and the production build passed.
- The native read-only probe exercised the pinned Codex 0.145.0 unelevated helper: fixture reads succeeded and two writes were denied. Loopback TCP was allowed. It did not invoke a provider/model or the production elevated `codex exec` summary path. [The summary design](../design/2026-09-07-optional-validation-summary.md) records that remaining acceptance boundary. The eight-case component fixture run did not exercise the new optional summary.
- The [P1 evidence verifier](../design/2026-09-07-evidence-verification-control-plane.md) is integrated into finalization, V2 completion, and Run detail/result reads. Requests settle independently; no SQLite transaction crosses a verifier await. Finalization coalesces exact lease/asset retries, and concurrent terminal submissions retain digest replay/conflict behavior. Shutdown stops admission, aborts preflights, drains their continuations, confirms verifier exit, and closes SQLite last.
- Cold result reads preserve runner outcomes with `evidenceVerificationPending: true` and incomplete coverage. Current-operation proofs and fresh file-identity probes control admission. Reusable cache entries require full verification after a conservative timestamp stability window on known local filesystems; unknown/young files use fresh asynchronous verification. Cached metadata is not claimed to defend against privileged filesystem changes or silent bit rot.
- The full Linux Server suite passed **2,418 tests with one skip**, including ten real `DatabaseClient`/fixed-verifier concurrency cases and sixteen completion integration cases. Tests exercise 8 MiB finalization, 32 MiB multi-asset verification, concurrent heartbeat/cancellation, cold reads, deleted-file terminal replay, source closure, Worker supersession, duplicate/conflicting completion, exact-lease finalization coalescing, and shutdown. The completion fixtures now require real scoped steps for complete UI evidence; PNG/trace alone remain incomplete.
- Final contracts/domain/Codex regression passed **625 tests** on the clean Linux source snapshot. The exact verifier launch/import sites are reviewed by the source-boundary suite, including 26 negative code mutations; arbitrary Worker paths/loaders remain forbidden. The final HTTP shutdown/error mapping passed 202 route tests after adding explicit retryable handling for database-owner shutdown.
- The full Dashboard suite passed **1,152 tests**, formal type checking, production build, and Biome. Required pending coverage prevents approval eligibility; optional pending coverage remains visible without blocking otherwise satisfied required checks. Foreground refresh backs off and stops after six rounds, errors, or a hidden view. The sample preview is running at port 8000; connected browser verification is recorded separately from the earlier 1,137-test baseline.
- P1 connected acceptance re-read five existing Web/Windows results through the real HTTP API: all began pending, four reached complete evidence, and fabricated steps remained incomplete. All five PNG hashes/sizes and all seven historical business-table row digests stayed unchanged. Browser DOM observations confirmed pending cleared without a manual refresh while failed checks stayed failed; the PNG preview decoded correctly and the console had no errors. The initial list-frame screenshot is explicitly excluded as visual proof of pending. [HTTP/history/lifecycle evidence](../../artifacts/p1-evidence-read-20260907/REPORT.md) and [browser evidence](../../artifacts/dashboard-e2e/p1-verification.json) record the exact scope. Temporary API/tunnel ports were released; only the port 8000 sample preview remains running.

## M19 repository access closeout

- M19 adds exact `(issuer, subject)` repository grants with viewer, reviewer, maintainer, and admin
  roles. Platform administrators come only from trusted Server configuration; OIDC deployments
  must set `AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON`. No old login is implicitly promoted.
- Every Operator HTTP database request uses the session-bound operation allowlist. Resource
  ownership is resolved at the database boundary, lists apply access predicates before totals and
  pagination, and prepared evidence reads recheck access after asynchronous verification. Each
  download chunk reauthorizes. Worker and internal Server operations retain their separate trusted
  path.
- Membership changes use version checks, intent-bound replay receipts, required reasons, immutable
  audits, and last-repository-admin safeguards. Dashboard controls follow effective permissions;
  member management and history are available from Repositories. A change of authenticated
  principal replaces the query cache and selected route state. Ordinary same-principal permission
  refresh preserves unsaved configuration drafts; failed authorization never enables sample data.
- The complete Linux Server regression passed **2,771 tests with one skip**. Eleven real database
  integration cases include cross-repository isolation, four roles, per-chunk revocation, and two
  32 MiB prepared-read revocation races. Final contracts/domain/Codex/source-boundary tests passed
  **625/625**. Dashboard passed **1,511/1,511**, formal type checking, production build, and Biome.
  The unchanged Worker retains its recorded **1,199 passed / 18 skipped** baseline.
- [Real HTTP and browser acceptance](../../artifacts/m19-access-20260907/REPORT.md) upgraded the
  existing synthetic M18 database to M19 and completed grant/change/revoke through the API and
  production Dashboard. All seven historical business-table digests remained unchanged. Only two
  fixture membership tombstones and six access audit rows were added. No GitHub connection or
  external PR/Issue write occurred. Temporary API/tunnel services stopped and released their ports.
- The connected fixture authenticated only its configured loopback platform administrator. Real
  lower-role browser sessions and OIDC-provider login remain deployment acceptance boundaries;
  they must not be inferred from unit/SSR/database coverage. The port 8000 preview remains running
  with explicit sample data. [Frontend evidence](../../artifacts/dashboard-e2e/m19-verification.json)
  records the exact production build and stable screenshots.
- [The access design](../design/2026-09-07-operator-repository-access.md) documents the upgrade,
  authority boundaries, and API contracts. M19 does not implement human decisions or publication.

## M20a human decisions

- M20 adds an immutable per-Run decision stream, with exact actor identity, required reasons,
  optimistic version checks, intent-bound historical receipts, and withdrawal tombstones. PR
  approvals and requests for changes remain distinct from comments and qualified maintainer
  exceptions. Issue runs support notes and requests for more information without changing runner
  reproduction conclusions.
- The Server computes a versioned result-set digest from every planned request, including optional
  and unscheduled requests, latest Jobs/activations/attempts/results, source sequence, and current
  authorization configuration. Rerun enqueue and A-to-B-to-A source changes stale old decisions;
  heartbeat and evidence-cache state do not. New approval rechecks access, current source, prepared
  evidence, policy, and version in one final short transaction. Historical replay reauthorizes but
  does not require retained evidence or restore an old decision.
- Private full policy and result snapshots are validated on append and stored immutably. Public
  state/history/replay queries select only compact receipt columns and verify their receipt digest
  and stream relationships. A history page no longer parses up to twenty 16 MiB private policies
  in the SQLite owner. Ordinary reads do not claim to verify private audit bodies against storage
  corruption; those remain under the trusted immutable database boundary.
- Dashboard shows the recorded decision, actor, reason, source/result binding, current applicability,
  and paginated history independently of model advice and policy. Unknown transport outcomes allow
  exact intent retries; conflicts require explicit refreshed review before a new submission.
  Foreground polling updates other operators' changes without resetting drafts and stops when the
  page is hidden, access is unavailable, or a read fails. No GitHub publication path is invoked.
- Final Linux Server regression passed **3,078 tests with one skip**. Contracts/domain/Codex/source
  boundaries passed **751/751**. Dashboard passed **1,770/1,770**, formal type checking, production
  build, and Biome. Eleven real DatabaseClient integration tests include cold/expired evidence,
  role changes, optional reruns, manual A-to-B-to-A, and 32 MiB evidence-preflight revocation/rerun
  races. The 56 persistence tests include twenty >2 MiB private policy bodies with public-only
  history reads returning less than 32 KiB.
- The initial full regression caught an outdated migration-count fixture and a test expecting
  ordinary reads to rehash private policy after the public-projection change. Both were updated
  to the explicit M20 storage/read boundary; the complete final suite passed. See
  [the decision design](../design/2026-09-07-run-human-decisions.md) for the workflow and limits.
- [Connected synthetic HTTP/browser acceptance](../../artifacts/m20-decisions-20260907/REPORT.md)
  passed against the production frontend `umi.59249c70.js`. Exactly six scoped decision events
  were appended through the API and page. Comments preserved their prior decisions; the final
  withdrawal remained separate from satisfied policy eligibility. Historical receipts and rejected
  conflicts added no events. All nine existing business/access table digests and the retained
  Windows PNG were unchanged. Four stable screenshots, eight DOM observations, and zero console
  errors are in [the browser record](../../artifacts/dashboard-e2e/m20-verification.json).
- The connected fixture used its configured loopback platform administrator, not a live OIDC or
  lower-role browser login. It performed no new repository checkout, model execution, Windows/Web
  scenario, or external PR/Issue write. The temporary Server and tunnel stopped before their fixed
  deadline and released their ports. The fixture browser tab is closed; the port 8000 sample
  preview remains available and was independently rechecked after frontend task completion.

## M21 finding lifecycle

- M21 implements result-scoped immutable occurrence identity from result ID/digest, namespace, and
  original ordinal. Complete model text is read from one selected result, not from sorted or
  shortened previews. Failed or absent model output is distinct from a complete empty collection.
- Reviewers can accept, dismiss, resolve, and reopen findings with a reason, a per-occurrence
  version, and an exact context digest. Immutable events atomically update a protected projection.
  Historical edits remain scoped to their original result and never transfer to a replacement.
  Exact retries reauthorize and return their historical receipt without changing current state.
- Policy v2 preserves raw P0/P1 counts and separately exposes unresolved blockers. Accepted findings
  remain blocking; dismissed/resolved findings do not. Original-source checks, evidence, lifecycle,
  and current authority remain required. SnapshotV2 binds disposition versions/event IDs, so a
  reopened or otherwise changed finding invalidates approval of the prior basis.
- Migration 0021 transactionally rebuilds the decision table while preserving old JSON, digests,
  IDs, and self references. V1/V1 and V2/V2 snapshot/policy pairs remain explicit. The three relevant
  M21 tables use WITHOUT ROWID to prevent physical-row replacement bypasses; immutable event and
  projection triggers retain append-only semantics. Migration 0020 is unchanged.
- Explicit result comparison uses unique exact content matches with only line-ending normalization.
  It labels persistent, new, not-observed-again, and incomparable findings. Different configuration,
  unavailable models, or ambiguous candidates cannot become automatic resolution. Dashboard
  disposition/history/comparison controls use current permissions and preserve drafts across
  refreshes; connected state changes also refresh Run policy and decision applicability.
- Final Linux Server regression passed **3,623 tests with one skip**, and shared contracts/domain/
  Codex/source boundaries passed **878/878**. Dashboard passed **2,125/2,125**, formal type checking,
  production build, and Biome. Eleven real DatabaseClient tests include Issue observations and a
  32 MiB verification race: a concurrent reopen completes, then the old approval conflicts without
  an audit insertion. Other cases cover optional P1 findings, accepted-vs-dismissed policy, missing
  evidence/failed checks, stale drafts, reruns, history, and conservative comparison.
- Integration review fixed two gaps before final regression: the old human-decision HTTP validator
  still rejected v2 eligible responses with disposed raw P0/P1 findings; and legal full-content
  finding pages could exceed the previous 1 MiB limit after JSON escaping. Both have explicit
  regressions. Finding responses now permit 2 MiB without truncating original model text.
- [Connected synthetic HTTP/browser acceptance](../../artifacts/m21-findings-20260907/REPORT.md)
  passed against `umi.1c9b6417.js`. Two prepared results each contained twelve findings, including
  an ordinal-eight long body. HTTP and page actions created exactly five finding events, two
  projections, and one platform approval. Reopening blocked eligibility and made the old approval
  stale; resolution restored eligibility but never restored that approval. Comparison returned
  nine persistent, one new, one not-observed-again, and four ambiguous rows.
- All forty-eight pre-existing non-authentication tables retained full logical row hashes,
  including original model/report JSON. The 1,228-character finding text and tail marker remained
  visible. Four stable screenshots and zero console errors are in
  [the browser record](../../artifacts/dashboard-e2e/m21-verification.json). The temporary API and
  tunnel stopped before their fixed deadline and released both ports; the fixture browser closed.
- This connected acceptance used one synthetic administrator and schema-valid prepared Worker
  results; it did not execute a compiler, model, GitHub checkout, or Windows/Web scenario. There
  were no external PR/Issue writes. Development samples explicitly decline simulated disposition
  writes and never replace failed production HTTP responses. The root-owned sample preview at
  port 8000 remains available.
- [The finding design](../design/2026-09-07-finding-lifecycle.md) records exact identities, policy
  semantics, migration guarantees, and acceptance boundaries. Finding resolution remains a human
  record, not evidence that an Issue was reproduced or fixed.

## M22 reproduction backend and Worker integration

- Frozen Issue cases pin the exact source authorization, Issue revision, published profile version,
  and typed present/absent predicates. Only selected requests receive the complete binding; other
  required requests and legacy plan/envelope hashes retain their previous representation.
- Headless and UI command bridges capture bounded, complete structured probe output after process
  and stream cleanup. Original unsafe values become unavailable without replacement text. The
  composer binds receipts to the actual job and attempt, then computes a deterministic assessment
  from receipts and finalized UI observations before and after optional model work. Model context
  and remaining output capacity include these facts; advice cannot override them.
- Windows and Web drivers implement an explicit observation protocol, clear stale measurements,
  distinguish complete assertion mismatches from capture failures, and preserve stop-on-failure
  sequencing. Screenshots remain in memory until capture safety checks pass. Mapped UI rejects
  command secret references; mapped Web requires an explicitly published `trace: "off"` policy.
  This slice does not establish authenticated UI reproduction support.
- The fixed read-only verifier returns only selected typed facts with their own evidence identities.
  The coordinator binds the selection to its opaque, expiring proof and rechecks authority and
  asset identity before admission. SQLite performs no evidence file reads across this boundary.
- Server completion independently validates probe scope, fields, hashes, and settled diagnostics,
  recomputes the assessment, and rechecks live Issue/repository authority in the final transaction.
  Current Run and case projections distinguish recorded findings from current source, replacement,
  missing-evidence, and pending-verification states. The case read endpoint is repository-authorized
  and bounded to 2 MiB; operator creation accepts the bounded reproduction request.
- Migration 0022 rebuilds the M14 association trigger with exact derived protocol labels and full
  binding equality. All original identity/authorization guards remain. Existing result, event,
  prompt, and profile bytes are not rewritten. New runtime labels require actual prepared support;
  the UI capability is withheld if any configured driver fails its real protocol handshake.
- Windows Worker regression: **1,310 passed, 28 environment-dependent tests skipped**. Explicitly
  enabled native Windows UI fixtures: **52/52 passed**. Both freshly built driver entries returned
  `uiAssertionObservation1`; Worker build/type checking and changed-source Biome passed. See
  [Worker verification](../../artifacts/m22-worker-verification.json) and its linked JSON reports.
- Clean Linux shared package/source-boundary regression: **1,003/1,003 passed**. Reproduction
  completion/migration/projection tests: **158/158 passed**, including pending UI proof versus an
  already known unsafe probe obstruction. The final serial Server regression passed **3,766 tests
  with one skip**; see [the complete report](../../artifacts/m22-server-serial-tests.json). Earlier
  parallel runs had transient test/SSH timeouts and are not recorded as passes.
- The subsequent Dashboard and connected slice below closes authoring, presentation, and isolated
  cross-host acceptance. The backend-only checks above did not execute a real repository checkout
  or production model. No external PR/Issue writes occurred.

## M22 Dashboard and connected acceptance

- Issue Run creation now includes optional reproduction cases with published profile selection,
  exact typed predicates, explicit absent signatures, and preconditions. The browser preserves
  required profiles, rejects conflicting/unreachable conditions and stale versions, and retains
  immutable idempotent request snapshots. The complete request remains bounded to 2 MiB.
- Profile authoring exposes optional typed test-output declarations and explicit Web trace policy.
  Structured edits preserve the full command configuration. Published versions remain immutable;
  publication does not implicitly replace the enabled repository binding.
- Run and report views distinguish current and recorded case states, show expected/actual facts,
  and provide exact-attempt evidence previews. Settled mapped summaries refresh every 30 seconds
  while visible; the existing bounded pending-verification window is retained. Issue views do not
  display the unrelated PR approval-policy panel. Sample mode explicitly declines mapped execution
  rather than manufacturing a result.
- Final Dashboard regression passed **2,414/2,414**, standalone and formal type checking, and
  production build. The connected build was `umi.5eb3f343.js`. The existing source/result identity,
  session/permission, cancellation, typed false/zero/empty-string, and response-budget checks remain.
- [Connected acceptance](../../artifacts/m22-connected-20260907/REPORT.md) used the actual
  ProfileJobExecutor, ProcessHost, deterministic runners, both UI drivers, evidence HTTP APIs,
  Linux SQLite owner, and independent evidence verifier. Workspaces cloned an isolated local Git
  commit and verified actual HEAD/status; disk monitoring remained an explicit fixture callback.
  Headless measured `Duplicate`, Windows measured `Waiting` despite a failed `Ready` assertion,
  and Web measured `Ready` for an explicit absent signature. The aggregate was confirmed/complete.
- Real completion exposed a read-model defect missed by synthetic completion setup: successful
  jobs clear their active attempt pointer. The reproduction query now resolves the immutable
  succeeded attempt without requiring that active pointer. All other identity/digest/source guards
  remain. Six focused regressions and **163/163** result tests passed on Linux; the original three
  accepted results then passed HTTP re-verification without execution or result rewriting.
- Root's visible browser rejected identical present/absent signatures and created a valid isolated
  Run with one Web case and all three required v1 profiles. It edited and published headless v2;
  authenticated comparison verified only the field description changed and the binding stayed v1.
  Actual PNG preview showed the owned Windows fixture's `Waiting` status.
- A Windows replacement became pending without reusing its old positive result; an Issue revision
  change made all current cases historical. Before/after exports proved every original accepted
  result row, byte digest, and recorded assessment unchanged. Separate browser recordings contain
  baseline, predicate/evidence, pending, and stale screenshots with zero page/console errors and no
  requests outside the fixture origin.
- Root stopped the original API before its deadline to load the read-model correction, retaining
  its shutdown record and accepted data. The replacement API stopped gracefully at
  `2026-09-07T01:34:01.199Z`, before its `01:38:23.613Z` deadline. Both final fixture ports were
  released, and the no-claim readiness helper and isolated browsers exited. No external PR/Issue
  writes occurred. The root-owned port 8000 sample preview was restored and independently verified.

## M23 configuration audit reads and connected acceptance

- Added repository-scoped and platform-only global audit list/detail RPCs and authenticated GET
  routes. Repository readers see only events for their repository; membership audit remains a
  separate administrative capability. The global template filter follows recorded immutable
  version ownership and excludes repository overrides.
- Lists contain bounded metadata with 20-row pagination and deterministic timestamp/source/ID
  ordering. Details expose only retained snapshots. Old unpublished draft bodies are unavailable;
  current repository display metadata and current drafts never replace historical content.
- Migration 23 preserves both audit tables' original values and constraints while moving them to
  `STRICT, WITHOUT ROWID`, restoring immutable triggers and adding duplicate-ID protection and the
  prompt repository index. Raw-byte preservation, rollback, foreign keys, and replace/rowid cases
  passed. Clock rollback is allowed; timestamp ordering is not assumed to establish causality.
- Dashboard repository details, global Prompt activity, and template activity use authenticated,
  session-isolated reads. Sample mode explicitly has no recorded audit history. Visual acceptance
  widened the repository drawer and kept Inspect actions visible at the right edge.
- Linux Server: **3,886 passed, 1 skipped**; shared packages: **1,055 passed**; Dashboard:
  **2,596 passed**. The final visual adjustment also passed production build, standalone typecheck,
  and a fresh connected browser check. First-request global format initialization has a regression.
- The fresh synthetic fixture contained 33 primary-repository, 4 secondary-repository, 28 global,
  and 26 template-associated events. Actual HTTP and browser checks covered paging, source/actor
  identity, immutable snapshots, draft-history limits, and scope rejection. Audit bytes stayed
  identical before/after, and the browser made no outside-origin requests.
- The owned temporary API and tunnel stopped cleanly at `2026-09-07T02:05:52.195Z`, before their
  fixed deadline. The local port 8000 Sample preview was restored. No real PR/Issue write occurred.
  See [the M23 design](../design/2026-09-07-configuration-audit-reads.md) and
  [acceptance report](../../artifacts/m23-audit-20260907/REPORT.md).

## M24 production execution acceptance

- Real public-source validation uses the production Windows factory, disposable Git workspaces,
  disk accounting, ProcessHost, deterministic runner, isolated Linux API, and Dashboard result
  projection. The selected source is pinned; Issue identity, credentials, and execution history are
  synthetic. No external repository PR/Issue mutation is authorized or performed.
- Actual execution exposed and corrected the missing workspace environment variables, narrow
  active pnpm filesystem churn, redundant monitoring scans, and misleading timeout wording.
  The cleanup/source-observation budget now supports an explicit maximum of 300,000 ms while
  retaining its 30,000 ms default and all existing path, disk, and source checks.
- Shorter Windows roots avoid the observed child-process working-directory failure. The copied
  pnpm launcher also required a corrected reference to the pinned Node executable; its actual
  child invocation now reports pnpm 9.14.4. These are distinct tool-deployment findings.
- Run `2716eb05-18b3-4e53-8ed9-971693f81788` passed all three actual pinned-source commands,
  original-source verification, HTTP result equality, and complete process/workspace cleanup in
  566,426 ms. This is headless-only acceptance: the synthetic Issue has no claimed reproduction,
  no PR approval is inferred, and no model ran. Failed runs and old profile versions remain intact.
- The actual elevated Codex probe denied controlled file writes but connected to an owned
  loopback listener. Optional summaries remain disabled by default and network isolation is not
  accepted. Real report composition also fails closed on ambiguous provider-header values; no
  real value has been declassified. These model limitations are separate from headless checks.
- Full authorized Windows Worker regression: **1,370 passed, 28 skipped**; final production build,
  type checking, and focused formatting checks passed. Browser checks display the actual failed
  and successful reports with no page/console errors or outside-origin requests. The final owned
  API/database stopped at `2026-09-07T04:24:19.812Z`, before its fixed deadline; both fixture ports
  were released. See the
  [acceptance ledger](../design/2026-09-07-production-validation-acceptance.md) and
  [detailed report](../../artifacts/m24-real-execution-20260907/REPORT.md).

## M25 repository pause at claim

- Existing queued/retrying V1 and V2 jobs are held when their managed repository is paused. The
  pause check and lease allocation share one transaction and use the stable GitHub repository ID.
  Skipping a paused repository still allows other candidates to be considered.
- Existing leases remain active; enabling a repository restores eligibility under the original
  claim rules. Disabled discovered repositories are held, while legacy jobs without any managed
  repository row retain compatibility. No attempt is consumed while held.
- Linux Server build and **103/103** focused tests passed. The complete Server suite passed
  **3,896 tests with one platform-specific skip**. The ten new regressions cover both envelope
  versions, retry queues, pagination, active leases, and compatibility.
- No schema migration, configured quota, or fairness guarantee is introduced. See the
  [pause design](../design/2026-09-07-repository-pause-claims.md).

## M26 real Web acceptance

- Pinned public source `moooyo/kiss-translator-m3` at
  `d32380d8401a4d0d34f9622bfc87f676fd037214` now passes actual anonymous checkout, frozen
  dependency installation, homepage compilation, and its light/dark/light scenario through the
  production Windows Worker and isolated Linux Server. The positive Run is
  `5817afa0-af3e-4789-964f-b2fa2ac16b74`. Synthetic Issue metadata does not imply reproduction of a
  real Issue, and no model ran.
- The first attempt exposed a real lease-progress defect during successive source captures.
  The UI coordinator now reports genuine start/completion boundaries at all five existing capture
  sites. It retains the captures, disk guards, deadlines, and fencing; a stalled capture receives
  no periodic progress credit. The full Worker suite passed **1,374 tests with 28 skips**, followed
  by production build and type/format checks.
- The accepted execution passed all three checks, retained original source and no lifecycle
  blockers, and closed its owned processes/workspaces. Its original harness report remains
  `failed`: the harness incorrectly expected `cleanupState: completed` despite an empty frozen
  cleanup command list. The contract requires `not_needed`. Independent verification binds the
  unchanged raw report SHA and result digest while separately checking lifecycle closure.
- That verification downloaded nine finalized assets and checked exact identities, byte lengths,
  SHA-256 values, seven PNG dimensions, nine ordered scenario steps, and the trace archive. The
  trace was also parsed: 44 entries, two clicks, seven screenshot calls, and real frame snapshots.
  Dashboard reads, step downloads, and screenshot preview passed. An initial capture missed the
  modal paint; a separate browser run verified stable bounds, visibility, and image hit-testing,
  and root visually confirmed the actual preview. The earlier image remains excluded.
- A separate negative profile version, `743e8473-300d-4f83-8c40-b63d02c9a158`, intentionally
  mismatches the same real heading after the dark-theme action. Publishing it preserved all
  prior profile/Run/request/link/job/attempt/result/evidence rows. Run
  `b3b55865-a70f-4d23-a12f-eb5bcbe8046c` completed in 679,651 ms with acceptance passing and the
  actual validation remaining failed. The failed `assertText` retains the real heading and
  deliberately different expected value; the following click is `not_run`. Six original assets
  passed byte verification, and Dashboard result/download/preview checks passed. Its trace
  contains one click, four screenshot calls, and 42 archive entries. Raw driver `reasonCode` is
  not exposed by the saved steps contract; assertion classification follows the production parser
  invariant rather than a claimed direct read of that field.
- The positive read-only observation API and database closed at `2026-09-07T05:54:35.403Z`, before
  their fixed deadline. The negative API/database closed at `2026-09-07T06:08:57.405Z`, before its
  `06:16:34.772Z` deadline. Both tunnels and fixture ports were released, owned processes/workspaces
  were closed, and the eight previous history groups remained byte-identical after the negative
  execution. The positive raw failed-harness report and negative raw acceptance report are unchanged.
- No real repository PR/Issue write was performed. The acceptance Server disables GitHub and
  outbound fetch, browser/evidence reads are constrained to the isolated origin, and Worker
  commands receive a replaced environment without inherited GitHub tokens or summary execution.
  These controls are not network isolation for arbitrary build subprocesses; dependency scripts
  still require review and the user's external-write rule remains applicable to them.

See the [M26 design](../design/2026-09-07-real-web-acceptance.md),
[detailed acceptance report](../../artifacts/m26-real-web-20260907/REPORT.md), and
[Windows application readiness review](../design/2026-09-07-windows-acceptance-readiness.md).
The [scheduling implementation plan](../design/2026-09-07-scheduling-implementation-plan.md)
separates M27 current diagnostics and M28 admission foundation from the remaining limits and
fairness work. M27 adds no migration; M28 adds migration 24.

## M27 P0 current scheduling diagnostics

- Three authenticated GET projections now explain current repository Job, Run/request, and
  platform Job scheduling. Repository reads require exact work-item/Job or Run/request ownership;
  platform administrators can also inspect unassociated Legacy Jobs. Authorization and projection
  share one synchronous SQLite read snapshot. Worker identities, foreign concurrency holders,
  credentials, raw execution/capability payloads, and global usage counts are not exposed.
- The read model distinguishes a request without a Job from queued/retrying, executing, and
  terminal Jobs. It reuses the existing claim template/capability/envelope checks without changing
  claim ordering or transitions. Current source and authorization reasons remain prerequisites,
  not newly enforced claim gates; Legacy checks retain multi-epoch withdrawal semantics.
  Expired but unreaped and cancellation-pending attempts retain their slot occupancy.
- Matching capability, a valid wire envelope, and a free slot must belong to the same Worker.
  No-Job requests use current frozen prerequisites, existing dispatch runtime support, and the
  actual Run association count. Worker registration's default zero is not a capacity report;
  `last_seen_at` describes contact rather than the age of a capacity report.
- Existing indexes select at most 129 Worker IDs and inspect at most 128 payloads. Requirements
  have a 4,096-step traversal budget, envelope projection has a 64 MiB cumulative budget, and
  responses are bounded to 64 KiB, 32 typed reasons, and 64 displayed requirement names. Partial
  inspection and omitted names remain explicit. No observation reserves capacity or establishes
  queue position, a start time, or the absence of suitable Workers beyond its inspected scope.
- Dashboard Job and request views show live scheduling separately from frozen readiness. Visible
  waiting/executing subjects refresh every five seconds; terminal subjects stop polling. Hidden
  views, changed subjects/sessions, access loss, and failed reads clear obsolete observations.
  Sample mode does not substitute invented live observations.
- Final automated evidence: [Server](../../artifacts/m27-scheduling-diagnostics-20260907/server-full.json)
  **4,068 passed, one skipped across 95 files**;
  [shared packages](../../artifacts/m27-scheduling-diagnostics-20260907/shared-full.json)
  **1,126 passed across 30 files**;
  [Dashboard](../../artifacts/m27-scheduling-diagnostics-20260907/dashboard-full.json)
  **2,678 passed across 63 files**; focused diagnostic tests **45/45 passed**. Server build,
  Dashboard production build, and full type checking passed. Initial fixture failures remain
  recorded; their corrections preserved every production immutability and result-consistency
  guard. The wide-requirement traversal correction retained its finite budget and useful names.
- Original browser session `4b50b3e5-2a60-4a99-8e62-fbee2afcacec` passed all 12 commands,
  covering incompatible Workers, occupied slots, reported local zero, ready observations, pause,
  resume, access revocation with old DOM removal, and the restored no-Job request view. It closed
  with zero errors at `2026-09-07T07:38:02.034Z`.
- An external `test-env` restart at approximately `2026-09-07T07:40:40Z` removed the original
  `/tmp` fixture. No original `server-stopped` record is available, so original graceful Server
  closure is unproven. Recovery under `/var/tmp` used the same production source and build; it
  does not establish one uninterrupted environment lifetime. All eight restored states passed
  real HTTP checks, each reporting `coreRowsUnchanged`.
- Recovery browser evidence spans separate sessions. An SSH signer failure and a root
  orchestration omission of `completedAt` remain failed records. The final recovered session,
  `235123ca-ecdc-4fc6-a969-7b029b450f46`, passed all five commands for automatic Job/request
  refresh and closed with zero errors. Its close acknowledgement was `08:11:36.496Z`, and the
  session finished at `2026-09-07T08:11:36.634Z`. Acceptance is an aggregate of these records,
  not a claim that a single recovery controller passed uninterrupted.
- The recovered Server explicitly closed at `2026-09-07T08:11:47.350Z`, with HTTP and database
  closure confirmed, `errors: []`, and `activeFixtureLeaseCount: 0`. The target Job remained
  queued with zero attempts, while the request without a Job remained null. The aggregate
  closeout check passed and retains `uninterruptedRecoveryControllerPassed: false` and
  `originalServerGracefulShutdownProven: false`. Final local/remote fixture ports had no listeners;
  the existing port 8000 Sample preview returned HTTP 200 with `Accept: text/html` at
  `2026-09-07T08:15:11.300705Z`, with its PID unchanged.
- This M27 slice completed only P0 current waiting diagnostics; M28 admission is recorded below.
  Repository/global limits, queue-credit recovery, and repository/class fairness remain P1 work.
  The observations neither create work nor change attempts, scheduler cursors,
  immutable plans, results, or history. All acceptance controls/authentication data were isolated;
  no real PR/Issue write was authorized by this work. Explicit approval remains valid for its
  stated targets, operations, content, and execution scope; a new approval is required only when
  that scope changes.

See the [M27 design](../design/2026-09-07-current-scheduling-diagnostics.md) and
[aggregate acceptance report](../../artifacts/m27-scheduling-diagnostics-20260907/REPORT.md).

## M28 admission foundation

- Migration `0024` adds `job_admission` and `scheduling_state`. Every existing Job receives a
  production-parser backfill without changing historical bytes. Existing waiting Jobs start
  admitted with an explicit migration timestamp basis; active Jobs retain their pre-grant attempt
  base. Stable numeric GitHub buckets, explicit ownership classifications, and safe-integer
  episode/inspection sequences separate accounting from repository read authorization.
- Structurally valid Legacy/V2 initial work and reruns persist real pending Jobs without requiring
  a currently available Worker. Missing Prompt prerequisites still leave requests without Jobs.
  Failure and lease-reaping retries create new pending episodes in their existing transactions.
  Claim requires admitted state and the exact attempt base; SQL lease/active-attempt guards reject
  missing or stale admission. M14 association, M17 receipts, M18 routing, and historical data remain
  intact.
- The production pump coalesces wakes, processes a bounded captured pending pass, retains cursor
  progress, falls back every five seconds, and drains at shutdown. Strict V2 diagnostics preserve
  V1 compatibility; Job/Run/Work Item/System views distinguish pending, admitted, and no-Job states.
  Real HTTP acceptance found an omitted admission-filter whitelist entry; the route fix includes
  nine regressions. This is slice 2, not configured capacity policy or complete fairness.
- Final automated evidence: Linux Server **4,205 passed, one skipped across 100 files**; shared
  packages **1,178 passed across 33 files**; Dashboard **2,720 passed across 66 files**. Server
  build, Dashboard production build, and full type checking passed. Earlier fixture/bootstrap and
  pre-fix HTTP 400 failures remain recorded; the final pass does not erase those attempts.
- Final fresh browser session `7bdc28ca-7dcb-42d2-b3d7-1b69345e1965` passed all **20 commands**
  with `errors: []`. Actual UI cancellation made the initial Job cancelled; rerun produced an
  activation-2 pending Job. Same-actor HTTP replay left business rows unchanged. Worker registration
  caused the production pump to admit the Legacy Job and rerun before the explicit private admit
  operation, which returned `admittedJobCount: 0`. Every Job retained zero attempts; no lease was
  granted. Visual review covered missing Prompt, cancellation, rerun, admitted, and revoked views.
- Five real HTTP phases (`initial`, `rerun_pending`, `admitted`, `revoked`, `restored`) passed exact
  scope checks and unchanged core-row checks for GETs. Revoking the same cookie's repository access
  cleared old scheduling observations and Run details; restored access reloaded scoped data.
  The browser closed at `2026-09-07T10:06:29.175Z`. The final API explicitly closed at
  `2026-09-07T10:08:24.777Z`, before its `10:15:09.072Z` deadline, with `errors: []`; ports 3275 and
  39711 were released. The earlier API's closure at `09:48:48.389Z` and two bootstrap failures are
  retained separately. All fixture/auth operations were isolated; no real PR/Issue writes occurred.
- Configured repository/global limits with CAS/audit, queue-credit recovery, repository/class
  fairness, bounded claim continuation, and 100,000-Job latency acceptance remain mandatory P1
  work. This foundation does not reduce the full delivery goal. Actual Windows/model/deployment
  acceptance, publication, notifications, and evaluations remain separate unfinished work.

See the [M28 design](../design/2026-09-07-job-admission-foundation.md) and
[acceptance report](../../artifacts/m28-admission-foundation-20260907/REPORT.md).

## M29 configured scheduling acceptance

Migration 25 adds repository/global active and admitted-queue limits, immutable CAS audit,
successful admission/claim service history, bounded credit recovery, and durable Worker-specific
claim continuation. Scoped V3 diagnostics expose actual policy/usage without global count leaks.
Historical V1/V2 configuration and diagnostic shapes remain explicit and immutable.

Final regression passed: Linux Server 4,457 tests with one skip across 108 files; shared packages
1,210 tests across 35 files; Dashboard 2,788 tests across 70 files. Production builds/type checks
passed. Date-only test clocks correct ingestion/observation fixtures without changing runtime
backoff semantics. An actual polling-fanout failure led to separate verified-principal read and
mutation rate budgets behind the IP abuse boundary.

The isolated production owner fixture contained 100,000 queued Jobs across 20 repositories. The
last eligible Job was granted after 1,042 claims, with maximum 128 candidates/14 repository keys
per RPC. Claim RTT p95 was 435.606 ms; heartbeat RTT p95 439.191 ms; pending V2 cancellation
524.301 ms. Predetermined progress/latency limits passed. These are end-to-end RPC measurements,
including queue delay. The later HTTP-only change preserved the measured owner/dependency bytes.

Final connected session `ca54e478-eac7-4cf7-9a83-7c9648a394ce` passed all 37 commands, including
quota pressure/recovery, B Issue progress while A was paused, two pending reruns and cancellation,
old V1 history, both platform audit events, scope denial, and same-cookie permission loss and
restoration. Explicit read-only Refresh access actions in the audit and Run drawers avoid
depending on headless browser focus events. Restored scope was verified by two automatic reads.
No Worker process, execution attempt, model, checkout, or actual PR/Issue mutation was created.

The browser closed at `2026-09-07T13:17:47.770Z` and the API at `2026-09-07T13:18:00.406Z`.
Ports 3276/37015 and the owned browser process were confirmed absent. Earlier failures remain
recorded; controlled Chromium closure reported process exit code 1, with successful harness
coverage and no cleanup errors. The user's sample preview remains at port 8000.

See the [M29 implementation](../design/2026-09-07-configured-scheduling-policy.md) and
[acceptance report](../../artifacts/m29-scheduling-policy-20260907/REPORT.md). This completes the
scheduling plan, not the wider Windows/model/deployment/publication acceptance.

## M30 publication preview and outbox

Migration 26 adds independent repository publication policy/CAS audit, immutable confirmed
intents, fenced delivery state, control receipts, and append-only attempt events. Internal human
decisions remain separate from GitHub writes. Repository readers can inspect the complete body;
configure permission is required to enable policy, confirm, cancel, retry, or reconcile. The
publisher requires an independently configured credential and frozen numeric GitHub user identity,
and never reuses ingestion credentials. Qualified approval overrides publish explicit comments.

Final regression passed: Linux Server 4,656 tests with one skip across 115 files; shared packages
1,251 tests across 36 files; Dashboard 2,829 tests across 75 files. Server builds/type checking and
the production Dashboard build passed. A later label correction distinguishes delivery from
GET-reconciliation attempts; its four targeted Dashboard tests, type check, rebuild, and connected
acceptance passed. Failed initial migration-version fixtures, source-boundary checks, and harness
attempts remain recorded; production source-boundary guards were not weakened.

Final connected session `3ac4d944-9efb-4072-80b5-ea2ed6e14f13` passed 19 commands, all 17 coverage
requirements, and 22 screenshot checks. It verified two repositories with the same item number,
separate administrator sessions, disabled initial policies, complete body/target identity,
same-cookie permission downgrade clearing consent, restored access, a lost real confirmation
response and byte-identical change-ID replay, and separate Issue delivery. The A mock stored a
review and lost its response; the product exposed unknown state and reconciled through GETs only.
Each mock target received one POST. Both policy histories, immutable event details and all attempt
rows were read through the actual UI; before/after snapshots preserved publication state/history.

The browser closed at `2026-09-07T15:09:11.780Z`; the API and database closed with the publisher
drained at `2026-09-07T15:09:40.369Z`. Ports 3277/34921 and owned process identities were checked
absent. The controlled Chromium child reported exit code 1, while its harness completed and exited
0. Two synthetic historical execution-attempt records were retained; no new execution attempt,
real Worker, model, checkout, build, or GitHub connection occurred in the publication fixture.

The earlier 19-command core session passed without policy-history coverage. The following session
failed because its history inspector assumed reopening a still-fresh cached query would generate
a new GET. Its exact DOM/screenshots and failed report remain. The final harness uses a real page
navigation and fresh UI reads; it does not relax freshness or substitute a successful response.

See the [M30 design](../design/2026-09-07-publication-preview-and-outbox.md) and
[acceptance report](../../artifacts/m30-publication-20260907/REPORT.md). This accepts production
Dashboard/Server behavior against the injected mock transport, not actual GitHub publication,
deployed OIDC, or distributed exactly-once delivery. The wider delivery goal remains open.

## M31 operator notifications

Migration 27 records validation terminal transitions and publication outcome events in the same
transactions as their sources. The scoped repository overview, personal unread bell and inbox
support explicit read/unread/archive CAS changes, exact replay, 90-day retention and bounded
cleanup. Opening or reading a notification does not mutate personal state. Links bind the exact
historical Run/request/Job or publication, including a previous result after a new queued rerun
is cancelled. Execution completion, failed required checks and approval eligibility remain
separate facts.

The Linux full Server regression passed 4,736 tests with one platform-specific skip across 119
files; shared packages passed 1,322 tests across 37 files. The initial complete Dashboard suite
passed 3,021 tests across 87 files. Subsequent publication/ancestor fixes passed 268 targeted
tests across 13 files and ten real React/Ant Space mounting cases. These overlapping scopes are
reported separately. Production builds and type checking passed; Server/shared source bytes
remained unchanged by the final frontend repairs.

Final connected session `2af62419-7ad8-451e-ac19-e5282f958022` passed all 39 commands and 35 coverage
requirements, with 51 screenshot records and no unexpected failures. It verified two repository
scopes, personal-state isolation, notification response-loss replay, both sequential publication
access-check stages followed by byte-identical confirmation replay, uncertain delivery followed
by GET-only reconciliation, exact historical results, invalid targets, browser history, same-cookie
access revocation/restoration, and unchanged state across read-only navigation. Six natural events
remained (A four, B two), with four explicit versions of A's initial personal state. The one added
Job was cancelled without starting an attempt. Each mock target received exactly one POST.

The browser closed at `2026-09-07T18:02:22.193Z`. The API, database and publisher were explicitly
drained and closed; owned browser/tunnel processes and ports 3278/36017 were verified absent.
The browser parent and Server harnesses exited 0; controlled Chromium closure returned child
exit code 1. Earlier failed browser sessions and intermediate source/build snapshots remain
preserved. The user's sample-data preview continues at port 8000.

The final browser caught a missing-publication query-recreation loop and a real Ant Space child
identity issue that simpler component hosts did not model. Resource-specific terminal read guards,
stable semantic keys and idempotent preview effects now retain the original uncertain request
through successful permission rechecks. Old content and controls are hidden or disabled during
checking; actual access or identity changes still clear them.

See the [M31 design](../design/2026-09-07-operator-notifications.md) and
[acceptance report](../../artifacts/m31-notifications-20260907/REPORT.md). This proves connected
production behavior with synthetic historical execution records and an in-memory GitHub adapter.
No real Worker, model, checkout, repository build or upstream PR/Issue mutation occurred. Linux
storage used tmpfs because the persistent test disk was full; this is not persistent-disk or
power-loss acceptance. The six-event browser fixture does not claim sparse cursor traversal.

## M32 evaluation foundations in progress

The complete sample-set evaluation design is now recorded in
[the M32 design](../design/2026-09-08-prompt-profile-evaluations.md). It requires both baseline and
candidate to execute new Jobs against every frozen applicable sample, with explicit check
mappings, withheld human labels, independent evaluation authority, actual evidence, and immutable
assessment reports. It does not substitute historical-result scoring for actual execution.

Strict execution/scoring contracts and the deterministic domain scorer passed 235 integrated
pure tests across three files. A controlled migration-rebuild helper passed 27 Linux tests, and
the existing migration/startup regressions passed 166 tests across seven files. The Linux Server
build and type check passed. These are separate, overlapping verification scopes. The helper
tests use the complete M1-M27 chain plus a test-only M28 rebuild, not the actual evaluation schema.
The isolated Linux checkout uses tmpfs; the new helper fixtures use in-memory SQLite.

The next stage added a strict transaction-scoped source reader for current and historical
snapshots, suite/CAS/manifest contracts, and actual migration 28 with 13 evaluation tables,
explicit Run purpose, independent V2 authority and SQL purpose guards. The source reader passed
31 SQLite tests; reference/suite contracts passed 15. Actual migration tests preserve all old Run
columns and rowids plus request/audit rows and roll back the full SQL after an injected failure.
The final full Server regression passed 4,796 tests with one Windows-only skip across 121 files;
the focused evidence/rebuild scope passed 84. Build/type checks and 19-file Biome validation passed.
Earlier schema-version and trigger-order-dependent test failures remain preserved.

Source/suite owner persistence and twelve authenticated operator HTTP/RPC APIs now capture/read
sources, save/publish/list suite versions and read immutable published cases. Current permissions
precede exact receipt replay. Both trusted owner recovery mode and the HTTP replay-only marker
block new changes. Publishing advances draft CAS while retaining independent immutable version
numbers, source/expectation manifests, and all case labels. Historical reads never substitute the
current draft. Real auth/Worker-RPC/SQLite integration covers restarts, cross-repository identities,
actor changes, source/draft updates, recovery replay, and dynamic permission revocation.

Final Linux verification for this stage passed 4,916 Server tests with one Windows-only skip across
124 files, plus 1,618 shared tests across 43 files. The overlapping focused integration scope passed
136 tests across four files; source/suite/case contracts passed 61. Server build/type checking and
17-file Biome validation passed. The HTTP integration uses Fastify injection with actual auth and
the database owner, not a browser or deployed OIDC. It created no Jobs, attempts, Workers, ReviewRuns
or evaluation batches, and performed no real PR/Issue writes. Tmpfs remains the test storage.

At that stage, batch/adjudication/assessment persistence, positive evaluation matrix/Job creation,
populated-history upgrade acceptance, dispatch, Worker/protocol integration, ordinary result-query/
ingestion isolation, batch/report APIs and Dashboard were unfinished. Global Prompt version
selection must preserve the existing platform-only catalog policy. Actual model identity and execution
isolation are still required for Prompt evaluation. No evaluation capability is advertised by
Workers and no actual evaluation Job was created at that stage.
See the [partial progress report](../../artifacts/m32-evaluations-20260908/REPORT.md) for source-bound
verification and remaining gates. The full roadmap and goal remain open.

The next increment added the Dashboard HTTP service for all twelve management APIs (65 targeted
tests) and exact evaluation client paths/response bounds (46 tests), without adding an evaluation
page. Batch request and manifest contracts passed 32 tests after fixing mapping/profile and
per-case bounds. Complete frozen-source Prompt rendering now rejects truncation and freezes the
actual workflow output schema before authorization/plan digests exist. Linux build/type checks and
136 targeted Server tests passed; source-bound evidence is in the M32 report. These helpers grant
no authority and are not yet connected to batch creation or actual evaluation execution.

The internal batch owner now creates complete sealed baseline/candidate matrices with actual
published sources/configurations, new V2 Runs/requests, fresh operator evaluation authorization,
immutable scoring mappings and receipt replay. All cases retain both cells; not-applicable cells
do not remain pending for dispatch. Optional Profile semantics and null criterion mappings remain
explicit. Model identity is not fabricated; unknown identity blocks the Prompt dimension. Historical
reproduction mappings require explicit per-arm remapping before this creation path can accept them.
Positive persisted V2 PR/Issue source captures retain the original body, commit and source digest.

Ordinary latest/history/decision/finding/reproduction projections and GitHub source mutations now
exclude evaluation purpose, while operational lists/capacity retain its queued Jobs. Thirty new
tests include actual M1-M28 matrices and legitimate queued Job links; they do not bypass the current
V2 `pending/invalid_template` admission boundary or manufacture successful results. Complete Server
regression passed 4,967 tests with one Windows-only skip across 127 files; shared packages passed
1,650 tests across 44 files. Build/type checking and strict new-test checks passed. Initial FK-order
and test-source-scanner failures remain preserved. See the M32 report and
`batch-matrix-artifact-verification.json` for hashes and the exact tested-source relationship.
Public batch APIs, actual V2 scheduling/Worker execution, cancellation, reproduction remapping,
adjudication/reports/Dashboard, populated-history migration acceptance and real model/Windows/
deployment acceptance remain incomplete. No real PR/Issue write or actual evaluation execution occurred.

Server execution integration now admits strict V2 contexts, verifies complete sealed Job bindings,
uses the bounded fair dispatch/admission path, and preserves historical sources through guarded
lease/attempt/completion fixtures. Batch cancellation uses configure permission, CAS and exact
receipts; ordinary review cancellation can no longer bypass that boundary. Completion independently
rechecks cancellation after evidence collection. Profile-only Issue result fixtures preserve ordinary
reviewed-revision and notification projections. No real Worker or review-target command was run.

Workers strip configured evaluation capability claims and reject evaluation before any execution
until a trusted side-effect boundary is accepted. Purpose-preserving model delegation, historical
checkout handling and verified requested/observed model metadata remain unfinished. The Worker
evidence uploader now rehashes its owned file after upload ACKs before finalization; a deterministic
same-size, same-timestamp rewrite regression verifies rejection.

Server full regression passed 4,993 tests with one skip across 129 files; the later cancellation
permission repair passed 252 targeted tests across seven files. Shared packages passed 1,650 tests;
the final supported Worker source suite passed 1,367 with 44 platform/environment skips. Build,
strict new-test type checks, Worker bundle generation and Biome passed. Original compiler, duplicate
dist discovery, portable fixture and evidence race failures remain preserved in the M32 report.
`execution-artifact-verification.json` records the exact tested-source relationships. Public batch
APIs, evaluation pages, observation/scoring integration, adjudication/reports, mapped reproduction,
complete populated-history migration and actual model/Windows/deployment acceptance remain open.

The public batch increment now exposes six authenticated repository-scoped operations: create,
cancel, list, detail, paired-cell matrix and permitted Prompt choices. Mutations reauthorize and
retain exact receipts across owner restarts and recovery mode. Prompt options reveal only published
summaries from the current binding or this repository's frozen Runs unless the actor is a platform
administrator. List/detail/matrix reads omit full source, Prompt, Profile and assessment bodies.
Pending admission is distinct from admitted queueing, and cancellation remains `cancelling` while
an active Job has not stopped. Result identities do not claim current evidence verification.

The `/evaluations` Dashboard page now manages source capture, sample-set drafts/publication and
immutable versions/cases through the existing twelve management APIs. PR and Issue remain separate
tabs. Stable annotation identities, exact retry payloads and CAS conflicts are preserved; transient
permission checks retain edits while actual identity/scope/access changes clear them. This page
does not yet expose batch configuration/execution or complete reports, and the port-8000 sample
preview has not been rebuilt or browser-accepted for this increment.

Linux verification of the final implementation passed 5,060 Server tests with one Windows-only
skip, 1,712 shared-package tests, 148 targeted owner/HTTP/RPC tests, production build and strict
type checks including the connected integration test. Local explicit-file Dashboard verification
passed 140 tests and type checking. The connected fixture covers real auth cookies, HTTP injection,
database-owner RPC, independent batch identities, cancellation, recovery restarts and revoked access;
it starts no real Worker/model or target build and performs no upstream writes. The M32 report and
`batch-api-artifact-verification.json` bind these results to the captured implementation.

The Dashboard now connects all six batch operations through a separate strict HTTP adapter and
method/path allowlist. Each suite offers published-version selection, baseline/candidate Profile
and permitted Prompt versions, explicit criterion/check mappings, pagination, paired-cell status
and CAS cancellation. Unknown responses retain their original request across permission refresh;
confirmed creation collapses the form, preserves its selections and focuses the selected batch.
Form controls have accessible names. Narrow content areas stack the catalog above the comparison,
and shared content padding now matches the PageHeader gutters without horizontal page overflow.

Dashboard full regression passed 3,283 tests before the final layout/usability changes; the final
changes passed 244 targeted tests across eight page/service/transport files, type checking,
production builds and Biome. Two connected Linux fixtures use the production Dashboard, real auth,
database-owner RPC, scheduling pump and synthetic repositories. The first verifies repository
isolation, role downgrade/revocation/restoration, distinct Jobs and transport replay. The final
fixture verifies explicit UI create/cancel retries after partial successful responses are cut off,
one persisted logical mutation per original intent, preserved configuration, source capture,
suite draft save/publication, and published-case independence after a later saved draft change.
Both Servers drained and exited with zero Workers, attempts, validation results and GitHub epochs.
No real repository, model or target command ran. The local port-8000 sample preview is restored.
Source-bound evidence and screenshots are recorded in the M32 report and
`batch-ui-artifact-verification.json`. Actual Worker execution and complete evaluation reports
remain unfinished; cell status and result IDs do not substitute for scored findings/evidence.

## Remaining delivery work

1. Resolve the observed production model loopback-access gap and provider metadata classification before accepting opt-in summaries. Preserve the explicit fixture limits of the existing cross-host acceptance.
2. Complete actual Windows application acceptance and additional repository/toolchain coverage; M24 public-source headless and M26 public-source Web scenarios now have explicit acceptance evidence.
3. Exercise M22 against the intended real repository workflows and deployment identities, preserving the documented fixture boundaries. M20a human decisions and M21 finding disposition remain separate from measured reproduction.
4. Verify deployed OIDC and the intended multi-user deployment beyond the isolated connected cases. M27 diagnostics, M28 admission, and M29 configured limits/fairness/scale acceptance are complete, alongside M19 repository access and M23 configuration audit reads.
5. Complete Prompt/profile sample-set evaluation as specified by the roadmap and M32 design; the new contracts/scoring/migration foundations and existing same-configuration finding comparison do not complete configuration evaluation. M30 publication preview/outbox and M31 notifications are accepted with isolated mock transport. Deployed publisher credentials and any live target/payload remain separate acceptance work requiring exact authorization.

Private-repository end-to-end checkout credentials have not been selected. Metadata access must not be presented as checkout readiness. No external GitHub review/comment publication is authorized by the implementation work itself.

## Evaluation adjudication integration increment

Evaluation context/history and mutation contracts, owner persistence, three authenticated HTTP/RPC
operations and the Dashboard adjudication controls are now connected. Reads use repository read
permission; changes independently require review permission. The owner revalidates immutable
source/result/expectation scope, derives real occurrence keys, validates all current match/duplicate
relationships, preserves exact CAS receipts and uses savepoints for atomic event/receipt writes.
New changes are checked against the complete context's read budget before insertion. The Dashboard
retains uncertain original requests and requires explicit confirmation of refreshed conflict versions.

Batch creation now shares the scorer's semantic freeze, rejecting duplicate check mappings within
one case/arm while preserving cross-case reuse, null mappings and the frozen denominator. Full
Linux Server verification passed 5,303 tests with one platform-specific skip; shared packages passed
1,814 and the local Dashboard passed 3,471. Production builds and relevant type checks passed.
An old purpose-projection test's real-clock dependency was fixed without changing production sorting.

A connected browser fixture used real production authentication, HTTP, owner storage and Dashboard
with synthetic profile-only result inputs. It verified context/history reads, evidence-refresh state
retention, clearing after access revocation, viewer restoration and candidate scope changes. Both
test Server and forward were closed; no adjudication event, assessment or actual upstream write
occurred. This does not constitute a successful persisted adjudication-write or real model case.

Required-model identity and execution isolation remain unavailable, and the Worker evaluation
refusal remains in force. Owner observations, scoring and immutable assessment reports are still
unfinished. See `artifacts/m32-evaluations-20260908/adjudication-delivery-notes.md` for exact source
captures, original failures, screenshots and limits. The full roadmap remains open.
