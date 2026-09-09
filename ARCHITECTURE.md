# Agentic Review Architecture

## Scope

This document describes the current pre-release architecture, including the validation-platform
integration in the working tree on 2026-09-07. Component checks have passed; complete cross-host
Server/Worker/Dashboard acceptance is still in progress. See
[Implementation Status](./docs/IMPLEMENTATION_STATUS.md) for that verification boundary.

ADR 0029 replaces the unpublished Control/Executor split, local RPC protocols, result-artifact
pipeline, and signed Worker package flow. No compatibility path is retained for those prototypes.
[ADR 0031](./docs/adr/0031-profile-validation-runs-and-bounded-evidence.md) narrowly replaces its
inline-only evidence restriction and adds profile validation runs. Existing V1 envelopes and
historical inline review results remain supported.

The system has three application processes and one native execution helper:

- a Linux Server;
- a browser Dashboard served by the Server;
- one outbound-only Windows Worker process per node; and
- `AgenticReview.ProcessHost.exe`, launched by the Worker for bounded child process execution.

## System flow

```text
GitHub webhook/poller
        |
        v
Linux Server ---- SQLite + private bounded evidence storage
    |  ^
    |  | HTTPS + Worker Bearer Token
    v  |
Windows Worker
    |
    +-- shared bare Git repository per GitHub repository
    +-- detached worktree per run attempt
    +-- separate original-source validation and model workspaces
    +-- ProcessHost -> Git / Codex / validation process trees
    +-- managed Windows UI Automation / Chromium driver children
```

The Server is the only component that owns SQLite and GitHub ingestion credentials. The Worker
receives job envelopes and reports progress and terminal results. It does not receive a GitHub
publication credential and does not open the Server database.

## Trust model

Repositories, revisions, prompts, and executable validation selected by admission policy are
trusted execution inputs. The Worker is allowed to execute builds and tests from the admitted
worktree.

This trust decision removes the need for a separate credential-free Executor service. It does not
remove operational controls:

- Server leases and generations fence stale Workers and replayed terminal reports.
- ProcessHost creates Windows Job Objects with kill-on-close, timeout, process-count, memory, and
  combined-output limits.
- Git and Codex receive replacement environments.
- Worker Bearer Tokens and Server-side GitHub credentials are never propagated to child processes.
- Worktrees and task control, temporary, and user-profile directories are deleted after terminal
  reporting; the dedicated Codex authentication home persists.

ProcessHost is a reliability and resource-control boundary, not an adversarial same-user sandbox.

## Server

The Fastify Server owns:

- GitHub webhook verification and optional polling;
- authorization of configured repositories and actors;
- immutable work-item and revision projections;
- job creation, retry policy, claims, leases, heartbeats, and terminal fencing;
- bounded current scheduling diagnostics for scoped Jobs and validation requests;
- immutable review-run plans, profile dispatch, and separate typed validation-result persistence;
- inline completion validation and bounded evidence upload/finalization/scoped reads;
- Worker credential creation, rotation, revocation, and authentication;
- operator authentication, repository access control, membership audit, and Dashboard APIs; and
- health and recovery-maintenance behavior.

SQLite has one process owner. The current working tree contains migrations `0001` through `0024`;
M28 adds the operational `job_admission` and `scheduling_state` tables.
Authoritative result JSON remains in bounded inline database fields. The same database owner
manages evidence manifests and a private filesystem directory; there is no separate artifact
service or restoration of the unpublished artifact Worker Thread design.

Whole-file hashes and UI scenario evidence checks run in a dedicated read-only verification
Worker. It receives scoped immutable snapshots, never SQLite access or lease tokens. Finalization
and completion await verification outside transactions and repeat current authority checks before
committing. Overlapping identical finalizations share one fenced operation; terminal completion
replays remain independent of evidence retention. Run details use prepared proofs and fresh file
identity probes; cold reads return explicit pending coverage while bounded verification runs in
the background. Heartbeats, cancellation, and scheduling are not queued behind that file work.
Shutdown stops admission, aborts and drains pending preflights, confirms verifier exit, then closes
SQLite. See the [verification design](docs/design/2026-09-07-evidence-verification-control-plane.md).

