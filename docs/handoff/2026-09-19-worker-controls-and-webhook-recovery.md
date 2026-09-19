# Worker controls and webhook recovery handoff

Status: scoped remote software verification and the recorded Dashboard/native intake browser
checks passed. Two real PR #14 sequences ended without a model invocation and retain their failed
or cancelled outcomes. PR #15's sixth real Task completed its scoped Calculator E2E with all three
registered features and four required UI assertions passed. GitHub media display/playback is also
accepted for the fifth report, whose Task remains blocked. The sixth Task's workspace cleanup and
native lease release are confirmed. The eighth Task also completed naturally with confirmed cleanup,
but its observer failed before Worker disable. W4 subsequently passed in a separate native fixture
with synthetic inputs and real runtime processes. Operational closeout is complete and temporary
capacity settings are restored. Git integration and publication are a separate handoff.

The [design and acceptance matrix](../design/2026-09-19-worker-controls-and-webhook-recovery.md)
defines the current requirements. Earlier accepted local-source review, accounting, scheduling,
media, and managed recovery behavior retains the scope of its
[separate handoff](2026-09-19-local-source-review-e2e.md). Private runtime, credential, environment,
and authorization records are retained outside the repository.

## Current implementation boundary

The Worker setting controls whether a Worker can take only static application Tasks or also
execution Tasks. Local screenshots remain allowed. It does not add a shell restriction framework
or operating-system sandbox. Static investigation images/videos cannot enter GitHub media uploads.

The current implementation also provides Worker management state, scoped webhook receipt history
and explicit intake retry, committed-Task recovery, and a separate durable relay spool. Relay
explicit retry preserves signed envelopes and cumulative history, uses version/idempotency checks,
and atomically reserves a finite additional attempt batch. Spool schema v2 is independent of the
application's `investigation-v4` store. Software/browser, real-fork functional/media, and supplemental
native cancellation evidence below retain their separate acceptance boundaries.

## Recorded software verification

Checks ran in designated remote environments with isolated test data. The principal source snapshot
is v3 with its verified formatting overlay. A later v4 Worker prompt overlay has separate focused
checks; the v3 full-suite counts do not claim a complete rerun of v4. The v4 software candidate is
sealed with source-manifest SHA-256
`58a4948ff3d9aee1ea44c4dafc3f5f942eeee9ef6eef64d1756079a94e0fab21`
and runtime-asset-manifest SHA-256
`35e337c8eb2ce02c9aca9d4b27568d1ebbc5c0507a35ed1792e8fdf88b54f403`.
The implementation remains unchanged through the browser checks below; this handoff and subsequent
documentation edits are a later overlay, not a new code-verification claim.

| Scope | Recorded result | Boundary |
| --- | --- | --- |
| Windows v3 shared/application builds and type checks | Passed | Shared packages and Server, Worker, Dashboard scopes; this does not prove application behavior. |
| Windows v3 changed Server regression group | 129 passed across 3 files | Patch lineage, E2E intake, and relay spool; included again in broader scopes below. |
| Windows v3 Contracts full suite | 1,761 passed across 46 files | No real repository workflow. |
| Windows v3 Domain full suite | 417 passed across 14 files | Deterministic domain checks. |
| Windows v3 Codex full suite | 222 passed across 8 files | Adapter/contract checks, not a real model invocation. |
| Windows v3 Server investigation subset | 1,611 passed across 47 files | This subset passed within an otherwise unsuccessful full Windows Server run. |
| Original Windows v3 Server full run | Failed in 15 files | Historical database/evidence paths include Linux SQLite-owner requirements, an initialization-path failure, and expectation mismatches. Original failure receipts remain unchanged. |
| Linux formatted-v3 Server full suite | 7,351 passed, 1 skipped across 206 files | All 15 Windows-failing files passed here with no skips. The one suite skip is a Windows-only UNC/case-alias configuration case. This does not make Linux-only ownership paths supported on Windows. |
| Original Windows v3 Worker full run | 3,377 passed, 3 failed, 44 skipped | The three failures were in the real-filesystem Git cleanup file. The full-run receipt remains failed. |
| Windows v3 Worker investigation subset | 1,282 passed across 30 files | No failures or skips in this subset; these are already included in the full-run counts. |
| Targeted Windows Git cleanup replay | 5 passed in the complete cleanup test file | Unchanged source and Git configuration with a shorter temporary root. Assertions that the nested file/directory exceed 260 characters and the real long-junction target were retained. |
| Sealed Windows Worker combined coverage | 3,380 unique passed, 44 skipped | Combines the original run with that complete unchanged-file replay; it does not relabel the original full run as passed or count repeated cases twice. |
| Windows v3 Dashboard full suite | 3,936 passed across 139 files | Simulated transport/rendering coverage; live browser interactions remain separate. |
| Windows affected lint | Exit 0 with 297 warnings | Warnings remain recorded; this is not a zero-diagnostic result. |
| Windows relay-adapter and accounting helpers | 11 adapter cases and 18 accounting/scope assertions passed | Synthetic helper checks; no real model, GitHub publication, or live application acceptance. |
| Linux relay component | Type checking and 82 cases passed | Exact relay source/test identity also appears in the complete Linux Server suite; do not count these as additional unique cases. |
| Linux relay process termination/restart | Two isolated process scenarios passed | Real process interruption with a synthetic receiver; detailed scope is below. |
| v4 Worker prompt overlay | Worker type check, build, focused prompt tests, and prompt-file lint passed | The recorded delta is the E2E runner prompt. This focused result does not replace broader v3 receipts or establish real E2E success. |

