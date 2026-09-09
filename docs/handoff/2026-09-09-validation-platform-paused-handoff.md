# Validation platform paused handoff

Date: 2026-09-09. Status: paused at the user's request; the full platform objective is incomplete.

## Stop point and authority

When asked to select the Windows environment for real model Evaluation, the user requested a
handoff and deferred further work. Implementation, new tests, model execution and environment
configuration are paused. Resume them only after a further user instruction. No Windows VM or
local-machine deployment choice was made. The latest native reproduction had already finished
before the pause; its failure was inspected for this handoff. No production fix followed it.

Workspace: `D:\Code\PowerToys-Agentic-Review`. Branch: `codex/architecture-remediation`.
Observed HEAD: `896dbaffbd6c95094e0b953bcb9f2f72ea68e2b0`.
At this stop point, several platform source files, including the Windows driver, its tests and UI
contracts, were untracked. The working tree contained the implementation; the observed HEAD or
`git diff` alone was insufficient to transfer it. No commit, push, reset, revert or shared-checkout
cleanup had been performed at that point. Subsequent Git publication does not complete the paused
UI or model work. Evidence references under `artifacts/` refer to retained local files, which are
excluded from the source publication together with runtime data and private configuration.

Carry these constraints into resumed work:

- User-facing communication is Chinese; authored code, comments and documentation are English.
  Use Windows PowerShell syntax for local commands.
- This thread previously received explicit permission for local Worker/native/frontend checks
  and `test-env`. The current pause overrides further execution. A new task must follow its own
  current verification authorization; this document does not grant new permission.
- Server, SQLite, storage and runtime acceptance run on Linux `ssh test-env`, not Windows.
- Never access, enumerate or inspect metadata beneath `apps/worker/.tmp-ui-driver-V7AOfu/`.
  Use explicit source/test paths and the existing exclusion-aware capture helper.
- Do not inspect actual provider profiles, credentials, private runtime JSON or existing sandbox
  password blobs. Synthetic fixture authentication must be newly generated, used only internally
  by its scoped client, and never printed. Do not reuse the closed fixture's private files.
- No real PR/Issue writes are authorized. This includes comments, reviews, labels, assignments,
  review requests, closing/reopening and merging, through APIs, scripts, models or browsers.
  See [AGENTS.md](../../AGENTS.md). Isolated synthetic database mutations are a separate scope.
- Machine accounts, firewall/registry changes, sandbox setup and VM provisioning were not approved.
- Preserve original failures and immutable execution records. Never change a failed result to
  passing, restart because an observation timed out, or remove existing artifacts to rerun a script.
- Build the Dashboard in a fresh isolated directory; do not clean or build over the live Umi preview.

## Product state

The accepted functional scope remains the [platform roadmap](../design/2026-09-06-validation-platform-roadmap.md).
The [implementation ledger](2026-09-07-validation-platform-implementation.md) contains incremental
history; its older sections are historical records, not a replacement for this current stop point.

| Requirement | Implemented or accepted | Remaining boundary |
| --- | --- | --- |
| Multiple repositories | Stable repository identities, management, scoped reads, grants, configuration audit and scheduling policies | Private checkout authentication and intended deployment configuration |
| Separate PR and Issue workspaces | Separate Dashboard workflows and Run/result projections | Deployment acceptance with the intended repositories and operators |
| Separate static/build and UI processing | Independently frozen profiles, jobs, checks, evidence and policy coverage | Real Windows application UI acceptance remains incomplete |
| Windows and Web UI | Windows native driver exists; a real Web positive/negative scenario and its evidence were accepted in M26 | Windows failure described below; wider repository/toolchain coverage |
| Prompt management | Drafts, immutable published versions, previews and repository bindings | Real model execution and Prompt/Profile Evaluation acceptance |
| Results and decisions | Checks, findings, source freshness, evidence, model advice and human decisions are separate facts | Actual model-generated advice has not completed the new execution-boundary acceptance |
| Issue validation | M33 reproduced the real public `fishjar/kiss-translator` Issue #1064 timing claim through Worker, Server and Dashboard | That single case does not establish every Issue, extension or UI workflow |
| Evaluation | Sample sets, frozen batches, result/evidence reads, adjudication, scoring and assessment workflows are integrated | Actual Worker/model Evaluation execution remains disabled and unaccepted |
| Deployment | Isolated connected cases and a populated schema-27 to schema-33 upgrade were accepted | Actual OIDC, intended multi-user use and persistent-storage operational acceptance |