Source events retain immutable provenance separately from local observation times and current
snapshots. Replayed deliveries must preserve their payload identity. Stable execution inputs,
prompt/schema versions, and policy determine task reuse; delivery IDs and polling timestamps do
not. A return to a superseded revision creates a new activation when the old job is no longer
reusable, without reviving a terminal attempt.

PR authorization defaults to an explicit request for the exact base/head revision. Historical
polling actors cannot authorize a newly observed SHA. Automatic inheritance requires both the
current policy and the original epoch policy to select `inherit_authorized_epoch`; the original
requesting actor must still be authorized. Issue triage retains its snapshot workflow. See ADR 0030.

Dashboard list filters and pagination execute in SQL with matching indexes. GitHub health comes
from configured ingestion modes and per-repository polling success/failure, not business-event
frequency. Worker long polls stop when their response connection closes.

### Repositories, plans, and profile jobs

Managed repositories use stable internal and GitHub numeric identities. Published Prompt/profile
versions and per-repository bindings are database-owned; environment configuration is bootstrap
input rather than a source that overwrites subsequent edits. M19 repository grants constrain
server reads, pagination, totals, actions, and configuration at the database boundary. Selecting a
repository in the Dashboard does not itself grant access.

M14 freezes a `ReviewRunExecutionPlanV1`, rendered prompts, profile requests, source identity, and
authorization. Static/build, Windows UI, Web UI, issue triage, and issue validation are separate
workflow/profile requests. M15 stores their typed results independently of legacy review results.
M17 provides bounded pending dispatch, repository rotation, audited cancellation, and idempotent
profile reruns. Runner readiness is recomputed from implemented runtime capabilities and does not
change the plan digest or queued snapshots.

Database `job_kind` retains `pull_request_review` and `issue_triage`. Envelope V2 carries the
selected profile's `ValidationJobContextV1`: workflow/target, run and plan identity, Prompt/profile
versions, required coverage, run activation, and profile job activation. It uses the existing lease
and attempt machinery. An operator rerun within a frozen plan creates a new profile job activation;
an infrastructure retry creates another attempt of the existing job. New configuration requires a
new run. These operations preserve earlier results.

M18 records source transitions, including A-to-B-to-A, and pins legacy-versus-ReviewRun routing per
work item, authorization epoch, and source sequence. Transport replay and later binding changes
cannot launch a second pipeline for the same source activation. Separate active assignment and
review-request epochs may own separate runs; matching profile jobs retain concurrency exclusion.
The GitHub bridge and startup/dispatch composition are under integration verification.

Issue reproduction requires an explicitly selected commit and an independently authenticated
operator source authorization bound to the run activation, repository, issue, current issue content
revision, and exact commit. Issuer, subject, and authorization time come from the authenticated
Server boundary. Issue-triage authority cannot silently authorize arbitrary code execution. PRs
continue to require the exact GitHub-authorized base/head revision.

### Current scheduling diagnostics

M27 P0 provides three read-only GET projections: a repository Job with exact work-item ownership,
a repository Run/request with its latest Job or a no-Job observation, and platform-administrator
Job inspection including unassociated legacy Jobs. Current authorization and projection execute
within one synchronous database-owner read snapshot. These reads do not claim, dispatch, retry,
cancel, or change stored scheduling state.

Diagnostics share the existing claim path's pure template, capability, and envelope helpers while
preserving claim gates and ordering. Current source and authorization changes are reported as
`current_prerequisite` observations without adding claim enforcement. Legacy Jobs consider their
associated authorization epochs. Slot observations count active attempts, including expired but
unreaped leases and attempts whose Jobs have cancellation pending.

