# Local source review and E2E verification handoff

Status: implementation gates, real-repository acceptance, and operational closeout completed in
the designated remote Windows environment. PR scenarios retain their recorded failures and
blockers; this record does not certify that every tested PR feature passed.

The [design and acceptance matrix](../design/2026-09-19-local-source-review-and-e2e.md)
defines the required behavior. Private infrastructure, credentials, and execution authorization
records are intentionally outside the repository.

## Resulting behavior

- New static source reviews navigate the complete local checkout at the pinned revision. The
  merge-base diff defines required changed-file coverage; historical blobs are read when useful.
  Mandatory repeated diff/base/head injection is retained only for historical checkpoints.
- New snapshot-only investigations can finish in one model call when their scope, questions,
  limitations, and required rechecks are satisfied. A repeated blocker is not additional work.
- Every actual model invocation has an independent usage receipt, including rejected output,
  cancellation, failure, and recovery. Known input/output/cache/reasoning details are retained;
  missing provider detail is not zero. Reports keep a sealed usage snapshot, while Task totals
  and comments can reflect later trusted receipts.
- Static capacity is configurable. Execution tasks share one global E2E slot and one machine
  desktop guard. The E2E slot is held until cleanup confirmation; static work can run alongside it.
- A configured trusted user's PR mention command creates an independent E2E Task and comment.
  Duplicate delivery and active same-revision commands do not start duplicate desktop work.
- E2E uses pinned builds, registered feature assertions, owned application/window observations,
  and per-feature media. Its prompt allows runtime work; the static prompt prohibits it.
- Dashboard and comments show usage and useful progress. Heartbeat, activity, meaningful progress,
  model calls, accepted rounds, and saved-state versions have separate meanings. Recorded stage
  durations expose source preparation and other work outside the model call.
- Superseded unsent comment deliveries display Cancelled. Historical sealed records and confirmed
  external comment identities remain unchanged.

## Recovery boundaries

An E2E execution start is durable before runtime side effects. Partial observations are uploaded
and saved during execution. Recovery can deliver already accepted results without launching
another model or application. An interrupted incomplete E2E execution requires a new explicit
Task to run again.

The native ProcessHost proves that its prior owned generation has stopped before its successor
is ready. A retained old Job Object is not reused after termination: the successor waits for a
fresh object or fails closed. Destructive cleanup operations run through the managed helper.
The durable cleanup journal retains original ownership and separates local cleanup from the
Server acknowledgement. Retrying a lost acknowledgement does not repeat deletion or guard release.

This is ownership recovery for managed process trees. It does not prove the absence of arbitrary
service-broker or externally detached processes. An unproved process or desktop state remains a
visible cleanup blocker and requires the documented operator confirmation.

## Verification record

All execution checks below ran in the designated remote Windows environment. Earlier unsuccessful
receipts remain available as history; fixes are not described as passed until reverified.