Private repositories in the first release and build-artifact reuse between static and UI jobs
remain scope/implementation decisions. Current UI profiles build their own exact source.
Publication previews/outbox and notifications have isolated acceptance; no live GitHub publication
was approved or performed. Functional work takes priority over another visual redesign.

## Latest implementation: compound Windows locators

Actual Notepad++ metadata inspection collected 79 nodes. A toolbar Button and a MenuItem both
expose automation ID `Item 41001`; the Button's Name is empty. The former ID-only locator could
not select New uniquely. The shared contract and native driver now support this additive form:

```json
{ "by": "automationId", "automationId": "Item 41001", "controlType": "Button" }
```

The optional control type uses the existing finite whitelist. Native lookup combines the ID and
type with an AND condition. Old payloads remain valid; ambiguous matches and unsupported fields
remain rejected. Relevant files are:

- [UI contracts](../../packages/contracts/src/ui-scenarios.ts) and their adjacent tests.
- [Native driver](../../apps/worker/src/ui/windows-driver-entry.ps1).
- [Driver tests](../../apps/worker/src/ui/windows-driver.test.ts) and
  [native fixture](../../apps/worker/src/ui/testdata/windows-fixture.ps1).

The compound-locator increment passed 107 contract/configuration tests, 60 driver tests including
real native fixtures, 616 selected Linux Server/shared tests, Worker type checking, a fresh Worker
build and an isolated production Dashboard build. Those counts precede the newly added failing
reproduction below. See [the preparation receipt](../../artifacts/m34-windows-acceptance-20260909/verification/locator-integration-ready.json).

## Current failing reproduction: transient descendants

The latest executed test selected only:

`Windows UI Automation native fixtures keeps a persistent launcher usable when metadata siblings exit during readiness`

It failed in approximately 12.2 seconds: the old production driver returned `blocked` with
`reasonCode: ownership_lost`, incomplete evidence and all four steps `not_run`. The test expected
a persistent launcher and healthy GUI to complete actual fill, click and assertion operations.
Its explicit launcher cleanup completed without replacing the original assertion failure.

The fixture starts up to 64 short-lived, owned metadata children at 75 ms intervals and delays
the GUI by 6.5 seconds. Child handles are retained and cleanup is bounded. The failure is now
demonstrated by a real native test, not just inferred from the Notepad++ execution.

Latest report: [windows-transient-before-v1.json](../../artifacts/m34-windows-acceptance-20260909/verification/windows-transient-before-v1.json).
It records **0 passed, 1 failed, 60 not selected**. Its SHA-256 is
`7f032782db855353a267e867e1264ad799e118a712cf44b54d945f3017a29fa0`.
The production driver is still the pre-fix version. Do not remove or weaken this regression to
restore a green report.

| Current file | SHA-256 at pause |
| --- | --- |
| `apps/worker/src/ui/windows-driver-entry.ps1` | `e984eeed0b8220b1a832b40533488677f367503b28a4536481ee28870be000e5` |
| `apps/worker/src/ui/windows-driver.test.ts` | `829ee894bd00027d5f6df345da02d8f52985e9ac321e9ae1c756e76afad3db01` |
| `apps/worker/src/ui/testdata/windows-fixture.ps1` | `a9a7b71b1bdb26d2d27841aae99d3e358ff635c51e99421f6bca0b689999ae14` |

`RefreshOwnedProcesses` currently fails the whole refresh if any discovered descendant cannot
be opened, exits, loses its parent or disappears before the second snapshot. `FindWindow(false)`
refreshes this set repeatedly during readiness. Consequently, an unrelated metadata sibling can
block a healthy target before any window or UI operation is selected.

## Reviewed correction, not implemented

Two independent reviews converged on the following bounded approach:

1. Protect the root and, after selection, the pinned window owner's complete chain of already-held
   process identities back to the root. A missing record, cycle, dead identity or invalid chain
   fails. A previously pinned owner must never fall back to an unpinned/root-only mode.
2. Use the first parent snapshot to discover candidates reachable from the root. Retain successful
   handles, creation FILETIMEs and parent identities. Do not replace a retired PID's held identity;
   retain the existing identity budget. Unprovable non-required candidates are ineligible.