Worker inspection uses indexed status/affinity selection of at most 129 identities, with the final
identity serving as an overflow sentinel; at most 128 Worker payloads are read. Requirement-name
traversal has a 4,096-step budget, and repeated envelope inspection has a 64 MiB work budget.
Responses are limited to 64 KiB, 32 reasons, and 64 requirement names. Incomplete inspection and
truncated names remain explicit rather than establishing that no suitable Worker exists. Public
projections omit Worker identities, other Jobs holding capacity, and global inventory counts.

The Dashboard displays live scheduling observations separately from frozen plan readiness. It
polls every five seconds while visible and eligible for refresh, cancels hidden or superseded
requests, and clears old observations when session, scope, or access changes. Terminal observations
stop polling. M28 adds explicit admission observations below; configured quotas, capacity limits,
and repository/class fairness remain P1 work.

The [M27 acceptance report](./artifacts/m27-scheduling-diagnostics-20260907/REPORT.md) records the
completed P0 checks and aggregate browser/HTTP evidence across original and recovery sessions.
An external restart destroyed the original temporary environment, so original Server graceful
shutdown is unproven. Recovery covered all eight HTTP states with unchanged core rows and a
confirmed graceful Server/database shutdown; the retained orchestration failures remain part of
the evidence boundary. This acceptance performs no real repository PR or Issue writes.

### Durable Job admission foundation

M28 separates acceptance from admission. Valid Legacy and V2 work, including reruns, persists a
real immutable Job with a pending admission episode even when no Worker is available. Missing
structural prerequisites such as a Prompt still leave a validation request without a Job. Both
retry paths create a new pending episode in the terminal-attempt transaction. Claim requires an
admitted row whose `attempt_base` matches the waiting Job's attempt count; SQL guards reject
missing/stale admission and invalid lease/active-attempt transitions.

Migration 24 backfills every existing Job with the production execution-template parser without
rewriting historical payloads. Existing waiting Jobs start admitted with an explicit migration
timestamp basis; active Jobs retain their pre-grant attempt base and lifecycle. Numeric GitHub
repository buckets and explicit unresolved/conflicting ownership do not grant read access.
The durable episode and inspection sequences use safe integers. Bounded inspection remains
explicitly incomplete when its budget cannot establish ownership; a trusted claim witness can
refine unknown ownership from the actual stored template.

A coalesced production pump processes a bounded pending pass with a captured episode high-water
mark, retains progress across calls, wakes on relevant changes, falls back every five seconds,
and drains during shutdown. This implements admission foundation, not repository/class fairness,
configured limits, or bounded continuation of the complete claim scan. Strict V2 scheduling
diagnostics retain V1 compatibility. Public Job, Run, Work Item, and System projections distinguish
pending admission, admitted waiting Jobs, and no-Job prerequisites; the HTTP Job-list whitelist
accepts the admission filter. Observational GETs do not mutate scheduling state.

The [M28 report](./artifacts/m28-admission-foundation-20260907/REPORT.md) records final automated
and connected acceptance, including UI cancellation/rerun, unchanged exact replay, production-pump
admission after Worker registration, access revocation/restoration, and explicit service closure.
No lease or real PR/Issue write occurred. Configured repository/global limits with CAS/audit,
queue-credit recovery, repository/class fairness, bounded claim continuation, and 100,000-Job
latency acceptance remain required by the full scheduling plan.

### Worker API

The current Worker surface is intentionally small:

```text
POST /api/v1/worker/instances
POST /api/v1/worker/leases/claim
PUT  /api/v1/worker/instances/{workerInstanceId}/heartbeat
PUT  /api/v1/worker/leases/{runAttemptId}/heartbeat
POST /api/v1/worker/runs/{runAttemptId}/complete
POST /api/v1/worker/runs/{runAttemptId}/fail
POST /api/v1/worker/evidence/uploads
POST /api/v1/worker/evidence/{assetId}/chunks
POST /api/v1/worker/evidence/{assetId}/finalize
```

Every request uses a node-scoped Bearer Token. Lease-token, Worker-instance, generation, and active
attempt checks are still required for progress, uploads, finalization, and terminal operations.
Operator evidence reads are additionally scoped through repository, run, job, and attempt routes.