| Gate | Observed result | Boundary |
| --- | --- | --- |
| Native recovery group, full native suite, vet, and build | Passed | Includes retained old Job handles, process-tree drain, fresh-object detection, and timeout without readiness. |
| Native process and owned-workspace recovery | Passed | Real owned processes and production cleanup helper; deliberately stops before a synthetic Server acknowledgement boundary. |
| Production HTTP/SQLite cleanup recovery | Passed | Synthetic Tasks and real owned processes; original lease acknowledgement releases the slot, and replay cannot release the successor's slot. |
| Lost cleanup acknowledgement and disk reload | Passed | Same journal first waits for acknowledgement, then retries through real HTTP. Workspace cleanup and guard release each remain single operations. |
| Shared, Server, Worker, and Dashboard builds/type checks | Passed | Coherent v5 builds plus final focused Worker and style overlays; final Server/Worker builds passed. |
| Server investigation integration suite | 1,400 passed | All 41 files; upstream interactions are mocked. |
| Domain full suite | Passed | Deterministic state, coverage, recheck, and accounting behavior. |
| Contracts full suite and focused replay | 1,752 cases covered | The native TypeScript/source-boundary case initially exceeded five seconds. All nine cases in that file then passed; the heavy integration case now has an explicit 60-second limit and passed under the default test invocation. |
| Worker full suite and focused replay | 3,302 cases covered; 44 existing optional skips | The initial old broker fixture failure was fixed by explicitly selecting historical semantics. Its original assertions and the E2E runner tests passed; no production navigation rule was weakened. |
| Dashboard full suite | 3,912 passed | All 136 files; default tests use simulated transports and rendering. |
| Final lint and focused overlays | Passed | Full lint exited successfully with warnings retained. Focused media-publication, model-runner, E2E-runner, and source-boundary checks passed. |
| v9 real-failure regression gates | Passed | Server 69, Worker 425, and Contracts 108 focused cases, plus applicable builds, type checks, and lint. An initially incorrect completed-scope test fixture was corrected without relaxing the zero-invocation proof. |
| v10 and v11 diagnostic/publication gates | Passed | Managed output/build diagnostics passed 120 focused cases; the following error-priority and E2E recovery wording changes passed 221 Server template and 105 Worker build cases, plus applicable build/type/lint gates. |
| v12 Windows environment gates | Passed | 70 focused configuration cases plus Worker build, type, and lint checks. Standard Windows environment names containing parentheses retain their native meaning. |
| v13 generated-hardlink gates | Passed | 428 focused cases plus applicable build, type, and lint checks. Generated internal link groups require a complete owned-tree census; external groups, tracked source, control files, and artifacts remain restricted. |
| Real NTFS hardlink cleanup | Passed | Production cleanup removed ordinary and read-only closed internal groups. An incomplete group was rejected while its external read-only sentinel's bytes and metadata remained unchanged. No permission-change fallback was used. |
| v14 compiler-summary gates | Passed | 105 focused build cases plus Worker type, build, lint, and private helper syntax checks. Unchanged shared, Server, and Dashboard assets were copied only after source and asset digest checks. |
| v15 native compiler concurrency gates | Passed | 105 focused build cases plus Worker type, build, lint, and private helper syntax checks. The controlled build explicitly sets `CL_MPCount=1`. |
| v16 incomplete-result presentation gates | Passed | 427 focused cases: Contracts 15, Worker 77, Server 331, Dashboard 4. A new fixture required its original dangling reference and missing observation artifact to be corrected; production validation was retained. Fresh affected builds, type checks, and lint passed. |
| Real controlled Peek build | Passed build and output validation | The fixed PR head compiled successfully with the original memory limit, and the production builder verified its required output. This is not UI or feature verification. |
| Real controlled Launcher build | Passed build and output validation | The production builder sealed 1,370 output files and verified the Launcher executable and UnitConverter plugin for the fixed PR head. This is not UI or feature verification. |
| Real static review | Passed for two small PR fixtures | Both completed in one invocation and one accepted round. The formerly blocked previewer review independently discovered and read the unchanged cleanup helper. Observed commands performed source inspection only. |
| Real usage and Dashboard projection | Passed for the two static Tasks | Task ledger, sealed reports, actual comments, and the remote browser showed matching totals and provider-reported details. The combined total was 647,045 tokens. |
| Live resumed-Task usage correction | Passed | The current E2E Task exposes complete usage, and one native Sync updated its existing comment. Two attempts, one invocation, the blocked outcome, and the original sealed report digest remained unchanged. |
| Real scheduling overlap | Passed for the observed runs | The second E2E lease was acquired nine milliseconds after the first was released following cleanup. Two static model sessions overlapped one E2E model session for about 111 seconds. This does not establish successful UI execution. |
| Real E2E execution | Partial, not a functional pass | The new Peek Task built and launched its pinned application, recorded seven assertions, and retained PNG and MP4 evidence. Two assertions passed, four failed, and one was blocked; cross-file disposal was not exercised. |
| Real E2E media publication and playback | Passed | The exact independent Peek comment rendered its uploaded PNG and native video; both also loaded and played in the authenticated Dashboard. This video documents an unsuccessful loading state, not a functional pass. |
| Real Launcher feature evidence | One feature passed; three did not | The `sqmi` target-operand scenario produced `1 mi²` in the actual result control. Its independently published video played, and a later frame showed the result. The other scenarios retained one failed and two blocked outcomes. |
| Recorded-result recovery | Passed for both new E2E Tasks | Native budget-increase resumes adopted saved results without another model or desktop execution. The original provider invocation counts and reported usage remained unchanged. |
| Cancellation with an owned application open | Passed | Two native identity checks observed the actual Peek window before cancellation. The Task became Cancelled, the process exited, and production cleanup removed its workspace and released the desktop guard. |
| E2E admission after cancellation | Passed | The queued recorded-result recovery obtained the next lease 1.171 seconds after cleanup confirmation released the cancelled attempt's lease. |

