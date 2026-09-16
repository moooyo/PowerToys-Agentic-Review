# Agentic Review Architecture

## Scope and production entry points

Agentic Review investigates GitHub pull requests and issues, retains complete structured reports,
and prepares explicit follow-up actions. The application is unreleased. The active domain is
`Task`, `Attempt`, `LoopCheckpoint`, `Report`, and `ActionIntent`.

`apps/server/src/main.ts` starts the investigation Server and serves the Dashboard. The bundled
Worker entry point, `apps/worker/src/main.ts`, starts the native investigation runtime. Tasks are
not converted into the older Job protocol. Historical source modules, design decisions, and
acceptance receipts do not define alternate production endpoints. There is no legacy API
compatibility, dual-write path, data conversion, or migration project.

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

Task kinds are `pr-review`, `issue-investigate`, `pr-verify`, `issue-verify`,
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

PR source materialization uses the exact frozen base and head commits and verifies the merge base
and checked-out identity. The Worker admits public repositories through an explicit allowlist;
Git acquisition disables inherited credentials, hooks, and submodule execution. Source coverage
records what was actually materialized and supplied to analysis. Omitted source cannot be marked
reviewed merely because the model completed a turn.

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

The default Worker concurrency is one. Attempt workspaces isolate source and model control files.
Execution records are retained before cleanup. SIGINT/SIGTERM stops new claims, cancels owned work,
drains managed processes, and closes ProcessHost. Unconfirmed cleanup causes a node fault and
retains the affected workspace; a later attempt must not reuse uncertain local state.

## Model turns and executable plans

The selected Codex or Copilot CLI owns login, provider configuration, and model transport. The
project has no provider registry or model HTTP relay. Deployment verifies the static CLI policy
and disables unmanaged tools before starting the Worker. CLI engine, executable pin, model choice,
and explicit account environment are deployment settings.

Investigation turns analyze supplied snapshots and complete source files and return structured
analysis. They do not execute repository commands, build, test, browse, or mutate files. CLI launch
restrictions, output-schema validation, and event checks enforce the static-turn contract. A model
cannot supply authoritative Worker execution observations, operation permissions, or a successful
validation result.

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
`investigation-v2`, and a separate account store. Schemas are initialized directly for this
unreleased product; incompatible existing databases are rejected without conversion, deletion, or
fallback. Both databases must remain private and outside the Dashboard static directory. Detailed
retention controls and operating guidance are in the [Server instructions](./apps/server/README.md).
Historical evidence services and schema numbers do not describe this active store.

## Recommendations and action delivery

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

Current deployment, real-model workflow, human-action, capacity, and evidence-retention acceptance
must be recorded independently in [Implementation Status](./docs/IMPLEMENTATION_STATUS.md).
Dedicated PowerToys UI scenarios, general model-quality evaluation, and third-party login are
outside the current delivery. Private checkout, automatic distribution, video evidence, and reusable
build artifacts remain separate unimplemented scope. Retired split-Worker, protected-journal,
provider-registry, and model-relay designs are not current backlog items.