## Operator authentication

Operator authentication has two explicit modes:

- `loopback`: for a Server whose listener and public origin are both loopback; and
- `oidc`: for an externally reachable deployment using Authorization Code plus PKCE.

OIDC is therefore a deployment choice, not a Worker execution dependency. GitHub webhook secrets
and GitHub read tokens are independent credentials and are unrelated to operator OIDC.

M19 authorization uses the authenticated session's exact `(issuer, subject)` pair. Repository
roles inherit read, run-control, configuration, and membership-management permissions through
viewer, reviewer, maintainer, and admin. Platform administrators are configured at startup; OIDC
requires `AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON`, a nonempty subset of allowed login subjects.
Loopback mode uses its explicit development identity. Login alone does not grant repository access.
Global Prompt catalogs, Workers, credentials, System resources, and repository creation require a
platform administrator.

Operator HTTP handlers use a session-bound database request allowlist, separate from trusted
internal Server and Worker operations. Repository ownership and current grants are checked in the
database owner, including after asynchronous evidence preparation and before each download chunk.
Invisible resources return an opaque 404. Membership changes create immutable audited receipts
with version checks, idempotency, and last-admin safeguards. The Dashboard resets cached data when
the authenticated principal changes; controls are secondary to Server authorization. See the
[access design](./docs/design/2026-09-07-operator-repository-access.md).

M23 exposes recorded repository configuration, prompt binding, and profile events within each
repository's read scope. Global Prompt history requires platform authority. Lists are bounded
metadata projections; details use retained snapshots rather than current rows or draft text.
The two audit tables preserve their history in migration 23's immutable `WITHOUT ROWID` storage.
See the [configuration audit design](./docs/design/2026-09-07-configuration-audit-reads.md).

M20a records human decisions in an immutable per-Run stream, separately from model advice, runner
checks, policy eligibility, and publication. New decisions bind the exact source sequence and all
planned requests' latest Job/attempt/result identities. A queued rerun invalidates an earlier
decision immediately. Comments preserve the current decision; withdrawals retain a tombstone.
Ordinary approval rechecks verified evidence and current policy inside the final short transaction.
An exception approval requires a maintainer and remains qualified without changing policy. State
and history reads select bounded public receipts, not the potentially large private policy bodies.
No GitHub write is performed by these APIs. See the
[decision design](./docs/design/2026-09-07-run-human-decisions.md).

M21 adds immutable finding occurrences, reviewer disposition, and explicit result comparisons.
Occurrence identity uses the original result ID/digest, namespace, and ordinal. Policy v2 retains
the raw P0/P1 count but only open or accepted P0/P1 findings remain blocking. Failed checks, missing
evidence, and source/lifecycle gates still apply. A V2 human-decision snapshot binds the current
disposition versions, so reopening or changing a finding cannot silently reuse an old approval.
Migration 0021 preserves all historical v1 decision bytes and receipts. The connected Dashboard
shows complete finding content and history; comparison never treats an absent finding as resolved.
See the [finding design](./docs/design/2026-09-07-finding-lifecycle.md).

## Windows Worker

The Worker is one Node.js process built as `apps/worker/dist/worker.mjs`. A service manager may run
that process, but the repository does not currently ship a native Worker service wrapper or
installer. Manual trusted deployment is the supported pre-release path.

At startup the Worker:

1. loads its fixed Bearer Token profile;
2. checks persistent Codex and runtime directory identities using read-only `lstat`/`realpath`
   validation, rejecting links, aliases, overlap, and observed identity changes;
3. loads allowed Codex profile settings and validates executable paths and SHA-256 digests;
4. starts ProcessHost over its NDJSON standard-I/O protocol and acquires the data-root singleton;
5. recovers all abandoned attempt directories under the acquired singleton;
6. registers one Worker instance; and
7. enters the claim, heartbeat, execute, and terminal-report loop.