The complete Linux Server check retained 1,419 source files with no post-run source changes against
the formatted-source manifest. Overlapping focused checks and investigation subsets are not added
to full-suite totals. Earlier failed runs and limited replays remain separate observations.

The relay's two process scenarios cover interruption after durable enqueue but before sending, and
interruption after the receiver committed its effect but before the response was recorded. The first
restarted process delivered the original envelope. The second retained the interrupted attempt,
waited for its lease to expire, and received `duplicate` on the next attempt: two HTTP requests
produced one durable logical effect. The fixture's owned processes and receiver were cleaned up.
This is fixture cleanup only; it is not operational closeout of the application acceptance session.

The relay's first two Linux setup attempts failed on dependency/tooling preparation and explicit
Node type configuration. Those receipts are retained. The successful isolated configuration did
not change product source. These software and process checks do not establish OS-reboot, power-loss,
filesystem-failure, or SQLite VFS synchronization behavior, nor actual GitHub redelivery or desktop
execution.

## v5 comment-text privacy increment

A separate text-rendering gap allowed absolute POSIX paths outside a fixed root list, including
`/srv` and `/data`, to remain in automatic/progress comment text. This was not an image/video upload
bypass. The v5 increment changes only the two comment templates and their two test files, adding
30 regression cases while preserving public URLs and relative source references.

The first complete two-template run retained 245 passed and 7 failed cases. The bare-path branch
could begin at the preceding space before a quoted path and consume it before the complete quoted
branch, leaving a suffix visible. The correction changes that prefix to a zero-width boundary so
the full quoted-path match can win. Test assertions were not weakened or changed for the correction.

The recovery run completed Server type checking and build, then passed both complete template
files: 205 automatic-template cases and 47 progress-template cases, 252 total. Four-file lint
exited 0 with 79 warnings and 2 informational diagnostics. The original seven failures remain
recorded separately.

Shared, Worker, and Dashboard code/assets remain unchanged from v4. This is focused software
verification of the four-file privacy delta, not a full v5 Server-suite or UI rerun, live comment
acceptance, or E2E result. The final v5 seal records 1,419 source files and 1,271 runtime assets:
only the four privacy source files changed and Server output was rebuilt; other assets were reused
byte for byte. The sealed v4 identities and their accepted scopes above remain unchanged.

## Recorded Dashboard and native intake acceptance

These checks used the sealed v4 implementation. Real browser interactions, production HTTP routes,
and SQLite persistence are distinguished from simulated API/state fixtures and mocked GitHub data.
None of these scopes launched a model or tested Calculator behavior.

