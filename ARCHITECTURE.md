# Agentic Review Architecture

## Scope and production entry points

Agentic Review investigates GitHub pull requests and issues, retains complete structured reports,
and prepares explicit follow-up actions. The application is unreleased. The active domain is
`Task`, `Attempt`, `LoopCheckpoint`, `Report`, and `ActionIntent`.

`apps/server/src/main.ts` starts the investigation Server and serves the Dashboard. The bundled
Worker entry point, `apps/worker/src/main.ts`, starts the native investigation runtime. Tasks are
not converted into the older Job protocol. Historical source modules, design decisions, and
acceptance receipts do not define alternate production endpoints. There is no legacy API
compatibility, dual-write path, data conversion, or retired Job database migration project.

The current `investigation-v5` store accepts only the exact additive `investigation-v2`,
`investigation-v3`, and `investigation-v4` upgrades described below; this does not add compatibility
with the retired Job runtime.

The [structured investigation design](./docs/design/2026-09-15-structured-investigation-results-and-loop.md)
and [built-in account design](./docs/design/2026-09-15-built-in-accounts.md) record the current
product decisions. [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) distinguishes active
implementation and verification from historical milestones and outstanding deployment acceptance.

## Components and ownership

```text
Browser Dashboard
    |
    | same-origin authenticated API
    v
Investigation Server ---- private investigation SQLite database
    |       |           ---- separate account SQLite database
    |       +---- GitHub import and explicit action transport
    |
    | outbound Worker HTTPS requests with scoped bearer credentials
    v
Windows Worker
    +---- attempt-owned source, control files, and artifacts
    +---- durable checkpoint and report delivery
    +---- ProcessHost
              +---- Git
              +---- Codex CLI or Copilot CLI
              +---- registered commands and UI driver processes
```

The Server owns persistent application state, browser authentication, Worker admission, source
imports, task creation, accepted checkpoints, report sealing, action policy, and delivery. It is
the only runtime component that opens the investigation and account databases or uses the configured
GitHub API credential. The Worker initiates connections to the Server and has no inbound listener.

The Worker owns source preparation, managed process execution, loop coordination, artifact capture,
and cleanup. It receives a scoped task lease and frozen inputs. It does not receive the GitHub
publication credential, open Server databases, or implicitly commit, push, merge, or publish.

The Dashboard provides repository, PR, Issue, Task, Report, and account workspaces. Production
requests use the authenticated investigation API. Synthetic development data is explicitly labeled
and is never a fallback for a failed production request.

`packages/contracts` defines runtime schemas and semantic validation. `packages/domain` defines
loop transitions, completion requirements, recommendations, and operation guards.
`packages/codex` supplies shared CLI launch and structured-output handling. The native
`AgenticReview.ProcessHost.exe` manages Windows process trees and resource limits.

## Durable domain

| Entity | Responsibility |
| --- | --- |
| `Task` | Freezes the repository, work item, subjects, coverage, execution policy, budgets, prompt/profile versions, and optional parent report and saved plan. |
| `Attempt` | Records one Worker execution, its identity, lease fence, lifecycle, and termination reason. |
| `LoopCheckpoint` | Retains accepted analysis, coverage, candidates, rechecks, consumption, source facts, and execution start/completion receipts. |
| `Report` | Seals one complete collection of findings, assessment, validation, evidence, artifacts, plans, next actions, and explicit limitations. |
| `ActionIntent` | Binds an actor, exact target/revision, reviewed payload digest, and current guards to a prepared follow-up operation. |

Task kinds are `pr-review`, `issue-investigate`, `pr-e2e`, `pr-verify`, `issue-verify`,
`reproduction-setup`, `issue-fix`, and `feature-implement`. Task and attempt outcomes distinguish
`completed`, `blocked`, `failed`, `cancelled`, and `interrupted`. Report completeness is a separate
`complete` or `partial` property; neither a successful process exit nor a sealed partial report
establishes a complete investigation.

Subjects keep different claims separate: `original_pr` identifies exact base/head SHAs;
`issue_snapshot` identifies immutable Issue content; `source_commit` selects an exact commit;
`local_patch` identifies an artifact and its base; and `remote_branch` requires verified remote
source evidence. Passing checks against a local patch does not certify the original PR or establish
that an upstream fix exists.