Any initialization failure after ProcessHost creation closes that client before rethrowing the
original error. Cleanup diagnostics are bounded and cannot mask the startup failure.

Only one Worker process may use a node's data, shared-repository, and workspace directories at a
time. ProcessHost holds a Windows global named mutex derived from the resolved Worker data root for
its complete lifetime. A service manager may restart the Worker, but it is not the exclusivity
boundary.

Pending-start cancellation retains the request's original acknowledgement deadline and terminates
only that request after acknowledgement. Unrelated process trees remain active.

Workspace monitors share one node-wide periodic accounting scan while retaining per-attempt
identity and quota checks. Queue wait and scan execution have separate bounded deadlines. Startup
recovery removes confirmed unowned attempts regardless of age. Capacity shortages pause claims
and report zero slots; the Worker rechecks capacity and resumes automatically. Unsafe paths and
unrecoverable infrastructure faults still drain the node.

The profile runtime adds registered executable aliases, protected secret references, headless
command execution, and managed UI drivers. Capabilities are derived after runtime preparation;
deployment labels cannot claim unavailable V2, browser, or interactive-desktop execution. Worker
startup composition exists in the working tree and is being verified with the complete workflow.

Windows UI uses UI Automation in an active unlocked session and an exclusive desktop lease. It
operates only on the selected window in the launched process tree; uncertain stop/reset retains a
quarantine marker. Web UI uses a separately managed Chromium driver and browser context against
the owned allocated loopback application origin. Both run deterministic scenarios, capture evidence,
and drain owned processes before releasing resources. Neither target's driver is an OS or network
sandbox. Dedicated test data, session provisioning, and reset behavior remain deployment inputs.

## Git repository and worktree lifecycle

Each configured public GitHub repository maps to one persistent bare repository:

```text
<git-shared-root>/repository-<githubRepositoryId>.git
```

For each pull request attempt, the Worker serializes repository metadata mutation for that
repository and performs the following operations:

1. initialize or reuse the bare repository;
2. set the canonical GitHub `origin` URL;
3. prune stale worktree registrations;
4. fetch the envelope's immutable `baseSha` and pull request head ref without shallow history,
   using `--no-auto-maintenance`;
5. verify the fetched pull request head equals the envelope's immutable `headSha`;
6. verify the envelope `baseSha` and `headSha` are commits and have a merge base;
7. create a detached worktree at the exact `headSha`; and
8. verify the worktree `HEAD` again before Codex starts.

The fetch is independent of the base branch name or its current tip. It supports PRs targeting
`dev` or any other base ref without assuming or falling back to `main`. Queued jobs retain their
immutable base SHA when the branch advances.

The current Worker uses an anonymous GitHub HTTPS URL and disables credential helpers. Private
repository checkout is not supported by this MVP.

Worktrees live below the attempt workspace root. The bare repository persists across jobs, so
subsequent fetches transfer only missing objects. A cancellable shared-cache mutation lock serializes
global accounting and bare-repository setup or cleanup across repositories; per-repository locks
preserve ordering for each repository. Once prepared, worktrees for different jobs can execute
concurrently.

The shared repository root has a separate total-byte limit and minimum-free-disk guard. Accounting
is bounded by entry count and wall-clock time and fails closed on reparse points or unstable paths.
The Worker checks the budget before and after fetch and after worktree cleanup. When the budget is
violated, it first prunes stale worktree metadata, verifies that no registered or in-memory worktree
is active, expires reflogs only to the configured conservative age, and runs repository-local GC
with the same prune age. A cache that remains over budget is reported as a node infrastructure
fault so the Worker drains instead of accepting more work.

Issue-triage jobs currently use an isolated non-repository workspace because their envelope contains
an issue snapshot rather than a repository revision.

Issue-validation jobs have a distinct exact-source path using the separately authorized commit;
they do not infer a checkout from a branch tip or from the issue content digest. Profile validation
and model review receive separate workspace identities under the same real attempt lease. UI
profiles currently build their own source; no cross-profile build-artifact reuse is implemented.

