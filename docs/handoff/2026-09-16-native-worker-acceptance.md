# Native Windows investigation verification, 2026-09-16

## Current handoff state

Synthetic acceptance of the actual Windows Server and Worker entries is complete for its recorded
scope. Evidence retention, quotas, current availability, and inherited patch lineage are implemented.
The real model's five-round investigation and subsequent native recovery on the same task now
have a complete sealed report. The user subsequently approved the exact two-comment publication
scope, and both native intents succeeded on the existing owned-fork fixtures. That one-run
authorization is consumed; source/UI and production-operation boundaries remain separate.

Real-model acceptance combines the original CLI investigation with checkpoint-based report recovery.
It is not a claim that one uninterrupted attempt passed from start to finish. Original failed
receipts remain intact, and source execution, real reproduction, and UI behavior were not exercised.

## Implemented changes

- Evidence storage now reserves resident byte/count quotas atomically, preserves immutable report
  identities, and expires content through bounded metadata scans. Active or resumable work and
  required ancestor patch sources retain their content. The initialization schema is
  `investigation-v2`; incompatible databases are rejected without conversion or deletion.
- `GET /api/artifacts/:id` exposes current availability independently of the report snapshot.
  Expired or missing content returns HTTP 410. The Dashboard refreshes current metadata and
  rechecks it before download, preserving session and repository authorization boundaries.
- Tasks and report contexts retain inherited patch metadata in `sourceArtifacts`, with the
  original producer task and attempt. Inherited inputs never become the child task's execution
  evidence. Cross-generation reads require the exact saved parent lineage and authorized subject.
- Codex static analysis and edit proposals use `--skip-git-repo-check` for the Worker-owned
  non-repository model-input directory. Read-only sandboxing and disabled model tools remain.
- Model instructions distinguish subject IDs from evidence references, explain leaf evidence,
  preserve frozen coverage and version rules, and keep snapshot-only analysis within supplied
  material. References to new plan drafts use an explicit provisional digest that trusted code
  replaces. The later completion-contract alignment and report projections are described below;
  saved-action authorization and execution binding remain separately enforced.
- The opt-in [acceptance harness](../../deploy/investigation-acceptance/README.md) runs the actual
  Server and Worker entry points and records source and runtime manifests separately. Its real-CLI
  companion accepts an explicit Worker executable path for CLI-owned authentication helpers.
- [Architecture](../../ARCHITECTURE.md), the application instructions, and the Server configuration
  template now describe the native runtime, built-in accounts, evidence defaults, and source
  lineage. Evidence defaults are 30 days, 1 GiB of resident original content, and 10,000 resident
  artifacts, with a bounded 100-record cleanup pass every 60 seconds. Logical quota release does
  not imply physical SQLite/WAL shrinkage.

## Verified software scope

The declared base revision is `2d0c36ef3627143e4ac546197bb761c74674af9f`; it is not a claim that the
executed source exactly equals that commit. The source and runtime manifests identify the actual
deployed snapshots and build outputs, including this delivery's changes.
The following package scopes include the final completion-contract and report-projection regression
runs. Codex and Dashboard retain their existing receipts because their verified production scope
did not change during that correction. All verification ran on the project-designated remote Windows
worker or the designated Linux environment for Linux-specific scope. No local test, build
verification, or runtime probe was used. Exact infrastructure receipts and deployment details
remain outside the repository.

| Package | Environment | Passed | Skipped | Failed |
| --- | --- | ---: | ---: | ---: |
| Contracts | Windows | 1,690 | 0 | 0 |
| Domain | Windows | 346 | 0 | 0 |
| Codex | Windows | 222 | 0 | 0 |
| Server | Linux | 6,035 | 1 | 0 |
| Worker | Windows | 2,523 | 44 | 0 |
| Dashboard | Windows | 3,746 | 0 | 0 |

These package scopes total **14,562 passes and 45 skips**, without counting overlapping reruns.
Contracts passed 42 files, Domain passed 13 files, and the complete Linux Server run passed all
174 files with its one existing Windows-specific skip. The Server's active investigation directory
separately passed 295 tests in 15 files on both Windows and Linux with no skips or failures.
Those overlapping active-directory runs are not added to the package total.

An attempted full historical Server-suite run on Windows retained 151 failures in
Linux-specific database/evidence paths. It was not an accepted Windows full-suite run, and those
Linux-specific boundaries were not weakened.

The affected Windows type checks and shared, Server, Worker, and Dashboard builds passed.
ProcessHost was built natively. The final 13-source-file Biome pass reported zero errors and
125 warnings, with one file formatted and no unsafe fixes applied. The earlier 39-file pass with
99 warnings retains its separate scope; those warnings are not added to the final count. Two Worker
test type-checking defects exposed during the correction were fixed before the passing check.
Earlier installation, script-runner, model, and type-checking failures remain in their original
receipts rather than being rewritten as passes. This handoff does not claim a new whole-project
CI result for the latest working tree.