The static command trace captured 39 completed commands and both model exits. Ten commands
redact Git revision or object arguments, so the trace proves the observed command structure
but does not reconstruct every original argument byte. Actual static and E2E publication
used distinct recorded comment IDs.

Real E2E execution exposed two corrected code paths: build-project validation rejected a
Windows checkout with LF blobs and CRLF working files, and a resumed Task lost available usage
breakdowns in its aggregate projection despite retaining a complete invocation receipt. Focused
regression gates pass. A production build preflight passed the former source-identity blocker,
then compilation exited unsuccessfully after package restore. The managed error preview retained
the beginning of the output and lost the actual final error. The bounded diagnostic-tail correction
passed its focused gates and exposed concrete Windows environment and path-length failures.
The subsequent target-specific builds and live usage correction passed the checks recorded above.
Unsuccessful historical receipts remain unchanged.

The explicit toolchain environment now includes the normal Windows discovery paths and a bounded
vcpkg concurrency setting. A real build located the installed compiler and installed two helper
packages, then stopped during a native dependency's CMake configuration because the private
preflight workspace path exceeded compiler limits. Its generated package files also exposed an
overly broad rejection of ordinary internal NTFS hardlinks during cleanup. The correction requires
every member of such a group to remain inside the owned workspace, rechecks identity before each
unlink, and never changes shared file permissions. Focused tests and a separate real NTFS
fixture passed. One recovery of the retained build workspace then completed in 247 seconds,
confirmed its absence and owned Host exit, and preserved the original failed result bytes.
Subsequent preflights used the same source-path depth intended for the live Worker.

That compact preflight reached additional project compilation, but the first target still exited
unsuccessfully. Its retained output contained only later successful project messages, so the
underlying compiler error cannot be inferred from that receipt. The second target also exited
unsuccessfully; both workspaces were cleaned and their Host stopped. The diagnostic refinement
keeps minimal verbosity and explicitly requests MSBuild's final error summary, with the existing
output budget. Its focused gates passed. The follow-up real build is limited to the first target.

The final summary exposed C3859 precompiled-header memory allocation failures in the native
interop project. The focused change sets `CL_MPCount=1`, because one MSBuild node does not
limit that project's enabled multi-process compilation. The following real Peek build and
production output validation succeeded with the existing process-memory limit. No process or
tlog observation was retained to establish the actual compiler count or executable path.
Post-failure machine memory readings are not treated as measurements of the failure-time peak.
The separate Launcher target also passed the production build and output validation. Both results
remain prerequisites for application verification, not evidence of successful feature behavior.

The private preflight's two-minute workspace cleanup deadline also expired. The production cleanup
uses its configured process deadline. Recovery of the exact retained preflight workspace uses the
original ownership receipt and native process-drain proof; no production ownership checks are relaxed.
That single recovery completed in 228 seconds, confirmed workspace absence and owned Host exit,
and preserved the original failed result bytes.

The E2E prompt and response schema now agree on prerequisite failure: the agent can return an
empty feature list with a precise explanation, and the Worker records uncovered changes as
not run. It cannot report success or invent a harness to satisfy a nonempty response constraint.

Two additional real Issue investigations each completed in one invocation. Across all six Tasks,
reported usage was 1,662,769 tokens after the initial E2E attempts ended; active and unknown
invocation counts were zero. Both E2E Tasks were blocked before actual application testing.
One real GitHub redelivery received an external 401 before reaching the local receiver, so it
does not establish end-to-end redelivery idempotence. Preserve that limitation separately from
the successfully received duplicate-command and simulated idempotence checks.