## Codex execution

The Server renders a trusted versioned prompt and sends its digest and authoritative output schema
in the job envelope. The Worker independently selects the matching compiled schema, verifies the
envelope, and writes only the per-attempt schema and result control files. The persistent
`WORKER_EXECUTION_PROFILE_DIRECTORY` is the dedicated `CODEX_HOME`; the Worker does not overwrite its
operator-provisioned `config.toml` or copy authentication files into worktrees.

The profile loader allows only supported model, selected-provider, and authentication settings.
Provider HTTP header values are converted to `CODEX_PROVIDER_HEADER_<n>` environment variables for
native Codex; their values are not serialized into command-line overrides. Build/test shells get
exactly `COMSPEC`, `PATH`, `PATHEXT`, `SYSTEMROOT`, `TEMP`, `TMP`, and `USERPROFILE`, with no Codex
home, provider credentials, Worker Token, or GitHub credentials.

Codex runs with:

- `sandbox_mode = "workspace-write"`;
- `--ignore-user-config` and fixed CLI overrides after the allowed operator settings;
- `--config approval_policy="never"` rather than the unsupported exec `--ask-for-approval` form;
- outbound network access enabled for admitted execution code;
- the prepared worktree as its working directory;
- project instructions such as `AGENTS.md` enabled;
- project trust `untrusted`, suppressing repository config without changing the trusted-code policy;
- MCP, plugins, hooks, notifications, and inherited extra write roots disabled, with only the current
  task temporary directory added to the worktree's write access;
- a replacement environment without Worker credentials; and
- ProcessHost resource and lifetime limits.

The pinned native CLI used for the current compatibility checks is Codex 0.145.0. The dedicated
profile must have `config.toml` and supported file/keyring authentication or a supported provider
authentication command; a login in another default profile does not establish Worker readiness.

The legacy pull request prompt permits inspection, edits, builds, and tests inside its disposable
worktree and forbids publishing, pushing, merging, or mutating external systems. Profile jobs run
deterministic validation against the original source and perform required model review in a
separate workspace. A model repair or its subsequent successful tests cannot certify the submitted
source. Model output is separately validated and cannot supply runner checks or finalized evidence.

## Result contract

The authoritative completion retains one form:

```json
{"resultDigest":"<sha256>","result":{}}
```

The Worker validates the model output against the job schema, canonicalizes it, computes its digest,
and submits the inline result. The Server revalidates the result before the fenced database
transaction completes the attempt.

Legacy review jobs use `PrReviewPlanV2` or `IssueTriageV2`. Model verification statements are displayed
separately from Worker-captured CLI command status/exit codes and final `git status` observations.
Read-only inspection commands do not prove that tests passed, and incomplete capture stays
explicitly incomplete. The model cannot supply the Worker evidence field. Commands and diagnostic
summaries are bounded and redacted before submission. Failed attempts retain a structured category,
exit code, summary, and correlation ID; diagnostic content participates in terminal replay identity.
The original V1 schema registry remains available for queued jobs and historical results.

Schema 8 and later single-Worker databases can upgrade on startup under exclusive ownership.
Result migrations preserve V1 JSON, digests, projections, and immutable references. Databases from
earlier unpublished architectures remain outside the supported upgrade path.

Profile jobs submit `ValidationJobResultV1`, separating the Worker report, command/lifecycle
diagnostics and cleanup state, and model review. Required checks are derived from the frozen plan.
Each typed UI scenario has one qualified check ID; its actions and assertions are evidence details.
Execution success does not imply check success or a recommendation to approve. A failed compile or
assertion can be a valid, completed report.

Approval eligibility is computed for the current revision and plan. All required runner checks
must pass against original source with complete evidence; missing profiles/scenarios, required
lifecycle failures, stale or modified-source results, and unresolved blocking findings prevent an
unqualified approval conclusion. Human decisions and actual GitHub publication remain separate.