Inherited patches retain their original producing task and attempt metadata in `Task.sourceArtifacts`
and the sealed report's `context.sourceArtifacts`. These records are frozen source lineage, not new
execution evidence or artifacts produced by the child task. The exact parent report, patch subject,
artifact identity, and digest remain bound across follow-up tasks.

## Source import and task admission

The production runtime can accept signed `issues.assigned` and `pull_request.assigned` Webhooks.
Per-repository settings choose the recipient and trusted assigning numeric user IDs; the receiver
secret remains deployment-owned. A scoped intake principal can import input and create a root
Task, but has no repository-execution or external-action grants. The receiver does not use the
legacy Job protocol and starts no GitHub polling loop.

Accepted deliveries enter a durable bounded inbox before HTTP acknowledgement. A leased processor
checks current assignment and exact PR revisions, saves an immutable source reference and Task
request, and uses the native Task transaction for input/task/idempotency persistence. Duplicate
deliveries, equivalent assignments, and post-commit recovery reuse the original work. Frozen
imports remain exact even when a concurrent import moves the same PR revision's comment snapshot
pointer. Settings and repository identities are checked again across asynchronous preparation.
The inbox, assignment claims, and settings use separate namespaces in the existing idempotency
collection. See the [receiver operations](./apps/server/README.md#listen-for-trusted-assignments).

Independently enabled E2E intake accepts a trusted user's new PR conversation comment containing
`@configured-account e2e` on its own line through the signed `issue_comment` webhook. It reuses the
repository's trusted numeric user IDs and checks the current comment, repository, and open PR.
Quoted, edited, hidden, and automation-authored commands do not authorize execution. Durable
repository/comment identities deduplicate delivery; an active request at the same base/head revision
is reused. A later command after a terminal result can create another run. PR synchronization cancels
obsolete work without automatically starting a new revision. Each `pr-e2e` Task owns an independent
progress comment and requires no parent static report or saved plan. See
[trusted E2E commands](./apps/server/README.md#trusted-pr-e2e-commands).

Both inboxes expose repository-scoped delivery list/detail reads and versioned, idempotent explicit
retry. Intake state, Task outcome, and comment delivery remain separate. Processing attempts retain
their phases, reasons, timestamps, and known cumulative count across bounded automatic retry cycles.
Only failed canonical intake is eligible for explicit retry. A committed Task is reattached before
new-work authorization, without another model or desktop run; otherwise current authority and source
identity are checked again. Read-only history remains available with intake disabled. The operations
contract is documented in [webhook recovery](./apps/server/README.md#inspect-and-retry-webhook-intake).

An optional relay companion can use the separate SQLite `WebhookRelaySpool` module. It commits exact
signed envelopes before local forwarding, preserves attempt history across restart, and accepts only
a matching receiver acknowledgement as delivered. Network and retryable receiver failures consume a
bounded retry allowance. The module does not start a relay, load GitHub credentials, or request
upstream redelivery. Events lost before relay receipt remain outside its recovery boundary.
An explicit `retryFailed` command uses numeric version checks and idempotent request IDs to queue
another finite batch only for failed deliveries. It preserves cumulative attempts and reserves
additional history capacity atomically; delivered records never requeue. Spool schema v2 additively
upgrades v1 independently of the application's `investigation-v5` store.

Operators register exact internal and GitHub numeric repository identities. The production import
endpoint reads the current PR or Issue and every conversation page, including PR review comments
and review summaries. It verifies the upstream repository, work item, and final revision before
atomically saving the complete snapshot. Imports use GitHub GET requests only.

Response-byte and pagination budgets bound the import. Exceeding a budget, observing changed source,
or failing to retrieve all pages rejects the import without saving a shortened snapshot. A current
snapshot pointer supplies newly created tasks; already-created tasks keep their frozen inputs.

Execution modes are `snapshot_only`, `source_read`, and `execute`. Snapshot-only analysis does not
check out or execute repository source. Source-aware Issue work requires an explicitly selected
full commit SHA, verified by the Server against GitHub. Issue content cannot silently choose an
arbitrary branch or grant execution authority. Source execution additionally requires the actor's
explicit repository-execution grant and a task policy bound to authorized subjects.
Static kinds `pr-review` and `issue-investigate` cannot carry `execute` policy. Creation, admission,
and Worker execution reject that combination; an old malformed static kind does not bypass execution
ownership or cleanup guards.

PR source materialization uses the exact frozen base and head commits and verifies the merge base
and checked-out identity. The Worker admits public repositories through an explicit allowlist;
Git acquisition disables inherited credentials, hooks, and submodule execution. Source coverage
records what was actually materialized and supplied to analysis. Omitted source cannot be marked
reviewed merely because the model completed a turn.

New static source reviews navigate the complete pinned local checkout. The merge-base diff defines
required change coverage; the agent can discover unchanged dependencies and read base blobs when
needed. Repeated diff/base/head bundles remain a historical-checkpoint behavior rather than the
only source available to a new review.

## Accounts and credential boundaries

Console authentication uses application-owned username/password accounts. There is no
passwordless production login, self-service registration, OIDC callback, or third-party identity
provider in the active runtime. An empty account database requires configured first-administrator
credentials and has no predefined password. Bootstrap only creates the first account; later starts
do not overwrite existing accounts or grants.

Administrator status grants account management. Repository scopes, business permissions, action
capabilities, and repository-execution authority are separate explicit grants. Being an
administrator does not grant access to every repository or authorize GitHub operations.

Passwords use salted asynchronous scrypt with bounded concurrency and rate limiting. Browser
sessions use opaque random tokens whose hashes are stored in the account database. Each request
checks the account's enabled state and version. Account updates, password changes, and resets revoke
that account's sessions. Version checks prevent stale administrative changes; the last enabled
administrator is protected from accidental removal.

Browser cookies are HttpOnly and SameSite=Strict, with Secure `__Host-` cookies for HTTPS.
State-changing browser requests require the exact configured Origin. Public HTTP listeners are
rejected; explicit local HTTP is restricted to actual loopback requests. Forwarded headers do not
establish identity. Account recovery is an offline operator command, documented in the
[Server instructions](./apps/server/README.md).

Worker credentials are independent scoped bearer tokens configured by the Server. Browser cookies
cannot claim tasks, and Worker tokens cannot administer accounts. The Server resolves Worker
identity and exact repository scopes from trusted configuration, rather than request bodies.
CLI login is owned by Codex or Copilot under the actual Worker account. The Worker does not copy
CLI authentication files. Replacement child environments exclude the Worker bearer credential
and Server-side credentials.

## Worker lifecycle and managed execution

The production runtime validates canonical local Windows paths, separate trusted and mutable
roots, and executable SHA-256 pins before admission. ProcessHost holds a singleton identity for the
resolved Worker data root and applies Windows Job Object lifetime, timeout, process-count, memory,
and output limits. These are process-management controls, not an adversarial same-user sandbox.
The deployment owns account, filesystem, network, and interactive-session isolation.

The Worker polls for eligible queued task kinds within its configured concurrency bound. Claims
are restricted to its repository scopes. Every attempt has a new fence and lease token;
heartbeats renew that lease and receive cancellation state. Checkpoint, artifact, report-part,
and finalization requests are checked against the current task, attempt, Worker, and lease.
Expired or superseded Workers cannot commit new progress.

Each Worker has one durable Server-owned `e2eEnabled` setting, defaulting to false, with versioned
administrator updates and an audit record. Local role and supported-kind settings only narrow its
capability. The Worker advertises those kinds through `POST /api/worker/policy`, and both the claim
loop and Server admission apply the effective kinds. No additional local E2E enable flag is required.
The administrator API exposes `GET /api/workers` and `POST /api/workers/:id/e2e`.

Disabling the setting stops new execution claims and requests cancellation of active execution in
the existing heartbeat response. Accepted terminal checkpoints may still complete report delivery;
usage replay and cleanup channels remain available. `disabling` and `awaiting_confirmation` retain
unresolved ownership instead of treating an offline Worker or a changed setting as cleanup proof.
These controls do not remove general model shell access, prohibit local screenshots, or add an
operating-system sandbox.

Static reviews share a configurable global capacity, initially one. All execution tasks share one
global E2E slot, independently of static capacity and eligible Worker capacity. An E2E waiter does
not block eligible static work. Admission atomically acquires the resource and creates the attempt.
The E2E lease and machine desktop guard cover the whole attempt through confirmed cleanup; report
finalization, cancellation, lease expiry, or elapsed time alone cannot release the slot.

Attempt workspaces isolate source and model control files. Execution records are retained before
cleanup. SIGINT/SIGTERM stops new claims, cancels owned work, drains managed processes, and closes
ProcessHost. Unconfirmed cleanup causes a node fault and retains the affected workspace; a later
attempt must not reuse uncertain local state.

## Model turns and executable plans

The selected Codex or Copilot CLI owns login, provider configuration, and model transport. The
project has no provider registry or model HTTP relay. Deployment verifies the static CLI policy
and disables unmanaged tools before starting the Worker. CLI engine, executable pin, model choice,
and explicit account environment are deployment settings.

Static investigation turns analyze frozen snapshots or navigate the pinned local source and return
structured analysis. The static prompt permits source-inspection commands and prohibits repository
builds, tests, scripts, application launch, browser interaction, desktop interaction, and source
mutation. This prompt policy is not a new command sandbox. A model cannot supply authoritative
Worker execution observations, operation permissions, or a successful validation result.

The independent `pr-e2e` prompt permits controlled builds, tests, application launch, UI interaction,
screenshots, and recording. Its per-attempt tool service executes through ProcessHost and retains
build identity, owned process/window observations, feature assertions, and actual media. A passed
user-visible feature requires its own evidence; a successful build or a playable failed-state video
does not establish that the feature passed. The model receives the complete frozen scope and
execution policy without narrowing the required changed-path coverage. Source is not modified
to make a check pass.

Executable follow-ups use saved plans from immutable reports. A deployment-owned execution binding
maps an exact plan or profile reference to ordered `command`, `ui`, or `model-edit` operations.
Prerequisites must have explicit matching acknowledgements. Missing or ambiguous bindings block
creation; natural-language plan text is never substituted into executable arguments.

Command IDs resolve to trusted pinned executables. UI operations require registered adapters,
application bindings, frozen scenarios, and available evidence capture. Windows UI work additionally
requires an active, unlocked dedicated session and exclusive desktop access. Missing readiness is
a blocker, not a successful check inferred from model text.

Model-edit operations return proposed complete contents only for explicit allowed paths. The Worker
checks the path allowlist and expected original-content digests before applying them and producing
a separately identified patch. Validation runs against its recorded subject. An implementation-only
plan may produce a patch without claiming tests passed. Creating a PR requires an existing verified
remote branch and never implicitly commits or pushes that patch.

## Complete investigation loop and recovery

The loop advances through discovery, investigation, recheck, and finalization. Each accepted round
references the previous checkpoint and retains candidate and finding identities. A finding records
priority, trigger, impact, root cause or explicit uncertainty, evidence, repair advice, feedback,
and a final-version recheck. Priorities affect ordering, not whether a finding is retained.

Completion requires handled coverage and candidate records, valid rechecks for final finding
versions, and a sealed report. Unresolved coverage, missing prerequisites, cancellation, protocol
failure, and exhausted round, duration, token, or report-size budgets remain explicit. Known findings
and remaining work survive a partial outcome; the loop does not silently discard lower-priority
findings to fit a top-k result.

The Server applies validated transitions to durable checkpoints using content digests and version
checks. Worker execution steps persist a start receipt before running and a completion receipt with
actual checks, artifacts, source identity, and resource consumption afterward. Accepted receipts
remain separate from model conclusions.

Lease expiry retains the accepted checkpoint and marks the task interrupted or cancelled. Explicit
resume creates a new attempt from the frozen task and checkpoint, rather than reviving an old CLI
session. Completed analysis can be restored for report delivery without repeating model work.
Confirmed completed execution can be retained across attempts; an uncertain in-flight mutation is
not automatically replayed. Patch restoration requires the exact saved artifact and source digest.

E2E execution is recorded before runtime side effects, and partial observations are saved during
execution. Recorded-result recovery can deliver accepted observations without another model or
application launch. Repeating an interrupted incomplete execution requires a new explicit Task.
ProcessHost proves the prior owned generation stopped before its successor becomes ready and
waits for a fresh Job Object. A durable cleanup journal separates owned local cleanup from the
Server acknowledgement, so acknowledgement retries do not repeat deletion or desktop-guard release.
This recovery covers managed process trees; arbitrary service-broker or externally detached
processes are not covered by that proof. Uncertain process or desktop state remains a cleanup blocker.

Every actual model invocation has a separate durable usage identity, including rejected output,
failure, cancellation, and resume. Task totals include all attempts without duplicating retried
receipts; sealed Reports retain their publication-time usage snapshot. Available input, output,
cache, and reasoning details remain distinct. Missing provider counters remain unknown rather
than zero. Heartbeat, activity, meaningful progress, accepted rounds, invocation count, and
saved-state version are separate projections; stage timings expose work outside model execution.

## Reports, evidence, and storage

Report transport uses bounded typed parts plus a final header and manifest. Parts carry task,
attempt, report, sequence, count, and digest identities. Duplicate delivery is idempotent only when
the content is identical. The Server assembles and semantically validates the full report against
the current accepted checkpoint, frozen task, saved parent plan, and linked report identities.
Finalization seals the report transactionally; exact terminal retries return the existing identity.

Findings, validation, diagnostics, evidence, artifacts, plans, next actions, and feedback remain
separate collections. Evidence records its subject, producer, authority, and provenance so model
analysis is distinguishable from captured execution or Server observations. Artifact content is
checked against its declared size and digest and is accessed through scoped authenticated APIs.
Availability distinguishes available, expired, and missing evidence.

E2E evidence includes verified PNG images and finalized H.264 MP4 recordings tied to the exact
attempt, revision, feature, and assertion. The authenticated Dashboard displays this media. With
authorized publication configured, the Server uploads attachments through the established CLI
path and persists upload identities for the independent E2E comment. Media availability and
playback are separate claims from functional success.
Publication requires the exact stored `pr-e2e` Task, Server-sealed report, pinned subject, assigned
producer attempts, and trusted E2E tool observations. Static investigation media never enters this
GitHub upload path, even if an artifact or model output claims E2E provenance. This does not prohibit
local screenshot capture.

Mutable evidence metadata, retention pins, and aggregate usage are separate from immutable artifact
identities and sealed reports. The default policy allows 1 GiB of resident original content bytes
and 10,000 resident artifacts, with a 30-day retention interval. A bounded cleanup pass runs at
startup and then every minute, scanning at most 100 metadata records per pass without loading
artifact content. The Server's five `INVESTIGATION_EVIDENCE_*` settings configure these limits.

Cleanup preserves queued/running tasks, accepted checkpoint evidence needed for recovery, and
parent or inherited-source evidence pinned by unfinished follow-ups. Quota exhaustion rejects new
uploads instead of evicting protected content. Eligible expired content is removed while metadata,
report history, and digests remain. `GET /api/artifacts/:id` reports current availability and
retention protection; `GET /api/artifacts/:id/content` returns HTTP `410` for expired or missing
content. Retention does not rewrite a report's original evidence declarations.

The byte quota measures original resident artifact content, not Base64, SQLite, metadata, or WAL
overhead. Cleanup releases logical quota but does not promise that database or WAL files shrink.
Deployment storage sizing and workload acceptance must account for those physical files separately.

Report headers and paginated findings support browsing without changing the authoritative full
report. Server recommendations and hard blockers use the complete saved collection, including
findings beyond the visible page. Export retains the complete result and its logical content digest.

The Server process owns SQLite through `InvestigationStore`, with schema identity
`investigation-v5`, and a separate account store. New investigation databases initialize directly
at v5. Exact, complete `investigation-v2`, `investigation-v3`, and `investigation-v4` databases receive
additive history, scheduler, normalized-output, and directory-storage migrations. Unrelated or
incomplete schemas are rejected without deletion or fallback. Both databases must remain private
and outside the Dashboard static directory.
Detailed retention controls and operating guidance are in the [Server instructions](./apps/server/README.md).
Historical evidence services and schema numbers do not describe this active store.

## Recommendations and action delivery

Repositories may grant standing authorization for automatic conclusion comments on new complete
root investigations. Report sealing synchronously registers an outbox entry with the frozen
template, policy version, and report reference in the same transaction. The dispatcher verifies
the publishing account through GitHub `/user`, rechecks authorization and its lease, and freezes
the rendered body, publishing identity, and ActionIntent request before preparing the comment.
It confirms that intent without per-report human review. The Worker and model have no publication
credential or authority. The authorizing account, repository policy, frozen publisher identity,
and target are checked again before the outbound mutation. Changing the policy blocks unsent
entries from its old version; enabling never backfills historical reports.

The dispatcher uses durable claims and the existing ActionIntent transition and reconciliation
rules. Already sent comments can be recovered after policy revocation; unresolved sends receive
only GET reconciliation. Scoped receipt APIs expose automatic delivery without weakening the
manual ActionIntent actor ownership checks. Version 4 templates start with the AI/model and
represented GitHub-user disclosure. PR replies retain Conclusion, Summary, and Findings; Issue
replies use Triage result and Next steps, with a short summary incorporated into the conclusion.
Bug triage shows Runtime reproduction separately and exposes missing information, proposed
verification, or existing fix/duplicate references without requiring the reader to expand
Investigation details. Feature and other Issue classifications remain distinct from bugs and
omit the runtime reproduction field. Both templates end with an initially collapsed section,
named Details for PRs and Investigation details for Issues, retaining full findings, uncertainty,
validation, source scope, plans, and
limitations. Model names come from accepted per-round Worker CLI selections preserved in
checkpoint and report context; missing attribution is disclosed without guessing. Older template
policies, including versions 2 and 3, require a new save before publication. Frozen comment bodies are
never rewritten by a template change. Oversized comments remain blocked instead of being truncated.
[Automatic reply operations](./apps/server/README.md#automatically-reply-with-investigation-results)
document configuration and the ordinary-comment scope.

Recommendations describe what the complete report supports. Current operation guards separately
check the actor, installed handler, target state, revision, source, and pending delivery. An
unresolved, confirmed, rechecked P0 on the current original PR blocks Approve, including qualifying
findings retained in an accepted checkpoint. P1 findings, incomplete analysis, and missing required
E2E affect recommendations without adding that same hard content prohibition.

Preparing an action stores the exact actor, target/revision, report reference, payload, and payload
digest. Confirmation checks the reviewed digest and current intent version, then recomputes current
permissions and prerequisites before acquiring execution. Only the caller that persists the
execution transition owns delivery. Repeated confirmation does not resend the operation.

Follow-up tasks preserve the saved parent report and selected plan. Unknown external delivery uses
read-only reconciliation and is not automatically resent. A pending unknown submission blocks
conflicting new writes. Actual GitHub writes also require configured transport credentials and
`INVESTIGATION_ENABLE_EXTERNAL_WRITES=true`, which is disabled by default.

Automated tests must use isolated synthetic state and mocked transports or read-only live checks.
Writing to actual repository PRs or issues requires explicit authorization for the targets,
operations, content, and execution scope, as recorded in [AGENTS.md](./AGENTS.md). Historical live
acceptance authorizes neither new targets nor an unapproved rerun.

## Deployment and acceptance boundaries

Use the [Server instructions](./apps/server/README.md) and
[Worker instructions](./apps/worker/README.md) for active configuration. The Server uses
`INVESTIGATION_*`; the Worker uses `INVESTIGATION_WORKER_*`. The runtime requires the supported
Node.js and pnpm versions, a built Dashboard, the Worker bundle, ProcessHost, Git, and a configured
model CLI. Public deployments use HTTPS. Service installation, restart policy, backups, resource
sizing, and interactive-session readiness belong to the deployment.

Project verification runs on the project-designated remote Windows worker. Linux-specific checks
may use `test-env`; local verification requires explicit authorization for the current task.
The [investigation acceptance instructions](./deploy/investigation-acceptance/README.md) describe
the opt-in synthetic lifecycle harness and real CLI companion. The scripts' availability is not
an acceptance result. Automated checks establish their recorded scope; they do not by themselves
accept a real model, Windows desktop, upstream repository workflow, or production workload.

M39/M40 retain their controlled CLI and headless Issue workflow evidence. M41 accepted its exact
approved publication targets and payloads. M42 completed the recorded Spectre prerequisite
installation, scoped PowerToys build, and seven selected tests; its earlier uninstalled state is
historical. These receipts preserve their original revisions and environments and do not establish
acceptance of the new Task protocol or a newly deployed Windows Worker.

The [2026-09-19 handoff](./docs/handoff/2026-09-19-local-source-review-e2e.md) accepts the recorded
local-source static reviews, invocation accounting, static/E2E overlap, global E2E serialization,
independent media publication/playback, managed recovery, and application-open cancellation. Peek
and Launcher functional scenarios retain failures and blockers and require further acceptance.
That earlier GitHub redelivery encountered an external HTTP 401 before the receiver and did not
establish full-path idempotence. The later cached-redelivery result retains its separate scope below.

The subsequent [Worker controls and webhook recovery implementation](./docs/design/2026-09-19-worker-controls-and-webhook-recovery.md)
adds the default-off Worker setting, static-media publication guard, inspectable/retryable intake,
and durable relay spool. Scoped software and Dashboard/native-intake browser checks are recorded in
the [current handoff](./docs/handoff/2026-09-19-worker-controls-and-webhook-recovery.md); the native
browser scope uses real HTTP/SQLite with GitHub mocked. PR #15's sixth Task passed three Calculator
features and four UI assertions, and its owned cleanup/native lease release are confirmed. The
fifth report's four GitHub images and MP4 playback passed while its Task remained blocked. Real
HTTPS redelivery returned a cached duplicate without another Server receiver entry. The eighth Task
completed naturally with confirmed cleanup but no disable CAS. A separate native cancellation fixture
passed with synthetic inputs and real runtime/window/FFmpeg processes. Operational closeout is complete;
temporary capacity settings were restored with legacy services/history preserved. Source publication
is complete. Earlier PR #14 source-preparation failures remain historical; pinned-submodule support
and deployment-owned compiler selection subsequently addressed those implementation blockers.
The recorded September 19 fixture is owned-fork PR #15, using
the actual merge of upstream PowerToys PR #47506 and its sole parent, whose complete trees have no
gitlinks. All four changed files belong to Run Calculator. Three scenarios cover
explicit complex-number errors, suppression of implicit-query error rows, and ordinary arithmetic.
The implicit-query absence assertion requires a same-mode positive Calculator result first; an
inactive plugin is not evidence that error suppression works.
The existing all-changed-path coverage gate remains in force. The earlier mixed Run/CmdPal fixture,
owned-fork PR #13, is superseded, unexecuted, and closed; neither fixture changes the older
Peek/Launcher outcomes.

The operations baseline is published on `main` at `b690dd9`. Its
[September 27 workflow handoff](./docs/handoff/2026-09-27-four-gib-workflow-acceptance.md) records
149 distinct targeted tests, a 30-test Windows repeat, 10 native lifecycle checks, and 11 compiled
Dashboard/native HTTP/SQLite browser steps. Actual isolated Scheduled Task Server hosting in
Session 0, idle Worker hosting in an interactive session, duplicate-start protection, cooperative
shutdown, populated backup/restore and application reopening, bounded Server retries, and the
Worker's same-boot recovery gate passed. Targeted webhook tests separately observe relay cache
hits and native Server receiver re-entry across restart. These are completed scoped checks.

Production cutover remains pending its deployment receipt. VM reboot/power-loss and cross-boot
recovery, current-release real-model and PowerToys execution, live publication, and unrecorded
Windows hosting matrix cases retain separate acceptance. The short two-task capacity observation
and sampled 4 GiB serial workflow do not establish sustained workload, concurrent capacity, physical
SQLite/WAL growth limits, or disk reclamation. Historical Peek/Launcher outcomes and the original
external HTTP 401 remain unresolved within their original scope.

General model-quality evaluation and third-party login remain outside this delivery. Private
checkout, automatic Worker release distribution/upgrades, and reusable build outputs are optional
unimplemented extensions. Manual Scheduled Task registration is implemented; its installer does
not package, copy, or replace releases. Video evidence is implemented and accepted within the
recorded scope. [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) tracks current release
verification and the backlog separately from historical receipts. Retired split-Worker,
protected-journal, provider-registry, and model-relay designs are not current backlog items.