| Scope | Recorded result | Boundary |
| --- | --- | --- |
| Dashboard against the real isolated application | 5 steps passed | Default-off Workers, native enable persistence, disable/reload persistence, the 430-pixel Worker layout, and the empty webhook view. No running application was cancelled. |
| Dashboard with synthetic HTTP/state fixtures | 16 steps passed, 4 Worker states, 19 screenshots | Static-only, E2E-allowed, disabling, and awaiting-cleanup rendering; webhook history, simulated recovery, reused retry keys after transport failure, stale-version refresh, and empty states. No real API mutation, Task execution, policy mutation, or GitHub request. |
| Production native intake and real browser | 12 steps passed, 13 screenshots | Real password session, HTTP/SQLite intake, list/detail/history, actual retry buttons, and actual queued-Task links. Only GitHub responses and injected source/Task failures were mocked; the browser did not replace application API responses. |
| Native HTTP guard and idempotency self-check | Passed | Unauthorized retry returned `403`; stale version returned `409`; exact command replay retained Task identity; conflicting retry keys and retrying completed intake were rejected. The isolated self-check shut down. |

The native browser fixture contained two independent events, one failing source preparation and one
failing Task creation. Each retained three unsuccessful processing attempts and no Task before the
injected fault was removed. Clicking the actual retry control produced attempt 4, a completed intake
receipt, and exactly one real queued Task for each target. The browser followed both Task links.
Those queued Tasks had no Worker execution; intake completion is not Task completion or proof of
the separate already-committed-Task crash-recovery scenario.

The final narrow-layout observations waited for the responsive layout to stabilize and measured
both main content width and scroll width at 430 pixels. Earlier login helpers failed to match the
required-field labels' asterisks, and earlier resize checks sampled the React sidebar transition's
intermediate frame. Their original failure receipts remain preserved. The diagnostic observation
showed the settled layout at 430/430; the helper's selector/stabilization corrections required no
product CSS change or alteration of the sealed v4 code.

Screenshots remain evidence for the recorded UI scopes, not GitHub media-publication acceptance.
The fixture browser and isolated native test processes shut down with no remaining fixture listener.
This does not close the real-fork acceptance session or establish its final cleanup.

## Retained PR #14 live attempts