3. Use a second snapshot to confirm both parent edges, held identity liveness, session and creation
   order. Admit a child only while its confirmed parent is still alive. An excluded parent also
   excludes its descendants; do not adopt an orphan.
4. Before publishing `live`, prune the entire candidate set again by current liveness and root
   reachability, then recheck every required identity. Checking only the required chain at the end
   is insufficient: an unrelated confirmed parent can die while its child remains in the set.
5. Replace the live set only after confirmation. Preserve root FILETIME checks, exact pinned-window
   identity, UIA ancestry, unique matching and the watchdog. The TCP probe shares this function;
   its second refresh must also protect the previously selected listener and its held ancestor chain.

The negative example from review is `R -> A -> B`: accepting A and then letting A die must not
leave B eligible merely because A was previously in a set. UIA ancestry checks do not substitute
for the OS parent chain. Existing same-PID/TID HWND-reuse limits are not solved by this change and
must not be presented as solved.

After resumption, retain the failing readiness test, add a helper-exit case after window pinning,
and preserve rejection when the pinned owner or an intermediate ancestor dies. Retain root/PID
mismatch, unrelated same-title window, duplicate locator, stable descendant and TCP-owner cases.
Where necessary, add deterministic internal snapshot-convergence tests without exposing a fake
process-tree input through the production driver protocol.

## Real Notepad++ execution retained

The [first-run report](../../artifacts/m34-windows-acceptance-20260909/FIRST-RUN.md) records the real
production WorkerService execution. Official source commit
`2f50e44ffe9aa607a0e50e1f2ab143e0daed1391` was fetched and built Release/x64 in its disposable
checkout. MSBuild exited zero and the original source remained unchanged. The persistent launch
wrapper began, but GUI readiness was blocked by ownership validation. No successful UI interaction
or screenshot is claimed. The deliberately failing second case was never activated.

| Identity | Value |
| --- | --- |
| Fixture | `3c046fdc-feb6-484d-ba17-736f9b625079` |
| Run | `52416135-1cbf-4338-9736-8432d99b2f53` |
| Job | `19c75dea-1ef9-4de6-9ba0-50171b6e0a80` |
| Attempt | `7f55337b-26b6-4c5b-a5c2-dc002baeec31` |
| Result digest | `119cbdf09500f8801280c30eb50db8f0c2f56b89c6ec3af6a923877d15a2cc43` |

The Job is `succeeded` because its typed terminal result was accepted; the UI check is `blocked`
and evidence is incomplete. Its single finalized steps asset has all six steps `not_run`.
The client correctly rejected acceptance after the Server stored the result; its local terminal
array remained empty because the observer failed before appending. The independent
[Server snapshot](../../artifacts/m34-windows-acceptance-20260909/first-run-server-status.json)
is authoritative. Do not infer that no result exists from that empty client array.

The repository source is real; Issue metadata, assignment authority, operators and credentials
are explicitly synthetic. No upstream repository mutation or model invocation occurred.

## Artifacts and runtime closure

Primary artifact directory: `artifacts/m34-windows-acceptance-20260909/`.
Windows execution root: `D:\AR\m34ui-0909-v1`.
The `public` subdirectory retains client parameters, helper inputs, lifecycle logs and results.
The old driver/runtime and reviewed Notepad++ build/launch helpers remain in its `tools` directory.
The shared desktop lock directory is `D:\AR\SharedDesktopLocks`; do not substitute an attempt-local
directory to bypass another Worker's lock.

The M34 Worker, Host, attempt workspace, desktop lease, Server and SSH forward were closed. The
new fixture credential was revoked. The [Server closure](../../artifacts/m34-windows-acceptance-20260909/first-fixture-server-stopped.json)
is clean with unchanged source/specification/Dashboard/configuration and
`bothCaseEvidenceVerified: false`. The latest standalone reproduction command also finished.
There is no M34 execution handle to resume:

- Worker parent session `84863`: terminal exit 1, reflecting failed acceptance.
- Server session `86329`: terminal exit 0 after explicit stop.
- Forward session `39757`: terminal exit 1 after intentional Ctrl-C.
- Latest standalone native reproduction session `63550`: terminal exit 1 for the recorded assertion.

The later PID inventory found former Git PID `59640` reused by `WmiApSrv`; its start time was
unavailable. No action was taken against that unrelated service. Use held-process exit evidence
and the closed Host, not a claim that every old PID number must remain unused. Port 3286 was
observed without a local or remote listener. Other project previews were not part of this closure.