M16 adds evidence manifests and bounded resumable upload for PNG screenshots, JSON steps, ZIP/JSON
traces, and text logs. The current limits are 512 KiB per chunk, 64 MiB per asset, 16 MiB per
screenshot, and 256 assets/128 MiB per attempt, with additional configured global quotas, retention,
and incomplete-upload expiry. The Server derives storage paths, validates file identity/size/digest,
and exposes authenticated scoped manifests and content. Required evidence must be finalized before
it can establish complete coverage. Completion JSON references assets; it is not replaced by an
artifact-backed result mode.

Production result reads validate UI step files against frozen scenarios, including target, order,
action, expected/actual assertions, and screenshot ownership. A finalized file with a valid SHA but
fabricated step semantics cannot establish eligibility. Expired or unavailable evidence makes the
current projection incomplete while preserving the immutable result history. Operator run/history
and evidence/action components are present; their complete integration acceptance remains pending.

## Deployment

The Server is expected to run on Linux with private SQLite and evidence storage. The Worker is
manually deployed to Windows with pinned Node.js, Git, Codex CLI, `worker.mjs`, and ProcessHost
binaries. UI execution also needs the registered driver assets and browser or interactive-session
prerequisites. A normal noninteractive service cannot satisfy desktop UI readiness. Automatic
package distribution, Ed25519 release signing, upgrades, repair, and rollback are outside the MVP.

Production network deployments use HTTPS. Loopback development may explicitly allow HTTP. The
Worker initiates all Server connections; no inbound Worker listener is required.

## Recovery maintenance

`AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true` starts a loopback-only recovery boundary. It keeps
liveness open, readiness closed, Worker routes closed, GitHub ingestion stopped, and lease reaping
stopped while operators reconcile the restored database and Worker credentials. See
`docs/operations/worker-token-recovery.md`.

The 2026-09-05 Windows runtime E2E exercise passed, including healthy success, active cancellation,
cache reuse, and recovered cleanup. Its tested scope, evidence, and environment closeout are in the
[live validation handoff](./docs/handoff/2026-09-05-windows-e2e-live-validation.md).

## Known pre-release gaps

- Automatic Windows service installation, restart policy, and upgrade management remain
  deployment-owned.
- Repository checkout currently supports only anonymously readable public GitHub repositories.
- Connected component acceptance covers static/build and both UI targets; M22 also covers measured
  Issue reproduction through actual native drivers and HTTP evidence delivery. M24 accepted actual
  public-source headless installation, Web compilation, CI tests, source verification, result
  display, and cleanup. M26 accepted a real public Web homepage's passing theme interaction and
  deliberate assertion failure, original screenshots/steps/traces, Dashboard presentation, and
  resource cleanup. Actual Windows application scenarios, further toolchains, and the production
  model remain outstanding. See the [Web acceptance ledger](./docs/design/2026-09-07-real-web-acceptance.md).
- M24 real-source execution corrected workspace environment composition and active filesystem
  accounting. The actual elevated model probe denied controlled file writes but allowed an owned
  loopback connection. Optional summaries remain disabled by default; network isolation and real
  summary acceptance are not established. See the
  [production acceptance ledger](./docs/design/2026-09-07-production-validation-acceptance.md).
- M23 configuration audit reads expose scoped repository events and platform-only prompt history.
  M19 repository ACLs and membership audit reads are implemented; deployed OIDC and actual lower-role
  browser acceptance remain outstanding.
- M27 current diagnostics and M28 admission foundation are implemented. Configured repository/global
  limits with CAS/audit, queue-credit recovery, repository/class fairness, bounded claim continuation,
  and 100,000-Job latency acceptance remain required P1 work. M20a human
  decisions, M21 finding disposition/comparison, and M22 reproduction mapping and Dashboard flows
  are implemented.
  M25 enforces repository pause at claim for queued/retrying V1 and V2 jobs while preserving active
  leases.
- GitHub publication/outbox delivery, notifications, and Prompt/profile evaluation remain later work.
- Video evidence, general-purpose artifact distribution, and reusable build packages are not implemented.