The subsequent Peek execution stopped at its configured two-million-token limit after recording
its execution result but before adopting the final analysis. It reported 2,218,084 tokens:
2,198,602 input and 19,482 output, including 2,099,779 cached input tokens. Its observed operations
included one build, one launch, assertions, screenshot capture, recording, and cleanup; this was
not repeated frozen-source investigation. The recorded application remained loading, and the
attempted navigation did not establish the changed disposal behavior. The failed assertions do
not by themselves attribute a regression to the PR.

The incomplete report also exposed a presentation bug: it retained the initial "Investigation
has not started." summary despite saved execution evidence. The pending correction derives a
truthful current summary from that evidence while preserving the interrupted outcome, partial
coverage, usage, and immutable historical report. Native budget-increase recovery is intended
to adopt the already recorded result without another model or desktop execution.

The first application-open cancellation observer stopped on a process-identity mismatch before
sending a cancellation request. This does not count as a cancellation test. A separate read-only
comparison on an owned long-lived process found that the Windows module path was unavailable
through .NET while the native process-image API returned it. The revised observer uses the same
strict native time and image identity APIs as production; the original application's exited
process cannot retrospectively establish which field failed in that earlier observation.

The subsequent Launcher invocation also stopped with an incomplete Task after real UI operations.
It registered four feature scenarios and recorded four videos. Two additional builds of existing
repository tests failed with distinct dependency and CsWinRT compiler errors; those tests do not
count as executed validation. The invocation reported 3,887,011 tokens, including 3,730,793 cached
input tokens. At that observation, the eight Tasks had reported 7,767,864 tokens in total, with no
active or unknown invocations. Both recorded-result recoveries subsequently completed without
increasing those invocation totals. The Launcher result remains failed overall: one feature passed,
one failed, and two were blocked. A failed selector that returned the literal label `Title` is not
treated as proof of a product regression; the blocked scenarios had no matching result row.

The Peek comment contains its independently uploaded image and video, with matching upload receipts
and token details. A real browser confirmed image loading and video playback in both that exact
GitHub comment and the authenticated Dashboard report. GitHub renders canonical attachment URLs
as signed media URLs; the inspection bound their complete uploaded identity without retaining
temporary signatures. The Launcher comment's successful feature video was independently played
and inspected later in the recording, where the actual result control displayed `1 mi²`.

The presentation change adds bounded feature and assertion summaries to the actual partial-result
progress-comment path, where a generic stop reason previously hid recorded results. It leaves the
complete-report publishing gate and prepared historical comment bodies unchanged.

The final cancellation case opened an application built from the pinned Peek revision. Two native
observations verified the same process creation time, executable digest, and visible window before
the one cancellation request. The Task became Cancelled and the application exited. Workspace
cleanup then took about 315 seconds; the queued E2E recovery remained waiting throughout it and
acquired the next lease only after cleanup confirmation. It reused recorded results without a new
model call or application launch.

Across the nine Tasks, reported usage remains 7,767,864 tokens. The cancelled invocation returned
no final provider counters, so one terminal invocation has unknown usage. This is a known subtotal,
not a complete overall total or a claim that cancellation cost zero. The invocation's terminal
receipt and acknowledgement are distinct from the missing provider counters.

## Final handoff

Functional failures and environment limitations above remain recorded. They do not invalidate
the verified publication, accounting, recovery, and cancellation behavior, and they are not relabeled
as successful product tests. The external redelivery limitation also remains separate from the
verified duplicate-command handling.

Operational closeout is complete. The retained Server and Dashboard use the same application and
account databases and verified assets, with external writes, media uploads, webhook intake, and
Worker authentication disabled. Worker, Monitor, and the GitHub forwarder exited normally. The
owned temporary hook and publisher credential copy were removed, and test assignment changes
were restored. An independent TCP relay preserves Dashboard access without GitHub credentials.

A real browser successfully logged in after the switch, read all nine Tasks and their report and
media history, and displayed Cancelled on both the cancelled Task and its report. Repository
intake and both publication settings remained disabled. This is retained Dashboard access with
automatic execution stopped; it does not make every authenticated Dashboard API read-only.

Original CLI authentication, account data, immutable reports, and failed verification receipts
remain preserved. Re-enabling execution requires deliberately restoring the appropriate runtime
configuration for the authorized work. No upstream repository was modified.