## Synthetic native lifecycle acceptance

The synthetic CLI exercise passed the production password-account setup and explicit permissions,
two consecutive tasks on one Worker, cancellation after a checkpoint, graceful Worker/Server
shutdown, database reopen, Worker restart, and checkpoint continuation into a new attempt.

Completed reports retained 137 findings with 137 final rechecks. Exports were approximately
3.9 MB and pagination returned all findings in pages of 50, 50, and 37. Cancellation and
interruption preserved all 137 partial findings and immutable historical reports. Process
identity checks confirmed owned native descendants stopped, and the Worker cleaned its owned
attempt directories. The closed database retained 134 report parts and zero action intents.

The CLI and its reporter statements were explicitly synthetic. This exercise does not establish
real model behavior, source execution, runtime artifact upload, UI behavior, hard-crash orphan
recovery, SCM signal delivery, sustained production capacity, or Linux production deployment.
Shutdown used the documented private IPC bridge to the entry points' existing signal handlers.

## Real model investigation

The frozen read-only input is
[PowerToys Issue #50588](https://github.com/microsoft/PowerToys/issues/50588). Its complete captured
body and zero-comment conversation were retained with raw-input hashes. Source execution and
GitHub writes remain disabled.

Earlier failed attempts exposed the missing non-Git-directory CLI flag and an omitted Windows
PowerShell path for the user's CLI-owned authentication helper. Both original failures are retained.
A standalone bounded CLI probe confirmed the configured provider can return a response; that probe is not a complete
investigation acceptance. A later investigation failed reference validation after returning
schema-valid JSON that used subject IDs as evidence IDs. Another attempt reached its configured
ten-minute deadline. Those original failures remain partial and are not relabeled as successful
model runs.

Run 5 subsequently completed five accepted rounds and reached a checkpoint with
`stopReason: complete`. Report finalization then failed because a proposed `issue-verify`
next action referenced a saved reproduction plan, which is not a valid verification binding.
The complete analysis checkpoint was retained for recovery. The successful recovery below is a
separate native attempt and does not rewrite the initial finalization failure.

### Accepted completion-contract and report-delivery corrections

The approved [investigation design](../design/2026-09-15-structured-investigation-results-and-loop.md)
allows complete snapshot analysis to retain unresolved hypotheses with saved verification work.
The completion contract now follows that rule: an unresolved candidate can be supported
by an explicit limitation and a saved continuation plan for the same subject, without requiring
an executable action button. That plan must have a valid saved source in the current report or
exact parent report, use kind `investigation`, `verification`, or `reproduction`, and contain
nonempty steps and acceptance criteria. A plan records remaining work; it does not establish that
verification ran. Saved-action validation remains strict, including the required match between
the action's task kind and its bound plan kind.

The shared action projection separates valid saved next actions from invalid
model proposals. It leaves the accepted checkpoint unchanged, retains each rejected proposal as
complete canonical JSON with reason codes in an `INVALID_NEXT_ACTION_PROPOSAL` limitation diagnostic,
and saves only actions accepted by the action validator. An invalid `issue-verify` proposal is
not changed into a reproduction action, and the rejected proposal remains inspectable.

The retained model finding used `ordinal: 1`. Report construction now derives contiguous zero-based
display ordinals from the original ledger order. A trusted `FINDING_ORDINAL_NORMALIZED` diagnostic
preserves each changed finding's ID, version, original ordinal, and report ordinal. The finding ID,
version, body, and recheck bindings remain unchanged, and the projection does not mutate the accepted
checkpoint. The report finding object is therefore intentionally different in its display ordinal;
this is not a claim that the whole original object is byte-identical.

The Server independently recomputes the complete finding, action, and diagnostic projections from
the accepted checkpoint and saved plans before sealing the report. It then applies the full public
`validateInvestigationResult` semantic validation to the assembled result. These are deliberate
contract and validation changes, not merely prompt changes. They preserve strict saved-action
guards while making report presentation and unresolved-work handling explicit.

### Native same-task recovery acceptance

After the corrected code passed its remote checks and builds, the production Server and Worker
resumed task `2e067db8-6e14-4b52-83c2-4f9ba6d68090` using the existing investigation database.
The Server created attempt 2 and advanced checkpoint version 6 to version 7 for delivery adoption.
`stopReason` stayed `complete`; completed model rounds stayed **5 to 5**, with **zero new model
rounds and zero new model tokens**. Accepted analysis, runtime records, and consumed-budget values
were unchanged. The recovery updates checkpoint attempt/version metadata, so the entire checkpoint
envelope is not described as byte-identical across attempts.

The Server sealed report `aa4d1180-5473-4aaa-a8d9-b7bd19a244d7` as `complete`. Its **30,886-byte**
export retained the original one hypothesis finding and one reproduction plan. The invalid action
proposal remains in its non-executable diagnostic; the finding's display ordinal has its separate
normalization diagnostic. The report contains no executable next-action suggestions. Public report
semantic validation passed, including saved-plan support for the retained unresolved hypothesis.
The retained export's SHA-256 is
`7dcb97a83c740ef612cabe64dc8c58eacfc7dcf01458a07137c77e961b7df8df`.

Both Server and Worker exited with code 0. Owned process descendants and the owned attempt
directory were cleaned. The database retained zero ActionIntents, and external writes stayed
disabled. Run 5's original failed receipt was not modified. That original attempt had no export;
the recovery did not backfill one into its historical output.

The accepted sequence is real CLI investigation followed by native checkpoint recovery and report
delivery on the same task. It does not establish one uninterrupted successful attempt, actual
repository-source execution, runtime reproduction, UI acceptance, or correctness of the hypothesis.
The original model and failed-delivery receipts remain the record of those earlier outcomes.

## Approved native publication acceptance

The user explicitly approved run `investigation-publication-20260916-v1` against the immutable
[JSON draft](../../deploy/investigation-acceptance/publication-approval.json), SHA-256
`0671baa0f8a5c4b446dbadc3a8e4b7013cae1af04c490f6662bbdbf3f49ba936`. The original JSON bytes remain
unchanged; the original draft status is historical, while this section records the subsequent
approval and execution. This was new explicit authorization for the exact two-comment scope,
independent of historical M41 approval.

Native preparation ran from `2026-09-16T07:22:59Z` to `07:23:22Z` with no external writes. Execution
ran from `2026-09-16T07:24:12.437Z` to `07:24:53Z` and passed. The Server prepared and confirmed
the exact fixed comments through its production ActionIntent path; both intents ended `succeeded`.

| Target and comment | Conversation count | Native confirmations | Derived POST-attempt upper bound | New matching comments observed by GET |
| --- | --- | ---: | ---: | ---: |
| [PR #3 comment 5693633461](https://github.com/moooyo/PowerToys/pull/3#issuecomment-5693633461) | 0 to 1 | 1 | 1 | 1 |
| [Issue #5 comment 5693635709](https://github.com/moooyo/PowerToys/issues/5#issuecomment-5693635709) | 1 to 2 | 1 | 1 | 1 |

Independent GET readback matched the full fixed body plus native correlation marker, publisher
numeric ID `42196638`, and exact target. The single-mutation production transport combined with
one native confirmation per target provides the POST-attempt upper bound above. The harness had
no HTTP proxy and did not directly measure network POST counts. Neither result was unknown, and
native reconciliation was not invoked; these GET readbacks are not an unknown-delivery recovery
test. The Server exited with code 0.

Repository endpoints were restricted to `moooyo/PowerToys`, with the required `GET /user` identity
check separately allowed. Requests rejected redirects. This publication run made no request to
`microsoft/PowerToys` and introduced no additional repository mutation beyond the approved
comments. It added no product-code change or new full-suite result.

Cleanup at `2026-09-16T07:26:19Z` confirmed the temporary publisher credential was removed and
the owned Server was closed. Original CLI authentication remained untouched. The sanitized native
receipt is retained with SHA-256
`d991019800be08e9294c4f2752a65872741792087d417a573d04661cf31ef5d0`;
private infrastructure paths and credential material are not copied into this handoff.

The comments remain in place. The single-run budget is consumed and cannot authorize a rerun,
replacement intent, deletion, or other cleanup mutation. The
[approved scope and execution record](../../deploy/investigation-acceptance/publication-approval.md)
retains the fixed payload and operational limits. Other publication targets, source execution,
real reproduction, UI behavior, and production operations remain outside this acceptance.

## Remaining acceptance work

| Work | Required next evidence |
| --- | --- |
| Deployment operations | Establish any required production hosting, service/restart policy, account/session, real source/profile, or hard-crash behavior separately from the synthetic graceful lifecycle scope. |
| Operational capacity | Accept the intended sustained workload and physical SQLite/WAL storage growth under the implemented evidence policy. |

Dedicated PowerToys UI scenarios, third-party login, and general model-quality evaluation remain
outside the current delivery. The recorded model workflow establishes neither independent remote
model identity nor a quality benchmark. No new GitHub-write authority follows from implementation,
testing, or this handoff.
