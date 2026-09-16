# Implementation Status

## Configurable assignment Webhook intake, 2026-09-16

The native Task runtime now accepts signed `issues.assigned` and `pull_request.assigned`
deliveries. Each registered repository can configure its listener switch, recipient GitHub user
ID, and trusted assigning user IDs in the Dashboard. Settings are scoped, versioned, and persisted;
the receiver secret remains a deployment setting. No repository or user is selected by default,
and the runtime starts no GitHub polling loop.

Authorized events enter a durable bounded inbox before acknowledgement. Delivery and assignment
deduplication, renewable processing leases, exact source references, and the native Task transaction
preserve task identity through retries and service restarts. Current assignment, PR revision,
repository binding, and configuration grants are checked during preparation and again at the
Task commit boundary. Recovery of an already committed Task completes its original receipt even
if the listener is subsequently disabled, without creating work or reading GitHub again.

The designated remote Windows environment passed **583 Server tests in 21 investigation files**
and **161 Dashboard tests in 13 investigation files**, for **744 passing scoped tests**. Shared
packages and Server built successfully; Dashboard type checking and production build passed.
Changed-code Biome checks passed with non-blocking warnings. The initial Dashboard typing error
and the error-state rendering test failure were corrected and retain their earlier failed receipts;
reruns are not added to the final test totals.