Retained Linux paths:

- Data: `/dev/shm/m34-windows-ui-822cbbdc4f734d3f813ab22afde34110`.
- Fixture package: `/dev/shm/m34-windows-package-822cbbdc4f734d3f813ab22afde34110`.
- Dashboard: `/dev/shm/m34-windows-dashboard-822cbbdc4f734d3f813ab22afde34110`.
- Compiled source: `/dev/shm/agentic-review-platform-m34-20260909-windows-locator`.

These are tmpfs artifacts and may disappear after a host restart. Durable local execution records
are linked above. Do not read or copy the retained private configuration/credential files.

## Resume sequence after authorization

1. Read this document, the current source and the failing native report. Confirm the user's resumed
   scope and test authorization. Preserve all previous results and exclusions.
2. Implement and review the ancestry correction, then run the focused reproduction and relevant
   native negative cases. Run the full Windows driver file after the change. The existing
   `verification/vitest.windows.config.mts` roots discovery inside `apps/worker/src`, avoiding the
   forbidden temporary directory. Use a new owned `TEMP/TMP` and a new report filename.
3. Capture the updated source and build fresh Worker/native assets. The earlier `a7aadadd...`
   1,119-file capture predates the new failing test and this handoff; do not claim the current tree
   matches it. Existing prepared client pins must be regenerated for the resumed execution.
4. Prepare a new fixture and Windows execution root with new credentials and immutable Runs. Check
   every hardcoded root/path/hash in `worker-tools/`, `fixture/` and `client/`; do not rerun exclusive
   output scripts against old files or reuse a finished Server instance.
5. For Linux staging, do not copy incremental TypeScript cache state and assume missing `dist`
   outputs will regenerate. The first M34 staging attempt made that mistake; `tsc -b --force`
   for contracts, domain, codex and Server corrected it. Retain failures and bind verification to
   the actual new source. Choose checks appropriate to the resulting code change.
6. The corrected parent is `client/launch-v2.mjs`. It fixes a reviewed gap by binding the launched
   harness to the fixed `client.mjs` path and its verified pin; the original launcher and prepared
   hashes remain intact. Carry this guard into any newly prepared client.
7. Finish public tool/client preparation before starting the 45-minute fixture Server. The client
   permits 35 minutes of execution plus three minutes of cleanup and requires at least 39 minutes
   remaining on the Server at startup. Keep the account-wide desktop lease and production ownership
   checks active.
8. Run the real Worker source checkout/build/UI positive case, independently verify actual evidence,
   then activate the deliberate negative case. A failed UI assertion must remain failed. Verify
   screenshots, step order, source identity, immutable history and all cleanup. Finally inspect both
   results and evidence through the real Dashboard and close the temporary services.

Pinned local Node: `C:\Users\moooyo\.cache\agentic-review-toolchain\node-v24.20.0-win-x64\node.exe`.
Linux Node: `/root/.cache/agentic-review-toolchain/node-v24.20.0-linux-x64/bin/node`.
The native Host used for M34 has SHA-256
`f8dc79466770e9630e18ae9e0be826d044178b686157b528db2a5743642c07f6`.

## Deferred model and deployment work

The [Windows model lifecycle proposal](../design/2026-09-09-windows-model-execution-lifecycle.md)
is `proposed_not_accepted`, not an implemented execution boundary. Runtime composition, relay,
invocation and frozen-summary plumbing exist, but Profile commands still use ordinary process
launches. Per-attempt identities/credential leases, enforcement, independent execution-acceptance
evidence and a compatible native or VM adapter are not implemented and accepted.

Evaluation capability remains absent, Worker Evaluation execution is rejected, and execution
acceptance observations remain false. Do not turn those gates into configuration booleans or
equate sandbox setup/readiness with actual enforcement. The real fresh-home probe returned
`updateRequired`; no sandbox setup was authorized. The user deferred the Windows environment
decision, so do not provision one or request/use real model credentials during this pause.

Actual deployment OIDC, multi-user and persistent-storage acceptance also remains. The real
Issue milestone is already complete for its frozen claim; see
[M33 acceptance](../design/2026-09-09-real-issue-acceptance.md). Resume the outstanding work from
current evidence without repeating completed milestones or shrinking the original product scope.