[PR #14](https://github.com/moooyo/PowerToys/pull/14) remains an open draft with its original refs,
body, comments, and failed history preserved. It is no longer the selected execution candidate.
Its original source pins are head `8c61ee10bfdb876046d7b852441c0cd4a8c45775` and base
`1744bdecd8a46b5c165c4fb3c0a9698c9aad682f` from upstream PR #47506.

Both signed E2E command sequences admitted one queued Task while the only active Worker had E2E
disabled. The recorded policy/claim cycles left those E2E Tasks with zero attempts and model calls.
An assignment then allowed that Worker's existing all-role capability to claim static work. This
accepts the observed admission boundary, not successful static review or E2E execution.

| Sequence | Recorded outcome | Boundary |
| --- | --- | --- |
| First PR #14 sequence | Both Tasks cancelled before model execution | The acceptance monitor misclassified source preparation before the first invocation as terminal unknown usage and requested cancellation. This was a helper failure. |
| Second PR #14 sequence | Static Task blocked with `SOURCE_TREE_UNSUPPORTED`; queued E2E Task cancelled without an attempt | The corrected monitor accepted the legitimate preparation window. Source admission then rejected unsupported Git tree entries before any model launch. |

The first cancellation did not exit cleanly: the Worker returned exit code 1 after
`SOURCE_PROCESS_CLEANUP_UNCONFIRMED`. Later independent process-identity checks established that its
owned processes had terminated. The original exit and unconfirmed-cleanup receipt remain failures;
they are not relabeled as graceful shutdown. The second sequence's owned services subsequently
stopped normally, and its temporary intake hook and assignment changes were cleaned up. These are
sequence-specific observations, not final operational closeout of the complete acceptance effort.

The second source blocker was established from complete pinned upstream trees and the current
validation path: both PR #14 revisions contain mode `160000` gitlinks at `deps/expected-lite` and
`deps/spdlog`. Five supported `.claude` symlink entries were not the identified cause. The rejected
attempt's original tree-command output was not recovered after normal workspace cleanup, so the
diagnosis does not claim that evidence. Source restrictions were retained; no submodule support or
source rewrite was added to manufacture a pass.

Across the four retained Tasks, three are cancelled and one is blocked. Their authoritative usage
summaries are complete: zero model invocations and zero reported tokens. No real Calculator
assertion, feature recording, or media-publication acceptance resulted from these sequences.

## Current fixture and required observations

The current fixture is the open draft [owned-fork PR #15](https://github.com/moooyo/PowerToys/pull/15).
It uses the actual merged revision of [upstream PR #47506](https://github.com/microsoft/PowerToys/pull/47506),
not that PR's original author-branch head. Its head is
`c46083dd8d6012f76ab328fabcb1a4d17cf135aa`; its sole parent, base, and merge base are
`65112a7b05ab4a05a24f70933e82711037eebeba`. The change is one commit, four Calculator files, +21/-1.
Both complete source trees contain 9,510 entries with no gitlinks or unsupported entries. This
merged source includes upstream's intervening submodule removal; it is not a synthesized patch.
The all-changed-path coverage gate remains unchanged. Creation and source-tree inspection are not
a dependency-restore, build, or functional pass; the later individual assertions retain their scope below.

The required observations are the actual unsupported-complex-number `SubTitle` for explicit
`=sqrt(-1)`, no Calculator error row for implicit `sqrt(-1)`, and Calculator result `4` for `=2+2`.
Before the implicit absence assertion, the same application session must show Calculator result `4`
for implicit `2+2` without `=`. This positive control proves that Calculator is active in that query
mode; a disabled plugin must not produce a false pass. Other plugins' rows neither fail the absence
assertion nor satisfy the positive control.

[PR #13](https://github.com/moooyo/PowerToys/pull/13) remains superseded, unexecuted, and closed, with
its refs and body preserved and no run-created comments or reviews. The earlier Peek and Launcher
failures remain in their original handoff and are not resolved by selecting this fixture.

## PR #15 intake and static execution

The real PR #15 E2E command reached the webhook and durable relay spool. One relay attempt received
HTTP `202 accepted`. Native intake first recorded `source_changed_during_import`, then recovered
automatically on its second processing attempt. The receipt does not establish the cause of that
initial source change, and no cause is inferred here.

Both registered Workers had E2E disabled. After 34 observed policy/claim cycles returning HTTP `200`,
a fresh native read still showed the E2E Task queued with zero attempts and zero model invocations.
A subsequent single assignment created static work, which a Worker executed while its E2E setting
remained false. Source materialization took 31.2 seconds, followed by one model invocation. The
static Task completed at 09:45:41 UTC with complete recorded usage of 460,655 tokens and no unknown
invocations.

The [static result comment](https://github.com/moooyo/PowerToys/pull/15#issuecomment-5740820790)
was independently read through GitHub and matched the native UTF-8 body exactly. It contained no
image or video. The first comparison failed because the observation helper used PowerShell's
default ANSI decoding; explicitly reading UTF-8 established the match without editing the comment.
That failed comparison remains recorded and is not a publication-content change.

The static resource was released afterward. The Worker then stopped cooperatively with exit code 0,
and a later independent observation proved all of its owned processes had exited, with no remaining
attempt directories or cleanup-journal entries. This accepts the observed static-only execution and
shutdown sequence. The E2E Task remained queued; Calculator functionality, feature media, GitHub
redelivery, and disabling during application execution had not begun.

An earlier read-only observer failed because its helper lacked an import. After that helper was
corrected, a read-only observation recovered the proof without creating another event or rerunning
the Task. The original observer failure remains recorded and is not a product defect.

The next E2E preparation identified a separate prompt gap: the independent E2E prompt did not include
the frozen PR body and conversation. The three-file v6 Worker correction now has six passed remote
verification stages, including Worker type checking/build and both complete relevant test files:
136 model-turn-runner cases plus 34 E2E-agent-runner cases, 170 passed. Three-file lint exited 0
with 35 warnings and no errors. This is focused verification, not a complete Worker-suite or UI
rerun, and it does not establish live E2E success.

The v6 seal contains the three Worker source changes and 125 Worker assets. The other 1,146 Server,
Dashboard, and shared assets retain exactly the v5 set and hashes. At that preparation stage, the
next execution Worker was planned to use the v6 entry point and working directory while the Server
and other Worker retained v5 assets, with the existing database and Task unchanged. E2E was not yet
enabled. The correction does not change the frozen Task scope or PR or hardcode the four Calculator
observations. The accepted v5 software/privacy evidence above remains unchanged.

## PR #15 first E2E outcome and static overlap

The first real PR #15 E2E Task ended blocked before application launch. The configured Azure package
feed returned HTTP `401` for five required .NET 8.0.30 packages. Official-source copies were then
checked against SHA-512 and Microsoft signatures and added to the global package cache. The product's
controlled build had not yet been rerun at that observation; cached dependencies alone are not a
successful restore, build, application launch, or functional assertion.

A second static Task ran concurrently with the E2E attempt and subsequently completed, establishing the observed real
static/E2E overlap. Both static reviews completed, and both text publications were independently
matched to their native bodies with no image or video. This accepts their static review/publication
and scheduling scope, not successful Calculator execution. At that observation, PR #15 accounting was complete:
three model invocations, 1,554,500 reported tokens in total, and no unknown or active invocations.

One actual GitHub redelivery through the earlier CLI forwarding hook recorded HTTP `401`, and the
owned relay did not receive it. A local-time filter initially hid that provider record because the
clocks differed; later readback recovered the failed record. Clock skew explains the missed
observation, not the cause of the HTTP `401`. The original failure remains retained. A standard
temporary HTTPS webhook path was then prepared for a further delivery attempt; its subsequent new
command intake is recorded below and does not establish successful GitHub redelivery.

Both Workers, the earlier network companion, and that monitor stopped cooperatively. The Server,
usage ledger, Task reports, and history remain preserved. This closes those owned execution processes,
not the full acceptance effort. At that observation, Calculator functional E2E, feature media,
successful redelivery, disabling during an active application, and final operational closeout
remained open.

## HTTPS intake and the next controlled-build blocker

The standard temporary HTTPS webhook path received a new PR #15 command, verified its original
payload signature, and returned HTTP `202 accepted`. Processing that same recorded delivery first
reported `source_changed_during_import`, then succeeded automatically on attempt 2 and created
exactly one Task. This is new-command intake with an internal processing retry, not a successful
GitHub redelivery. No cause is inferred for the initial source-change response.

With the selected Worker's E2E permission disabled, the new Task remained queued with zero attempts
and invocations. A version-checked update then enabled E2E, and the Worker actually claimed and
executed the Task. NuGet restore passed in this run, establishing that the earlier package-cache
preparation resolved that observed restore blocker.

The controlled build then stopped with a reported `MSB8040` error for missing Spectre-mitigated
libraries, leaving the Task blocked before UI launch. Its retained build summary reports zero
warnings and one error. The original diagnostic has `outputTruncated=true`, so this record does
not claim that the complete build log was retained. Matching components were then identified in
the applicable Visual Studio catalog; the subsequent installation is recorded below.

The new invocation had complete reported usage of 744,237 tokens. At the end of that blocked stage,
PR #15 usage was complete across four model invocations at 2,298,737 reported tokens, with no unknown invocations.
The corrected monitor remained healthy and showed its terminal-review notice without incorrectly
stopping the Worker. Monitor health alone did not establish cleanup; the later owned-cleanup
confirmation is recorded below.

Twelve isolated HTTPS-adapter cases passed. Their scope and the successful new-command intake do
not establish actual GitHub redelivery, Calculator functionality, feature-media publication, or
disabling a running application. All earlier blocked/failed receipts remain retained.

## Confirmed cleanup, cached redelivery, and Spectre installation

Owned cleanup for the latest blocked E2E attempt was subsequently confirmed, and its lease was
released. An independent unauthenticated public GET of its terminal comment matched the native body
exactly and contained no image or video. This accepts that cleanup and terminal-text publication,
not Calculator functionality or feature-media publication.

An actual GitHub redelivery through the standard temporary HTTPS hook succeeded with HTTP
`202 duplicate`, the same delivery GUID, and identical original raw bytes. The owned relay answered
from its cached receipt: spool history and the then-existing four PR #15 Task, four Attempt, and four model-invocation identities remained
unchanged. The proved boundary is external delivery to the owned relay's cached duplicate response.
`receiverReentryTested=false`: this was not a second entry into the Server receiver. Native Server
duplicate handling and committed-Task recovery retain their earlier, independent test evidence.
The previous CLI-hook HTTP `401` remains a failed receipt whose cause has not been established.

Relay evidence therefore distinguishes the actual cached redelivery from the passed isolated
process-interruption/restart cases. Neither establishes physical power-loss behavior; sustained
workload and capacity acceptance remain deferred. No additional receiver re-entry run is implied
by the cached-redelivery result.

The matching Spectre-mitigated-library component installed with exit code 0. Only that component
was added; the Visual Studio/catalog versions and key compiler, MSBuild, and SDK pins remained
unchanged. Installation alone was not a build or functional pass. At that point, recorded usage was
complete at four model invocations and 2,298,737 tokens; the subsequent build and fifth Task are
recorded below.

## Build readiness and the fifth real Task

After the minimal Spectre-component repair, an independent fixed-source Launcher build-readiness
check passed with exit code 0, four warnings, zero errors, and complete retained output. It ran
without a model, application launch, or Task. This establishes build readiness only and does not
replace the real E2E workflow.

The fifth real PR #15 Task then performed its own checkout and controlled build, which also passed
and sealed 1,321 output files. The actual Launcher from that build started. Three registered features
contain four real UI assertions, all passed, covering the required Calculator observations. The
implicit `2+2` positive control passed before the implicit no-error-row assertion. Four PNG images
and one valid MP4 were retained, with complete assertion-to-media bindings. An independent review
inspected all four images and assertion receipts. These establish the controlled build and four
individual business-behavior assertions, not a complete E2E pass.

The Task's final outcome is blocked. One earlier registered feature targeted the static accessibility
labels `Title` and `Path`; its two assertions were not executed and remain blocked. That feature and
the original report are preserved. The three later passed features do not make all registered
features pass or permit the overall outcome to be relabeled.

Report delivery and owned cleanup were confirmed, the native lease was released, and no attempt
directories remained. This invocation reported 4,098,851 tokens. At that point the cumulative total
was 6,397,588 tokens across five complete model invocations, with no unknown invocations. Subsequent
GitHub image/video display evidence is recorded below. These results do not rewrite
the earlier package-feed and Spectre-blocked Task reports.

A same-scope follow-up was prepared using the observed `QueryTextBox` input and `ListItem` result
mapping as diagnostic context in its command. Code, gates, pinned source, API, and all four expected
observations remained unchanged. Its independently executed sixth Task is recorded below; the
fifth blocked record was not edited or resumed as a substitute.

## Fifth-report GitHub media and the completed sixth Task

The fifth report's actual GitHub comment loaded all four PNGs, and its MP4 played and decoded.
An independent anonymous read also matched the comment body exactly to the native body. This accepts
that report's publication and media dimension while preserving its blocked Task outcome. Intercepted
peripheral GitHub POST requests produced two `TypeError` messages during inspection; this is not
a claim that the whole GitHub page had zero errors.

The sixth real PR #15 Task completed at 13:51:42 UTC. It checked out the same pinned source and
performed a new independent controlled build and application launch; it did not reuse the fifth
Task's or the standalone readiness build's outputs. Exactly three registered features and all four
required UI assertions passed. Four PNGs and one valid MP4 retain their individual evidence bindings.
The implicit `2+2` Calculator result `4` was confirmed before checking the implicit complex-query
error-row absence. The only added diagnostic context was the previously observed control mapping;
source, code, gates, API, and expected behavior were unchanged.

Independent review read all four raw assertion receipts and the sealed E2E report summary/feature
matrix, and visually inspected all four PNGs for agreement. This is the accepted functional scope
of the sixth Task; it does not rewrite the fifth Task's unexecuted feature or earlier failures.
The invocation reported 4,006,462 tokens. The settled six-Task total is complete at 10,404,050 tokens
across six model invocations, with no unknown invocations. This subtotal does not include the
subsequent seventh Task recorded below.

The report retains its limits: fixture source unit tests were read but not executed; the internal
evaluator's concrete runtime type was not independently measured; and non-target PowerToys plugins
reported initialization errors. Calculator participation in global queries was positively verified.
These limits remain part of the scoped result and do not imply additional unrequested validation.

The sixth Task's cleanup journal reached revision 6 with all required confirmations true at
13:57:22.280 UTC. The independent native readback at 13:58:25 UTC confirmed lease release, zero
scheduler occupancy, zero attempt directories, and zero owned applications. Cleanup is accepted
from those records, not inferred from the completed Task state. The GitHub media acceptance above
refers specifically to the fifth report.

## W4 observer failures and separate cancellation fixture

The seventh Task's signed intake recovered from `source_changed_during_import` on attempt 2,
creating one Task. Its watcher stopped before Worker disable at 15:13:27 UTC: no disable marker or
CAS occurred. The wrapped exception has no retained stderr; a later missing post-cleanup output
path does not establish the original cause. The Task itself completed at 15:17:54.127 UTC with
3,406,345 tokens; that stage's settled usage totaled 13,810,395 across seven complete calls, with no
unknowns. Cleanup confirmation was still pending at that observation; its original records remain unchanged.

The eighth Task completed naturally at 16:14:50.871 UTC with three features and four assertions
passed. Its invocation reported 3,835,014 tokens, bringing settled real-model usage to 17,645,409
across eight complete calls with no unknowns. Cleanup journal revision 6 had all three confirmations
true at 16:19:46.257 UTC, and subsequent state showed no occupied slots, attempt directories, owned
applications, or leases. The [terminal comment](https://github.com/moooyo/PowerToys/pull/15#issuecomment-5743259175)
matched its native body on anonymous readback; four PNGs and one MP4 retained their verified bindings.
These results preserve the original seven Tasks and do not establish W4.

The eighth watcher failed its main-window/receipt consistency check before any disable CAS. The
report records loss of foreground during bounded observation and an initially blocked video
finalization, followed by activation and a short replacement clip. The mismatch is not established
as merely a handle-selection problem. A 300-second read-only recovery found no new eligible clip
and stopped when the Task became terminal. No native resume replays the E2E, and original markers
remain preserved.

The separate native cancellation fixture passed at 16:57:32.127 UTC. Only source, upstream, and
provider inputs were synthetic; isolated SQLite and real Server, Worker, E2E runner, tool service,
ProcessHost, heartbeat, cancellation, window, FFmpeg, and cleanup handled execution. Two native
observations proved the application and recorder active before the real Worker flag API disabled
E2E. The Task became cancelled, both owned processes exited, journal revision 6 confirmed all three
cleanup fields, and the lease released with zero occupied slots. Recorded guard snapshots were empty
before and after the case. Closure confirmed the runtime and Server stopped; the Server and outer
process exited 0.

The provider built, launched, registered evidence, started recording, and then only awaited
`AbortSignal`; it never stopped processes, deleted files, or wrote cleanup journals/leases. No real
model ran, and synthetic zero-usage records are excluded from the eight-call 17,645,409-token total.
This accepts native cancellation, not a real-PR/model W4 run; the original two observer failures
remain unchanged. Fixture v1 failed helper syntax checking before the case started; v2 added
one missing closing brace and passed without changing product gates.

Phase 1 closeout also disabled the idle execution Worker and confirmed **Static only** in the real
Dashboard; that idle change is not the W4 case. The temporary hook was deleted with independent
`404` readback, the HTTPS companion/listener closed, repository automation flags were disabled,
and PR #15's empty assignment baseline was restored. Four paused workflows were restored, with all
nine workflow states matching their original baseline. The fork test-write window is closed.
Owned process trees stopped cooperatively with exit code 0. Temporary runtime registrations,
credential copies, and firewall configuration were removed with readback confirmation; temporary
capacity settings were restored. Legacy services and historical records remain preserved.
Operational closeout is complete. Git integration/publication is tracked as a separate handoff.

## Operational closeout and publication boundary

| Scope | Recorded result |
| --- | --- |
| Operational closeout | Completed owned-runtime/resource cleanup and restoration, preserving historical data and original failed receipts. Git publication is handled in a separate handoff. |

The real-PR functional/media results and supplemental native W4 fixture retain their distinct scopes;
operational closeout is complete. The cached-redelivery result retains its explicit receiver
boundary above. Production hosting and sustained workload/physical storage-capacity acceptance
remain deferred.