The acceptance uses isolated databases and injected read-only GitHub responses, including the
production runtime's Webhook-to-Task-to-Worker claim path. It does not establish a public receiver
deployment or a live GitHub subscription. No actual repository PR, Issue, or Webhook configuration
was changed. [Server setup and operations](../apps/server/README.md#listen-for-trusted-assignments)
describe the receiver secret, GitHub subscription, repository settings, receipts, and recovery.

## Native Windows investigation delivery, 2026-09-16

The production Server and Worker entry points passed the scoped synthetic Windows lifecycle
exercise. Evidence quotas, bounded retention, current artifact availability, and inherited patch
lineage are implemented. **The real CLI investigation, same-task recovery delivery, and explicitly
approved two-comment publication run are accepted within their recorded scopes.** The
[native Worker handoff](./handoff/2026-09-16-native-worker-acceptance.md) records the current scope
and separates software verification, synthetic lifecycle acceptance, real-model recovery, and
external publication.

| Work | Current state | Evidence and remaining boundary |
| --- | --- | --- |
| Native lifecycle | Accepted for the synthetic fixture | Actual Server/Worker startup, password accounts and explicit grants, two consecutive tasks, cancellation, graceful stop/restart, and checkpoint resume passed on Windows. |
| Complete report delivery | Accepted for the synthetic fixture | 137 findings and 137 final rechecks, approximately 3.9 MB exports, complete 50/50/37 pagination, retained partial findings, cleanup, and zero action intents. |
| Evidence operations | Implemented with scoped regression coverage | `investigation-v2`, atomic resident quotas, bounded retention, current metadata APIs, protected recovery/source dependencies, and original producer lineage. Production capacity remains separate. |
| Real model and recovery | Accepted as a combined sequence | Five actual model rounds followed by native attempt 2 on the same task sealed a complete 30,886-byte report with zero new model rounds/tokens. The original failed delivery remains unchanged; this is not an uninterrupted-run claim. |
| Native publication | Approved scope accepted | Both native intents succeeded on owned-fork PR #3 and Issue #5. Each target had one confirmation and one new matching comment observed by GET; the one-run approval is consumed. |

The evidence defaults are 30 days, 1 GiB of resident original artifact content, and 10,000 resident
artifacts, with 100 metadata records scanned per cleanup pass every 60 seconds. Protection retains
active work, accepted recovery checkpoints, and required inherited patch sources. Expiration
preserves report history and metadata; decoded-content quotas do not bound or shrink physical
SQLite/WAL files. Tasks and reports use `sourceArtifacts` to preserve ancestor patch producer IDs
without claiming those inputs as new execution evidence. See the
[Server operations instructions](../apps/server/README.md#evidence-retention-and-capacity).

The delivery correction aligns completion with the approved design: an unresolved snapshot-analysis
candidate may retain a same-subject saved `investigation`, `verification`, or `reproduction` plan
with a valid current/exact-parent report source, nonempty steps and criteria, and an explicit
limitation. An executable next-action button is not required to preserve that remaining work;
saved-action validation and plan-kind execution guards remain strict.

Report projection preserves invalid action proposals as complete non-executable diagnostics and
derives zero-based finding display ordinals from the original ledger order. The model's retained
`ordinal: 1` becomes report ordinal `0` with a trusted old/new ordinal diagnostic; its finding ID,
version, body, and recheck bindings stay unchanged. Report projection does not mutate the accepted
checkpoint. The Server independently recomputes findings, actions, and diagnostics and applies the
complete public report semantic validator before sealing. The final remote checks and native recovery accepted
these changes; they are deliberate contract and presentation changes.

Native recovery reused task `2e067db8-6e14-4b52-83c2-4f9ba6d68090` and its existing database. Attempt 2
advanced checkpoint v6 to v7 while retaining `stopReason: complete`, five model rounds, and identical
analysis/runtime/consumed values. Report `aa4d1180-5473-4aaa-a8d9-b7bd19a244d7` retains one hypothesis
finding, one reproduction plan, and the invalid-action and ordinal diagnostics, with no executable
next-action suggestions. Server/Worker exit 0 and owned cleanup passed; ActionIntents remained zero
and external writes disabled. The original run-5 failed receipt and absence of an export were not
rewritten. This accepts real CLI analysis plus same-task delivery recovery, not real source
execution, reproduction, UI behavior, or the correctness of the hypothesis.

The final package regression scopes total **14,562 passes and 45 skips**: Contracts 1,690,
Domain 346, Codex 222, Server 6,035, Worker 2,523, and Dashboard 3,746. The complete Linux Server run
passed 174 files with one skip; the Worker retains 44 skips. Server active-investigation checks
passed 295 tests in 15 files on both Windows and Linux and are not counted twice. Affected Windows
type checks and shared/Server/Worker/Dashboard builds passed; the final 13-source-file Biome check
had zero errors and 125 warnings, with one file formatted and no unsafe fixes. Codex and Dashboard
retain their unchanged-scope receipts. The attempted full historical Server suite on Windows
retains 151 Linux-specific database/evidence failures and is
not an accepted Windows full-suite run. Earlier installation, model, and test type-checking
failures remain recorded. These scopes do not claim a new whole-project CI result.

The declared code base revision is `2d0c36ef3627143e4ac546197bb761c74674af9f`; executed source and
runtime manifests identify the actual snapshots with subsequent changes. Full infrastructure
receipts remain outside the repository. The [handoff](./handoff/2026-09-16-native-worker-acceptance.md)
records the sealed export's size and hash without copying private deployment details.

The user explicitly approved the immutable publication JSON with SHA-256
`0671baa0f8a5c4b446dbadc3a8e4b7013cae1af04c490f6662bbdbf3f49ba936` for run
`investigation-publication-20260916-v1`. Native preparation performed no external writes. Execution
from `2026-09-16T07:24:12.437Z` to `07:24:53Z` passed: the
[PR #3 comment](https://github.com/moooyo/PowerToys/pull/3#issuecomment-5693633461) and
[Issue #5 comment](https://github.com/moooyo/PowerToys/issues/5#issuecomment-5693635709) both reached
native intent state `succeeded`. Independent GET readback matched the full approved body, native
marker, publisher ID `42196638`, and exact target; conversation counts changed 0 to 1 and 1 to 2.

Each target had exactly one native confirmation. The production single-mutation path gives a
derived upper bound of one POST attempt per target; no HTTP proxy measured network POST counts.
No delivery became unknown and no native reconciliation was invoked. Ordinary GET readback does
not establish unknown-delivery recovery. Server exit was 0. Repository requests stayed within
`moooyo/PowerToys`, apart from the required `GET /user` identity check, and redirects were rejected.
This publication run made no request to `microsoft/PowerToys`.

Cleanup at `2026-09-16T07:26:19Z` confirmed removal of the temporary publisher credential and
closure of the owned Server, with the original CLI authentication untouched. A sanitized native
receipt is retained separately from private infrastructure data.

The comments remain in place, and the single-run authorization is consumed. The
[publication scope and execution record](../deploy/investigation-acceptance/publication-approval.md)
retains the exact approved limits; no rerun, cleanup mutation, or broader publication authority is
implied. This acceptance introduced no product-code change or new full-suite run. The
project-designated remote Windows worker remains the default verification environment;
Linux-specific checks may use `test-env`. No local verification was run.

## Built-in accounts, 2026-09-15

Application-owned username/password authentication is implemented. The production entry uses
password mode with first-administrator initialization, login/logout, account management, password
changes and resets, session revocation, and explicit repository/action permissions. Administrators
can recover access through the offline reset tool. There is no default production password.
The [account design](./design/2026-09-15-built-in-accounts.md) records the behavior and boundaries.
Third-party identity integration, dedicated PowerToys UI scenarios, and model-quality evaluation
are outside this delivery, following the user's scope decision.

The final isolated `test-env` snapshot passed **11,403 tests** across the three affected packages,
with **one existing skip** and **zero failures**: Contracts 1,666, Dashboard 3,735, and Server 6,002.
All six package type checks and the complete root build passed. Production browser verification
passed 12 real HTTP/password-account flows; the development preview passed 18 checks. Expected
401/403/409 outcomes were tested, with zero unhandled page errors, unexpected console errors,
or external requests. Desktop and 390-pixel forms were inspected. Temporary browser services
and synthetic account databases were removed after verification.

See the [account verification summary](../artifacts/builtin-accounts-20260915/summary.md) and
[receipt](../artifacts/builtin-accounts-20260915/verification.json) for the exact frozen source,
commands, source manifest, formatting checks, and evidence. Documentation closeout follows the
verified code snapshot. Earlier Task/Report receipts retain their own scope; this delivery did not
run real models, PowerToys-specific UI scenarios, or real GitHub mutations.

## Task / Report refactor, 2026-09-15

The production Server, Windows Worker, and Dashboard entry points now select the native
Task/Attempt/LoopCheckpoint/Report path described in the
[current design](./design/2026-09-15-structured-investigation-results-and-loop.md).
Legacy API compatibility, dual writes, database conversion, and migration scripts are not part
of this delivery. New databases use the investigation initialization schema.

Implemented scope includes structured PR/Bug/Feature reports, complete discovery/recheck loops,
trusted full-diff coverage, durable partial results and budget-aware recovery, whole-report
pagination/export, separate recommendations and operation guards, saved-plan follow-ups,
explicit Issue source selection, controlled model edits, and registered Windows/Web UI execution.
The new Dashboard exposes PR, Issue, Task, Report, and repository flows; prior management routes
are not served as compatibility endpoints. Runtime configuration uses `INVESTIGATION_*` and
`INVESTIGATION_WORKER_*`; see the Server and Worker READMEs.

The final isolated `test-env` snapshot passed **14,306 tests**, with **61 existing platform or
opt-in skips** and **zero failures**. All six package type checks, shared/Server builds, and the
complete root `pnpm build` passed. Biome checked 110 changed source files with zero errors;
383 warnings and two informational diagnostics remain. The production build retains a Vite
large-chunk advisory. Native-entry tests replace obsolete startup and environment-documentation
assumptions.

| Package | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| Contracts | 1,660 | 0 | 0 |
| Domain | 337 | 0 | 0 |
| Codex | 222 | 0 | 0 |
| Server | 5,927 | 1 | 0 |
| Worker | 2,492 | 60 | 0 |
| Dashboard | 3,668 | 0 | 0 |

Integration coverage includes a real HTTP Worker/Server round trip with file-backed SQLite,
shutdown/reopen/resume, 137 findings, a report larger than 2 MiB, and complete pagination/export.
Browser checks covered the development samples and a production bundle with an isolated
authenticated Server and mocked upstream transport. The final entry-point checks produced zero
browser console or page errors; production runtime JavaScript contained none of the seven checked
preview markers. The remotely built shared packages were copied to the existing local preview;
no local test, type check, build verification, or runtime probe was used.

See the [verification summary](../artifacts/task-report-refactor-20260915/summary.md) and
[machine-readable receipt](../artifacts/task-report-refactor-20260915/verification.json) for the
frozen snapshot, commands, artifact hashes, and exact scope. Documentation closeout follows that
code snapshot. This evidence does not establish a real Windows deployment, real CLI-model or
OIDC-provider acceptance, or a new PowerToys UI scenario. No live repository PR/Issue mutations
were performed. Historical receipts below retain their original scope.

## Retained architecture baseline, 2026-09-10

Architecture as of 2026-09-10: each independent VM runs one long-lived Worker and multiple
successive tasks. The [VM deployment decision](./design/2026-09-10-single-worker-vm.md) assigns
isolation to deployment and retires the unused WindowsAttempt protected-journal, OS-adapter,
signed-evidence and execution-admission design. Ordinary Job quotas, capabilities, leases,
cancellation, process-tree draining, workspace cleanup and result ownership remain required.
Model execution now follows the [CLI-owned execution design](./design/2026-09-10-cli-owned-model-execution.md).
The Worker selects Codex or Copilot CLI and records CLI configuration, detected version, process
exit and schema-validated structured output. The CLI owns login, provider configuration and HTTP
traffic; the project does not read/copy CLI auth/provider files or maintain a global provider
registry, model HTTP relay or provider call ledger. Capabilities expose nullable `cliEngine` and
`cliVersion`, with null values when model execution is disabled. Configured model names do not
establish independently verified remote-model identity. The unused `executionAccepted` field was
absent from that baseline's contracts, results and UI. That unreleased snapshot directly maintained
SQLite schema **31**, without database resets, old-version upgrades, data conversion or compatibility
migration work, using its ordered SQL initialization. This is historical architecture;
the active investigation runtime now initializes `investigation-v2` directly.
Historical schema numbers describe their original snapshots. Existing data and historical artifacts
remain unchanged. Automated suites use isolated synthetic data; the explicitly
authorized real CLI probes and controlled-fixture workflow acceptance below are separately scoped.

## Retained branch verification before the refactor

The dashboard now uses Material UI 9, Vite, React Router, and the
[Material 3 presentation](./design/2026-09-10-material-design-reset.md). Its final verification on
`test-env` passed TypeScript checking, the production build, and all **3,603 tests in 116 files**.
Biome reported zero errors, with 68 existing warnings and eight informational suggestions.
Browser verification covered all 11 primary routes and 19 desktop/mobile interaction states.
These dashboard checks are separate from a full project CI run.

The earlier `main` baseline `bdfa577` passed all three jobs in CI run **34432088155**.
The subsequent `bd4def6` and `db15c1b` commits retain M41 publication-helper changes and M42
installation/build/test receipts. Those receipts remain scoped acceptance evidence, not a new
full project CI run. No GitHub write or authentication-file read occurred in M42.

The user explicitly authorized committing the dashboard changes, merging them into `main`, and
pushing this project's branch, including the two earlier local commits. This delivery approval
does not authorize repository PR/issue/comment operations; their separately scoped rules remain.

### Retained M40 CI evidence

CI run **34429398701** passed all three jobs at commit
`62297f72861b3bcdd2bc04804602c29532218713` on `codex/ci-product-completion`, completing at
`2026-09-10T02:46:33Z`. Linux typecheck/tests/build/lint passed with **13,395 passed, 61 skipped
and zero failed tests**. Windows Worker passed **1,972 tests with 44 skips**; native Go and
PowerShell checks passed, as did ProcessHost Linux checks and Windows cross-compilation. Lint
checked 907 files with zero errors; 132 warnings and 13 informational diagnostics remain.
The [final CI summary](../artifacts/m40-ci-product-20260910/ci-final-62297f7/summary.md) retains
the per-package counts, stage results and logs. Skips and warnings are not relabeled as passes.

Earlier CI failures remain historical: the `c7364b2` run passed tests/build but failed seven lint
checks, and the `a6e0997` run failed a 5,000-ms Worker test while deeply comparing a 2-MiB Buffer.
`62297f7` changes only two test assertions to native `Buffer.equals`, preserving the data, timeout
and other assertions. Its [verification](../artifacts/m40-ci-product-20260910/evidence-buffer-comparison-v1/verification.json)
passed 51 tests on Linux and 51 on Windows plus `noEmit` and Biome. The local baseline did not
reproduce the CI timeout. Production uploader/model code was unchanged, and the six model tasks
were not replayed for this test-only correction. The subsequent `5787871` commit changes only the
opt-in publication acceptance helpers. Their separate synthetic verification and seven production
boundary tests passed. Production runtime and regular test-suite sources remain at the verified
CI revision. Final local and remote refs are retained in the
[delivery receipt](../artifacts/m40-ci-product-20260910/delivery.json).

## M42 installed toolchain, PowerToys build and selected tests

The user-approved third installation attempt passed. Both required Spectre components are
registered, the expected libraries exist, no installer process remains, and no reboot is required.
Visual Studio remains at version **18.7.11925.98**. The
[installation verification](../artifacts/m42-spectre-build-20260910/vs-components-run3/verification.json)
supersedes the earlier uninstalled state without changing the M41 failure receipts.

PowerToys [build run 2](../artifacts/m42-spectre-build-20260910/powertoys-build-run2/receipt.json)
passed against `D:\AR\m40-0910\PowerToys` at
`3a1e642db52d45f88c0cb702b10663e1f65623f7`. Restore, Runner and Settings UI compilation each
reported zero warnings and zero errors. All three managed process trees completed, Host exited 0,
cleanup had no failures, and the source preflight was clean. The
[retention receipt](../artifacts/m42-spectre-build-20260910/powertoys-build-run2/upstream-retained/retention-receipt.json)
confirms all 12 explicit upstream logs were copied with matching hashes.

Build run 1 remains failed with `MSB3073` / exit 9009 because the standalone helper omitted the
standard Windows PowerShell directory from `PATH`. Only the M42 artifact helper's `PATH` was
corrected. The production Worker uses its configured account `PATH` and needed no product change.
The [Settings test run](../artifacts/m42-spectre-build-20260910/settings-tests-run1/receipt.json)
built the current test project and passed exactly **7/7** selected serialization/mocked-storage
tests with zero skips. The [TRX](../artifacts/m42-spectre-build-20260910/settings-tests-run1/results/powertoys-settings-smoke.trx)
and the receipt's `testVerification` confirm the exact seven methods. All seven managed process
trees completed, Host exited 0 and cleanup had no failures. This is the selected test scope,
not all PowerToys unit tests or UI acceptance. No native PowerToys UI was launched, and the
personal PowerToys instance remains untouched. See the
[M42 handoff](./handoff/2026-09-10-spectre-build-handoff.md) for the current recovery point.

## M41 retained publication acceptance and PowerToys preparation

The approved **13-operation publication acceptance passed** on `moooyo/PowerToys`: 11 coordinator
mutations and two production publisher POSTs. Each publication passed through `unknown` and
GET-only reconciliation to `published`, with exactly one POST per target. The retained
[live receipt](../artifacts/m41-approved-acceptance-20260910/publication-live-retained-v2/live-run1/receipt.json)
records PR **#1**, review **5162481132**, Issue **#2**, comment **5612697745**, and no cleanup failure.
The [independent readback](../artifacts/m41-approved-acceptance-20260910/publication-live-v2/remote-readback-v2/verification.json)
confirms the PR closed without merging, the Issue closed, the test branch absent, Issues disabled,
and all original Actions permission fields restored. Fork `main` remains at
`3a1e642db52d45f88c0cb702b10663e1f65623f7`; the original four workflow runs are unchanged, with no
new run and no upstream repository write.

The first V2 attempt received HTTP 409 while disabling Actions and changed no remote state.
V3 changed that request body to only `{ "enabled": false }`; the
[scope comparison](../artifacts/m41-approved-acceptance-20260910/publication-v3-scope-comparison.json)
confirms all other 12 operations and six payload files are identical. Bounded, token-redacted
HTTP failure diagnostics and the minimal request were verified with two production SQLite outbox
fixtures, 18 synthetic coordinator scenarios, syntax checks, Biome and independent review.
[Verification](../artifacts/m41-approved-acceptance-20260910/diagnostics-preparation-v1/verification.json)
retains the initial `/mnt/d` storage-permission failure. The first independent REST readback also
remains failed: Issue endpoints returned HTTP 410 after Issues was restored to disabled. The
successful follow-up used the exact created GraphQL nodes and retained REST responses, without mutations.

At M41 closeout, the two approved Visual Studio Spectre components remained uninstalled: the first attempt
exited 5007 and the second `RunAs` elevation was canceled. The
[final component check](../artifacts/m41-approved-acceptance-20260910/vs-components-final-state.json)
confirmed both component directories were absent. The request to display UAC again had no
reply at that point, so no third attempt occurred in M41. The [build helper bundle](../artifacts/m41-approved-acceptance-20260910/build-preparation-v1/README.md)
and [seven-test plan](../artifacts/m41-approved-acceptance-20260910/powertoys-test-plan-v1.md) were prepared
for the same pinned checkout. No M41 PowerToys build, test or UI run occurred. The personal
PowerToys instance is outside the owned acceptance scope. See the
[M41 handoff](./handoff/2026-09-10-approved-acceptance-handoff.md) for that historical recovery point;
the subsequent M42 installation/build/test results are recorded above.

## M40 retained implementation and verified scope

The following retains M40 implementation and runtime outcomes. M41 advances publication acceptance
and installation status above; neither milestone marks the product or all P1/P2 work complete.

| Work | Completed or verified scope | Remaining boundary |
| --- | --- | --- |
| Finding validation | [finding-validation-run3](../artifacts/m40-ci-product-20260910/finding-validation-run3/) passed 395 tests, `noEmit` and lint; final CI also passed at the commit above. | Earlier failures remain retained; deployed identity/permission acceptance keeps its own scope. |
| Publication preparation | [V2 preparation](../artifacts/m40-ci-product-20260910/publication-prepare-v2/verification.json) passed both synthetic outbox cases, 13 coordinator scenarios, JavaScript syntax, Biome and independent review. The seven production-boundary tests also passed. | This was preparation only at M40 closeout. The approved live workflow subsequently passed in M41 using the scoped V3 correction above. |
| Quality checker | Eight pure checker regressions, `noEmit`, checker bundling and Biome passed. Retained nine-task observations passed the corrected postconditions without new models. | The original run receipt is unchanged and still failed on `18 !== 6`; separate revalidation is not a rewritten runtime pass. |
| PowerToys preparation | Restore passed; the native build failed with six `MSB8040` errors. Host closure and byte/hash-preserved upstream logs are retained. | M42 subsequently passed prerequisite installation, the scoped build and seven selected tests; UI acceptance remains separate. |
| Summary diagnostics | Diagnostics v2 passed 318 tests, `noEmit`, Biome and independent review, preserving bounded redacted code/message context. | Earlier generic summary failures remain recorded; this does not itself accept a real model workflow. |
| Portable model schema | Schema v2 passed 327 tests, `noEmit` and Biome for six model schemas. Run 2's HTTP 400 was traced to regex lookaround in the exported observation-path pattern. | A schema portability defect, not provider configuration. Earlier failed Worker/coordinator receipts remain unchanged. |
| Headless Issue summaries | Run 3 completed all six actual summaries: ordinary and both Evaluation arms per CLI. Independent semantic/numerical/scope review passed; runner/model conclusions and assessments were confirmed. | Accepted for the frozen headless Issue measurement case, not Issue triage, installed-extension/video/AI/translation behavior or Windows/Web UI execution. |

The [retained quality revalidation](../artifacts/m40-ci-product-20260910/quality-checker-correction-v1/retained-quality-revalidation.json)
has SHA-256 `5ff889f8978f611698566b828cb0be8dfec4f1290dd986517783fc17fce0193f`.
It confirms the original records are unchanged: nine real Codex tasks, 18 admitted/released
reservations and cleaned workspaces, 324 completed process trees, zero active requests, monitors
or reservations, and Host/Server exit 0. The original checker wrongly expected the three-task counts;
its replacement derives counts from `expectedTaskCount`. This revalidation performed no model
replay or product-service/Git operation.

Four human adjudications yielded, per arm, three correct checks, TP 2, FP/FN/duplicates/unjudged 0,
precision/recall 1 and `provisional: false`. These are observations on three deliberately small
cases, not a PowerToys quality benchmark. The healthy candidate explicitly did not complete its
full base/head review; the model reviews were static and did not run their own tests. Independent
Node/profile checks remain separate, so the metrics do not prove full review coverage.

Run 3/session 23027 exited 0 and completed at `2026-09-10T02:18:50Z`. Its unified source snapshot
contained 1,105 matched files, archive SHA-256
`5e431ed84012d49a3c9794940da84b447d500c4f75c95f9c0e830255c4789899`. The
[independent review](../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/REVIEW.md),
[retention proof](../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/retention.json)
and [closed Server copies](../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/closed-server-copies.json)
confirm 216 managed process completions, four frozen inputs and 12 deferred cleanups. Each engine
used one instance for three sequential tasks; four cross-task boundaries confirm prior cleanup
finished before the next task. The engines also ran sequentially with different instances.
Host/Server closure passed, and all 38 copied Server files matched their closed originals.

At M40 closeout, live publication and Visual Studio installation were still awaiting approval.
Those historical receipts remain unchanged; the approved M41 outcomes are recorded above.

## M39 completed controlled-fixture acceptance

M39 is **complete for the controlled-fixture workflow scope**: Codex run 3 on source v5 and Copilot
run 6 on source v8 each completed one ordinary PR review and both baseline/candidate Evaluation
tasks. The accepted six-task matrix combines two complete engine sequences with separate source/run
identities; it does not splice partial failed runs or claim one common source/run. The validated
[workflow summary](../artifacts/m39-cli-workflow-20260910/workflow-summary.json) and
[M39 handoff](./handoff/2026-09-10-cli-workflow-handoff.md) retain the exact task, source, receipt
and assessment identities.

Windows ran production Worker execution/lifecycle components, ProcessHost, the configured Codex
0.145.0 or Copilot 1.0.73 CLI, real Git and Node checks. WSL ran the real Server, SQLite, HTTP result
handling and scoring. The only Git transport substitution mapped the exact fictional fixture HTTPS
fetch to an owned local bare repository. This was component composition, not deployment through
Worker `main.ts`. All required runner checks passed, model branches completed and source remained
original. Both engine sequences retained one Worker instance, 102 completed managed process trees,
six released reservations, empty workspaces and Host/Server exits 0. Copilot also recorded zero
active requests/monitors/reservations, zero abandoned reservations and no Server cleanup failures.

The integration owner read all six finding bodies. They correctly identified the missing
`percent / 100` conversion in `src/discount.js:2`, yielding `-2400` instead of `75` for `(100,25)`.
Each Evaluation arm retained one completed case/check and one unjudged finding with provisional
quality and null precision/recall. These are fixture-specific correctness and scoring observations,
not a model-quality benchmark. A model's extra failing assertion reproduced the defect; it was not
a failure of the mandatory runner check.

The final Copilot terminal correction passed 328 tests across four files, `noEmit` typecheck and
Biome; the main Git-PATH correction passed 40 tests. The final targeted set is **368 passes across
five distinct files**, with zero failures/skips. M38's full suite was not rerun. The v8 source has
1,077 files and archive SHA-256 `1e1d0cbe08f4b4f1852d28eac8195a030bc6dbeb13fbff0e53a09d6b3ff5ecf9`;
build/typecheck/Worker bundling passed. The retained
[Worker bundle v4](../artifacts/m39-cli-workflow-20260910/worker-bundle-v4/worker.mjs) SHA-256 is
`b32c3a006bf9313120fc9241c614ae009a1eb3d685de5be660c4fd63d77d3bdf`.
The [final source check](../artifacts/m39-cli-workflow-20260910/final-source-check.json) confirmed
all 1,075 compared v8 files byte-for-byte, excluding only the two closing documentation files.

Earlier source compilation, construction, timeout-mismatch, JSON/event-stream and summary-script
failures remain retained. The historical PID observer was corrected after unrelated processes
reused exited Git PIDs; current cleanup uses ProcessHost-managed completion. The terminal parser
freezes one complete successful root response while retaining full-stream validation and rejecting
contradictory terminal/root events. The exact historical run 5 trailing-event type remains unknown.
No provider/relay, credential-copying flow or migration was introduced, and no actual PR/Issue write
occurred. Full Worker `main.ts` and Windows VM deployment acceptance, actual upstream repository
review and general model-quality evaluation remain separate boundaries, not additional requirements
for closing this controlled-fixture milestone.

## Remaining product work

This is the current backlog and acceptance boundary. Historical milestone limitations below do
not override later accepted scopes, and retired designs are not queued implementation work.

The 2026-09-15 [structured investigation refactor](./design/2026-09-15-structured-investigation-results-and-loop.md)
is implemented and verified within the automated and browser scope recorded above. Its native
contracts, storage, complete Worker loop, operation handlers, and Dashboard are the active path.
Legacy compatibility, dual writes, data backfills, and migration scripts are not pending work.
Actual deployment and scenario acceptance remain scoped below; automated verification does not
authorize writes to actual repository PRs or issues.

The 2026-09-16 delivery accepted the new native lifecycle and a real CLI Issue investigation
followed by same-task checkpoint recovery, sealed report delivery, and cleanup. The original
failed attempt remains historical evidence. Real-model report delivery is no longer pending for
that specific sequence; other source/execution scenarios retain their own scope.

The separately approved native publication run also completed its exact two-comment scope on
owned-fork PR #3 and Issue #5. That one-run authorization is consumed. Broader repository-specific
human workflows and additional delivery scenarios need their own acceptance and explicit write
approval; they are not covered by either this run or the historical M41 authorization.

- **Deployment operations:** the new synthetic exercise has accepted full Server/Worker entry
  points, consecutive tasks, cancellation, graceful restart/resume, and owned cleanup on Windows.
  It does not accept hard-crash orphan recovery, SCM restart/signal policy, production hosting,
  real source/executable/UI profiles, or sustained workload capacity. These boundaries must not be
  confused with an unimplemented native task loop or the older M39 component-only exercise.
- **Operational capacity:** resident evidence quotas, bounded retention, expiry reads, and source
  protection are implemented. Remaining deployment work is to accept the intended sustained
  workload and physical SQLite/WAL storage growth under that policy. A bounded logical content
  quota does not establish total disk capacity or physical file compaction.

Dedicated PowerToys UI scenarios and general model-quality evaluation remain outside the current
delivery. Ordinary software tests, report validation, and source/evidence checks remain part of
implementation correctness; no model-ranking or quality-scoring project is required.

The removed split Worker, WindowsAttempt protected-journal/OS-attestation, provider registry and
model HTTP relay are retired. Old-version upgrades, resets, conversions and compatibility migrations
are not product tasks for this unreleased codebase. Private checkout, automatic distribution,
video evidence and reusable build artifacts remain separate unimplemented scope, rather than
requirements to reopen the completed M38/M39 milestones.

Automated tests must not write any repository's PRs/issues without explicit approval of the exact
targets, operations and content. General implementation or verification authorization does not
grant that authority. See [AGENTS.md](../AGENTS.md).

## M38 delivered baseline and verification

M38 architecture cleanup and its recorded verification scope are complete. This is not completion
of the entire product, real-repository model-quality acceptance or full VM deployment acceptance.

M38 removes the project-owned provider registry, auth/provider profile loader, model HTTP relay,
call ledger and separate app-server invocation flow. Model execution uses the selected Codex or
Copilot CLI, its own login/configuration, bounded process supervision and structured task output.
Existing Job leases, frozen source/Profile/Prompt and summary-input ownership, result consistency,
process draining and workspace cleanup remain. Worker credential provisioning and existing data
were not changed; no compatibility backend, old-data conversion or migration project was added.

The [combined workspace result](../artifacts/m38-cli-execution-20260910/combined-test-results.json)
has **12,968 passed, zero failed and two explicit Windows-only skips across 359 files / 12,970
cases**. The complete v3 run initially had 12,963 passes, five failures and two skips. The five
failures were old fixture expectations or cancellation assertions. The complete four-file v4
retest passed 215 tests with zero failures/skips. Production runtime sources are identical between
v3 and v4; the combined result checks file/case sets and replaces the four files' earlier outcomes,
rather than adding all retest passes to the full-suite total. Original failures remain retained.
The skipped native Windows cases are the Server UNC/case-alias evidence-root check in
`apps/server/src/config.test.ts` and the real synthetic-file validation check in
`apps/worker/src/execution/validation-runtime-config.test.ts`; they are not reported as passes.

The v3 archive contains 1,068 files with SHA-256
`7a5d4cde6a600763a28867d83ea05fb86a9886acdf3770b79da2f9635eab5d73`. The v4 archive contains 1,069
files with SHA-256 `f04cb934097f11258eb0f1d23c2c757b72e69daa7874696ecbebdd920e91bba2`.
M37-to-v3 has 83 removed and 16 added paths, including tests and SQL renumbering, not exclusively
production modules. v4 type/build gates passed. Biome retained one test line-break formatting
error, 66 warnings and 11 informational diagnostics. Only that formatting was corrected;
[compiled-JavaScript identity](../artifacts/m38-cli-execution-20260910/format-token-proof.json)
supports retaining the passed tests without repeating them. **The final v5 fresh-stage
build/typecheck/lint and actual Worker bundle generation passed.** The v5 archive contains 1,069
files with SHA-256 `be8bf6947bd566ea23fe90268bf24820b642f58c0c06877cf4ae1fd923a52f82`.
The [build-source proof](../artifacts/m38-cli-execution-20260910/build-source-proof.json) confirms
unchanged runtime sources from v4 to v5 and only the compiled-JavaScript-identical test formatting.
Final Biome checked 180 files with zero errors, 66 warnings and 11 informational diagnostics;
the earlier lint failure is retained.

The [final v5 receipt](../artifacts/m38-cli-execution-20260910/verification/wsl/verify-run5-20260910/verification/tests/verification-receipt.json),
SHA-256 `3ef24c7e35b27156a079e1d19f68593c4ea9fa32adf4f062a104bb7721490c54`, records all eight
build/typecheck/setup/lint/bundle commands exiting 0, matching final source, an absent removed
journal owner and no failure. This stage did not repeat completed tests. The emitted `worker.mjs`
SHA-256 is `0064d137b493d128b4ce0d7e1542bd9ec1139984441872fb370c4268adf297bf`; all six Worker and
web-driver bundle files are retained in [worker-bundle](../artifacts/m38-cli-execution-20260910/worker-bundle/)
with individual hashes matched to the receipt.

| Additional verified scope | Result and limit |
| --- | --- |
| Native Windows ProcessHost | 235 Go tests passed with zero failures/skips; vet/build passed. The built Host SHA-256 is `2811238c88a6f2b38247f2cd68ac60570c58ecd5b0fe490c6dc593b2d9dfd7ea`. |
| Native CLI smoke run 2 | Real Host with synthetic Codex success, Copilot success, Codex cancellation, then another Copilot success; no node faults, all recorded owned child PIDs gone and Host exit 0. The cancellation regression passed 80 cases. |
| Dashboard | v2 production build and 3,578 tests across 114 files passed. Windows run 2 passed v3 contracts emission, setup and typecheck; the compared 347-file Dashboard set differed only by two type-only `defaultSettings`/`satisfies` lines. The earlier build/tests were not repeated or represented as a new run. |
| Deployment launcher | PowerShell 7.6.5/Pester 3.4.0 passed one wrapper case executing the complete standalone regression harness, with zero failures/skips and unchanged source hashes. No Worker/CLI, credential read or external write occurred. |
| Real configured Codex | One minimal no-tool prompt returned strict `{"status":"ok"}` using the current login/configuration and CLI default model in approximately 11.4 seconds; command capture was complete with zero commands. |
| Real configured Copilot | One minimal no-tool prompt returned the same strict JSON using the current login/configuration and CLI default model in approximately 27.1 seconds; command capture was incomplete with zero observed commands, not complete internal tool capture. |

Both real CLI probes ended with Host exit 0, absent owned child PIDs and zero node faults. Their
harnesses did not manually read/copy auth/provider files or change CLI configuration. No actual
PR/Issue write occurred. The remote run 2 resource-related Worker typecheck `SIGKILL` without a
TypeScript diagnostic, temporary SSH outage/recovery, native smoke run 1 cancellation
misclassification, Dashboard run 1 type failure, original five suite failures and v4 lint failure
remain recorded. See the [M38 handoff](./handoff/2026-09-10-cli-execution-handoff.md) for exact
receipts, source identities, cleanup evidence and the completed final bundle gate.

The real CLI checks establish only minimal no-tool JSON connectivity. They do not accept an actual
repository review/evaluation, model quality, complete Copilot tool capture or the intended VM's
full deployment workflow. PR/Issue writes still require separate exact-scope authorization.

## Earlier verification milestones

M37 historically completed the now-superseded VM app-server path and consecutive-task integration. The remote suite
passed 2,136 tests across 46 files; actual local Windows Codex review/summary protocol cases passed
against a controlled loopback Responses service. Worker packaging passed a separate unchanged-source
retry after an initial nested typecheck failure. See the
[model continuation handoff](./handoff/2026-09-10-model-continuation-handoff.md) for exact scope,
source identities and retained failures. Those results do not accept the current direct CLI path;
full repository/model workflows and the intended VM deployment remain separate acceptance work.

M36 verification is complete: 42 exact test files and 1,902 assertions passed on `ssh test-env`,
with zero failures/skips. Shared/Server builds, Worker/Server typechecks and Worker packaging
passed; the retired journal owner is absent. See the
[VM simplification handoff](./handoff/2026-09-10-vm-simplification-handoff.md) for source hashes,
lint warnings, the unreleased schema policy and remaining real model/VM validation.

M34's real Notepad++ Worker/UI/evidence/Dashboard acceptance is complete, including the corrected
native driver's **67 passing tests**. See the
[accepted UI handoff](./handoff/2026-09-09-windows-ui-accepted-handoff.md). M35's scoped Linux
journal/recovery verification remains recorded in its
[historical handoff](./handoff/2026-09-09-durable-journal-handoff.md); that unused implementation
is retired by the VM decision. Its passing tests are not evidence for the replacement architecture.

The platform's accepted component and workflow scopes are recorded below. Remaining product and
deployment work is listed above.
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
the isolated synthetic scenarios recorded below. M39 subsequently accepted real CLI ordinary PR
review and Evaluation scoring on the controlled fixture; full Worker/VM deployment remains separate.
M32 historically added provider-response observation, a global runtime registry, HTTP call ledgers,
app-server composition and separate invocation bindings. The CLI-owned architecture retires those
execution paths and configuration requirements. Their implementation and verification records
below remain historical evidence for the original source. Current model output stays separate
from Worker validation facts and evidence, without a provider identity claim.
Actual PowerToys and other intended repository/toolchain profiles, summary/Issue/UI model workflows
and full deployed Worker acceptance remain outside M39's controlled PR/static scope.
The historical model probe denied controlled file writes but allowed a controlled loopback connection,
so Worker-enforced network isolation is not claimed. VM access and network policy belong to
deployment. The
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
| Finding lifecycle | M21 complete result-scoped occurrences, immutable disposition audit and projection, context/CAS checks, policy v2, and conservative explicit result comparison. No disposition or resolution is inherited from a prior result. | Connected administrator fixtures passed. M39's model findings do not replace intended deployment identity and human-disposition acceptance; development samples do not simulate disposition writes. |
| Prompt/profile evaluation assessments | M32 implements frozen inputs, deterministic scoring, immutable assessments and Dashboard workflows. M39 accepted real CLI review arms; M40 accepted both headless Issue-summary arms per CLI and separately retained adjudicated three-case quality observations. | Real PowerToys/UI evaluations, Issue triage and broader representative quality evidence remain outside those specific cases. Their fixture metrics are not a general model-quality benchmark. |
| CLI PR review | M39 accepted six tasks: ordinary PR review plus baseline/candidate Evaluation for Codex and Copilot, using separate complete source/run sequences and real checks, model output, Server/SQLite processing and cleanup. | Not a Worker `main.ts` deployment, actual upstream repository review, general model-quality benchmark or complete Copilot tool capture. |
| Issue reproduction | M22 implements frozen cases, typed probes, target observations and independent assessment. M40 accepted the frozen Issue #1064 headless measurement and all six actual CLI summaries with checked numerical facts and primary/control attribution. | Installed-extension, video, AI/translation, GUI and other repository/toolchain reproduction cases require their own evidence; the accepted sample does not establish those behaviors. |
| Frozen review runs | M14 immutable plans/rendered prompts, request snapshots, job associations, operator creation, and bounded history reads. | Complete product acceptance must exercise real operators and the intended repository policies. |
| Validation results | M15 `ValidationJobResultV1` persistence and fenced completion, with runner checks, model review, lifecycle diagnostics, and evidence completeness kept separate. Legacy review result tables remain supported. | Current-source eligibility must be verified across full executions, reruns, cancellation, and evidence expiry. |
| Evidence | M16 bounded upload, scoped delivery, quotas/retention, and private Linux storage. Full hashes/scenario checks run in a bounded read-only Worker; the SQLite owner rechecks authority after preflight. Cold reads explicitly show pending verification. | Component upload/PNG delivery and concurrent heartbeat/cancellation/shutdown have passed. Intended deployment storage and retention still need operational acceptance. |
| Profile dispatch and admission | M29 extends durable Legacy/V2 admission with repository/global queue and active limits, CAS/audit configuration, queue-credit recovery, successful-service fairness, and durable bounded claim scans. Production lease races, lifecycle tests, a 100,000-Job owner fixture, and connected quota editing/recovery pass. | The measurements cover the declared isolated dataset and host; production workload and deployment-specific capacity still require operational monitoring. |
| Current scheduling diagnostics | Strict M29 V3 diagnostics add current policy, exact scoped usage/overage, and separate queue/active limit reasons; historical V1/V2 remain valid. Repository readers receive coarse platform capacity without foreign counts. | Observations do not reserve capacity or establish queue position or an ETA. Partial inventory cannot prove Worker absence; source/authorization observations do not add new claim gates. |
| GitHub routing | M18 source sequences and immutable legacy/ReviewRun routing per work item, authorization epoch, and source activation. | Automatic webhook/poller-to-profile execution is under integration verification. |
| Headless execution | Registered commands run setup/build/test/cleanup with typed outcomes. M24 passed actual anonymous Git checkout, frozen install, Web compilation, CI tests, original-source verification, HTTP result equality, Dashboard display, and cleanup on a pinned public repository using production disk accounting. | This accepted run explicitly disabled model execution and used synthetic Issue metadata. It does not establish PR model review, measured Issue reproduction, private checkout, or real UI scenarios. |
| Optional validation summary | A bounded model summary is available for UI/Issue validation and defaults to disabled. M40 accepted six real headless Issue summaries, including ordinary V1 advice and required V2 Evaluation summaries; independent review confirmed factual scope and lifecycle. | Windows/Web UI summaries and other cases remain separate acceptance targets. Runner facts and model advice stay distinct, and VM network policy remains deployment-owned. |
| Windows desktop UI | M34 accepted real Notepad++ build, passing and deliberately failing UI scenarios, all ten original evidence assets and Dashboard delivery. The driver retains owned-window evidence, active-session checks, exclusive session lease, process identity/draining, and reset/quarantine behavior. | Real PowerToys and other applications, their complete toolchains/state restoration and unattended VM deployment require their own acceptance. Earlier PowerToys readiness findings are prerequisites to recheck, not acceptance of the profile. |
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

## Historical milestone evidence

The following milestone sections retain their original source identities, test counts and runtime
observations. They describe the source at each milestone, including superseded provider/relay and
schema-upgrade work. Their former pending items are historical, not current backlog or requirements
to restore an OS-attestation design. The current schema, CLI model and remaining product work are
defined above.

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
required model identity and the intended VM deployment remained outside that verification.
M34 subsequently accepted its scoped Notepad++ scenario. No real PR/Issue write was authorized
or performed by this verification.

### M32 Worker source and model-delegation integration

Evaluation source preparation now validates the full frozen V2 source/operator context and its
outer envelope before filesystem admission. Historical PR preparation fetches the exact base/head
object IDs; Issue preparation uses its own evaluation authority and selected commit. Ordinary PR
review and Issue authorization behavior remain unchanged. Source failures never fall back to the
current PR head. Component coverage includes moved references and source/authority tampering.

Profile model delegation now retains the complete V2 envelope through a separate model entry;
it no longer removes validation identity or rewrites the envelope to V1. A model workspace request
must match the original canonical envelope. The legacy entry stays V1-only. This milestone still
refused evaluation execution; the current VM design removes that blanket refusal while retaining
the frozen-envelope checks.

This historical increment used an optional provider metadata classification policy and a shared
decoded-result guard for configured protected values. No actual provider profile was read or
changed and no actual metadata literal was declassified in that increment. The
[former policy](./operations/codex-provider-metadata.md) is retired; current startup does not read
provider profiles or require a classification file.

The final Windows Worker suite passed **1,483 tests with 28 conditional skips across 31 files**;
type checking and production bundling passed. The tested 967-file source archive is
`8125850b76fc4c206caa161f1bad8a127ab0a29eb11e4810cb1b6da3a429f5a7`.
Separate Windows source-preparation acceptance also passed against pinned public commits using
the real Git, ProcessHost, workspace provider and disk accounting. Both synthetic PR/Issue cases
retained their expected commits and clean worktrees, all 30 Git invocations exited zero, and the
two reservations/26 monitors and native host closed. It did not execute a Profile, build, model,
UI scenario or Server admission/completion. The
[Worker integration notes](../artifacts/m32-evaluations-20260908/worker-execution-notes.md)
retain test failures, source identity and the precise scope. This milestone did not advertise
evaluation capability or establish actual provider execution.

### M32 model observation foundation verification

The provider observation, registry, invocation, app-server and summary-input sections that follow
record superseded implementation history. They are not current deployment requirements or
acceptance of the direct CLI path. Use the
[CLI-owned execution design](./design/2026-09-10-cli-owned-model-execution.md) for active behavior.

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
launch configuration, parent-provider composition, fenced Server receipt acceptance and versioned
result integration were completed in later increments. Actual provider execution and intended VM
deployment remain to be exercised. The
[design](./design/2026-09-08-model-runtime-observations.md) describes current integration requirements.

### M32 expected model runtime registry

Migration 0029, authenticated registry routes/RPC, platform administration, repository-scoped model
options, immutable snapshots and separate selection controls are implemented. Evaluation creation
resolves a selected registration under the owner transaction. Compact cell references bind the full
configuration/plan/context snapshots without expanding the cell-manifest storage limit. Existing
unknown history remains unchanged. Registration alone does not supply actual invocation/output
records or satisfy the other Worker capability and lease requirements.

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
verification are implemented. This historical milestone included the unused `executionAccepted`
field. The current development schema removes it directly under the unreleased-product policy;
there is no old-version upgrade or conversion task. The original milestone artifacts remain unchanged.
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

The coordinator was not yet composed into the production attempt lifecycle at this milestone.
Later stages connected CLI/launch-policy measurement, parent provider configuration, final
model-output binding and result/Dashboard integration. Actual provider and VM deployment acceptance
remain open. See the [design](./design/2026-09-08-model-invocation-control.md).

### M32 invocation diagnostics and collector prerequisites

Operators can read invocation history from any evaluation cell, including failed Jobs and cells
without a final result. The owner verifies current repository permission, the frozen cell and every
stored opening/seal/submission reference and digest. History remains readable after old Worker
credentials or leases expire. The Dashboard separately shows expected/recorded model identity,
call outcomes and incomplete collection reasons. The unused execution-acceptance field and its
display are removed from the current development schema. Reads are explicitly
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
remain protected even when provider launch settings are replaced. Startup did not yet construct
these sessions at this milestone; later stages added composition and final model-output binding.

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
digests. Matching collection establishes consistency with the frozen expectation and recorded
output, not OS confinement. Startup composition was connected in the subsequent stage. The VM
design removes the former blanket required-model refusal while retaining result binding.

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
capture passed 2,033 Worker tests with 28 conditional skips, type checking and build; this stage
did not change the then-current execution restrictions.

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

This transport stage did not change main startup or the then-current evaluation/model gates;
subsequent startup composition is described below. Actual model execution remained unverified,
and previous trusted binary copies/pins were not replaced. See the [transport design](./design/2026-09-08-process-host-interactive-stdin.md)
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
startup is connected in the subsequent startup stage below. This stage did not accept actual model
execution or a Windows application, and did not change the then-current execution restrictions.
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

These metadata checks do not establish OS enforcement or real model execution. Production startup
is connected in the next stage; evaluation-only/composed-input checks remain in place.
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

This composition was verified synthetically and did not exercise a real provider. Evaluation
summaries use the subsequent independently frozen input integration below. The current VM design
uses configured backend availability and ordinary capabilities/leases instead of an OS-attestation
gate. No Windows sandbox setup or real repository write was performed by this integration.
See the [startup design](./design/2026-09-08-evaluation-model-startup.md)
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
profile-only evaluation does not acquire model authority. Mapped evaluation reproduction retains
its own frozen input checks. This implementation does not establish actual model execution or
VM deployment acceptance; the former blanket execution guard is retired by the VM design.
See the [input design](./design/2026-09-09-frozen-validation-summary-input.md)
and [integration evidence](../artifacts/m32-evaluations-20260908/summary-input-delivery-notes.md).

### M32 evaluation profile and model routing

Worker frozen-envelope validation now distinguishes evaluation authorization from ordinary Issue
source authorization. Model selection follows the frozen model requirement: profile-only evaluation
does not invoke model factories, and a required model cannot become optional because configuration
is missing. Explicitly pinned evaluation summary composition is independent of ordinary optional
summary opt-in. Required failures retain runner facts in the recorded-result format.

New Server completion rejects embedded or completed model content for profile-only evaluation,
while retaining ordinary summaries and historical V1 reads. This routing stage did not change
the then-current execution restrictions. The VM design now removes the blanket refusal while
retaining required-model factory availability and scope/output/observed-identity checks.
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
their previews; blocked previews remain valid configuration outcomes. Actual evaluation/model
execution remains unverified by these mapping tests. See the
[mapping design](./design/2026-09-09-evaluation-reproduction-mappings.md) and
[verification records](../artifacts/m32-evaluations-20260908/mapped-reproduction-delivery-notes.md).

## Retained architecture baseline

This section preserves the historical Job-based architecture at schema 31. Its Job protocols,
`loopback`/`oidc` authentication, `WORKER_*` configuration, and ordered SQL initialization are not
the active investigation runtime. The responsibilities below describe that earlier snapshot only.
The current Task/Report runtime uses built-in password accounts, `investigation-v2`, and
`INVESTIGATION_WORKER_*`; see [Architecture](../ARCHITECTURE.md) and the delivery sections above
for current implementation and acceptance boundaries.

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
- That baseline used schema 31 and its ordered SQL initialization definitions, without an
  old-version upgrade, reset, data conversion, or compatibility migration project.

### Windows Worker

- One production Worker entry point and bundle: `apps/worker/dist/worker.mjs`.
- Real execution is wired when `WORKER_EXECUTION_ENABLED=true`.
- Worker registration, long-poll claims, Worker and lease heartbeats, drain, and fenced terminal
  reporting.
- Pinned Git and ProcessHost executable paths and SHA-256 verification.
- Codex or Copilot selected through `WORKER_CLI_ENGINE` and `WORKER_CLI_EXECUTABLE_PATH`, with
  optional `WORKER_CLI_HOME`, `WORKER_CLI_MODEL` and `WORKER_CLI_SHA256`.
- Bounded ProcessHost CLI version detection through `--version` (20 seconds, 64 KiB, first stdout
  line), with nullable `cliEngine`/`cliVersion` capabilities instead of a declared CLI version.
- Replacement child environments that exclude the Worker Bearer Token.
- CLI-owned login, provider configuration and network traffic. The Worker does not inspect, copy
  or rewrite CLI auth/provider files, and persistent login storage stays outside disposable tasks.
- CLI paths may be outside the infrastructure trusted root; Windows WinGet application links
  resolve to their installed targets. ProcessHost/Git retain the existing trusted-root rules.
- No global provider registry, model HTTP relay, provider call ledger or metadata policy file.
- CLI configuration, process exit and structured output remain distinct from runner checks and
  evidence. They do not independently verify a provider's model identity.
- Model resource settings use `WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS`,
  `WORKER_MODEL_MAX_PROCESSES`, `WORKER_MODEL_MAX_MEMORY_BYTES` and `WORKER_MODEL_MAX_OUTPUT_BYTES`.
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
- Selected CLI execution with outbound network access for trusted admitted code.
- Legacy pull request prompt authorization to inspect, edit, build, and test inside its disposable
  worktree. Profile execution keeps model edits separate from original-source runner validation.
- Inline schema-validated result submission.
- V2 inline results separate model verification claims from captured command exits and final
  worktree state; bounded redacted failure diagnostics are persisted and shown in job details.
- That baseline's envelope/result versions kept their declared semantics independently of database
  schema version; they did not introduce an old-database upgrade path.
- Progress deadline refreshes only on observed CLI stdout/stderr activity; silent execution no
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

The 2026-09-10 VM decision additionally removes the unused WindowsAttempt domain lifecycle,
Worker lifecycle/journal/recovery modules and separate journal-owner bundle. Its former protected
storage, OS adapter, signed evidence and execution-admission backlog is retired. The existing
Job lease and ProcessHost/workspace cleanup mechanisms remain.

ADR 0029 remains the decision for these removals. The new bounded M16 evidence channel is governed
by ADR 0031; it must not be described as the restoration of those prototypes.

## Retained foundation contracts

These are historical foundation contracts for the Job-based baseline above. They are retained to
interpret its code and receipts, not as active configuration or compatibility requirements for the
Task/Report runtime. In particular, its authentication modes, credential-file convention,
`WORKER_CLI_HOME`, and completion protocol must not be used to configure the current application.
The historical exclusions in the next section are not a current implementation backlog.

- Worker authentication: one node-scoped Bearer Token stored at
  `C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json`.
- Operator authentication: explicit `loopback` or `oidc` mode.
- Pull request repository cache: `<git-shared-root>\repository-<githubRepositoryId>.git`.
- Shared repository policy: bounded total bytes and free-space guard with conservative Worker-owned
  maintenance only when worktree metadata is inactive.
- Local execution singleton: one global ProcessHost mutex per resolved Worker data root.
- Task checkout: detached worktree below the per-attempt workspace directory.
- CLI login: managed by the selected Codex or Copilot CLI under the Worker account, using the same
  optional `WORKER_CLI_HOME` as the deployment. No login storage is read or copied by the Worker.
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

Repository verification defaults to the project-designated remote Windows worker. Linux-specific
checks may use `test-env`; local validation requires explicit authorization for the current task.
If the designated environment is unavailable, report verification as blocked instead of falling
back to local execution. Historical verification authorization does not authorize local checks of
subsequent changes. The standard package gates are:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

ProcessHost Go tests and Windows cross-compilation are separate checks. Windows-native validation
is required in addition to Linux CI, which cannot establish Windows process, path, ACL, Git, or
CLI runtime behavior. The historical runtime exercise below predates the active Task/Report delivery;
its passing counts do not establish that the current branch's CI is green.

The 2026-09-06 remediation passed all Linux gates, 1,354 Linux Node tests, 591 native Windows Worker
tests with no skips, native Windows ProcessHost tests/vet/build, and the deployment PowerShell
checks. This includes all 14 Worker tests skipped on Linux. The remediation handoff records the
explicit authorization and separates these regression gates from historical live Codex E2E. The
current platform's authorized checks are tracked separately in the implementation ledger. The
recorded M28 full Linux Server suite passed 4,205 tests with one skip across 100 files; Dashboard
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
