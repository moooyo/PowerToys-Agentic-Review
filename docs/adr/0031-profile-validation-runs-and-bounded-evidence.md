# ADR 0031: Profile Validation Runs and Bounded Evidence

## Status

Accepted on 2026-09-07. Implementation and component verification are in progress; acceptance of
the complete Server/Worker/Dashboard flow is not established by this decision.

This ADR replaces only the inline-only evidence restriction in section 5 of
[ADR 0029](./0029-trusted-code-single-worker-and-shared-worktrees.md) and extends its execution
model. It does not restore the unpublished split Worker, installer, signed package distribution,
local RPC, or artifact-backed result compatibility designs. ADR 0025 Worker authentication and
ADR 0030 PR execution authorization remain applicable. Existing V1 envelopes and historical review
result schemas remain supported.

## Context

A repository can require static/build validation, Windows desktop UI validation, Web UI
validation, and issue reproduction. A single latest review job cannot represent their independent
outcomes. A model recommendation and a successful process exit do not establish that the required
checks passed against the submitted revision. UI findings also need attributable screenshots,
traces, and structured step evidence.

The existing trusted-code Worker, job leases, process supervision, and immutable inline results
provide a useful foundation. Extending that foundation is preferable to a separate scheduler or
an unrestricted file-upload channel.

## Decision

### Frozen run, independent profile jobs

One `ReviewRunExecutionPlanV1` freezes a repository and work-item identity, the exact revision,
authorization policy, run activation, published Prompt and profile snapshots, and required coverage.
Associated immutable request records retain the rendered execution prompts. Published bindings
affect future plans; they do not rewrite queued or running work. Repository numeric identity is
independent of its mutable display name.

Each profile request dispatches independently through the existing jobs and lease machinery.
Retain the database `job_kind` families `pull_request_review` and `issue_triage`. V2 envelopes add
`ValidationJobContextV1` with the selected workflow, target, profile, Prompt identity, plan digest,
run activation, and profile job activation. They carry only that selected profile, not the complete
run plan. Legacy envelopes continue through the legacy executor.

Runner readiness is dynamic and excluded from the immutable plan digest. A configured target is
not proof of implemented executor support. Admission and claim both require the prepared runtime's
capabilities; UI also requires its driver and evidence delivery on the same executor. Missing
profiles, prompts, scenarios, source authority, or capabilities remain explicit blockers.

### Source and activation identity

PR validation uses the authorized exact base/head pair. Issue content revision and tested source
commit are different identities. Issue-triage authority alone cannot authorize executing repository
code. Issue validation additionally requires an authenticated operator authorization bound to the
run activation, repository, issue, current issue revision, and exact selected commit. The Server
injects issuer, subject, and authorization time; clients cannot supply that authority in a request
body. PR runs retain GitHub epoch authority and do not substitute this operator authorization.

M18 numbers observed source transitions, including A-to-B-to-A, independently of whether execution
was permitted at the observation. The first selected legacy or ReviewRun route is pinned to the
work item, authorization epoch, and source sequence. Transport replay or later profile binding
must not start a second pipeline for that same activation. Independent active authorization epochs
may own separate runs for the same revision.

Creating a new run freezes a new activation and its authority. An explicitly audited rerun of one
profile within the same frozen plan creates a new job activation while retaining that plan and
source authorization. Infrastructure retries remain `run_attempts` of one job. Neither operation
rewrites earlier results or changes another profile's history.

### Validation and model work

Deterministic runners validate the original source workspace. Model review uses a distinct
workspace under the same real lease identity. Model edits or tests against repaired code cannot
certify the submitted source. Profile execution, required lifecycle failures, model review, and
cleanup have separate recorded outcomes.

`ValidationJobResultV1` keeps the Worker `ValidationReportV1`, execution details, and model review
separate. Model output cannot manufacture runner checks or finalized evidence. In particular,
`PrReviewPlanV2` advice is not a replacement for static/build runner checks. A completed execution
can correctly report failed validation.

Required coverage comes from the frozen plan. Command checks use `profileVersionId:stepId`; each
UI scenario uses one `profileVersionId:scenarioId` check, with individual actions and assertions in
its evidence. Launch completion is not a UI assertion. Unqualified PR approval eligibility requires
the current revision and plan, original source, every required runner check passed, complete
evidence, and no required-request blockers or unresolved blocking findings. Human decisions and
GitHub publication remain separate facts.

### Bounded evidence beside an inline result

The authoritative completion remains bounded inline JSON plus its digest. Add an authenticated
evidence channel for PNG screenshots, JSON step evidence, ZIP/JSON traces, and text logs referenced
by that result. This is not an artifact-backed completion mode, package distributor, video store,
or build-artifact reuse contract. UI profiles currently build their own exact source.

The single SQLite owner also owns a dedicated private evidence directory. M16 binds manifests to
repository, run, request, job, attempt, profile, revision, plan digest, and optional check identity.
The Server derives ownership and storage paths. Begin, chunk, and finalize operations enforce
Worker and lease ownership, offsets, digests, retry identity, quotas, and finalization. Current
limits include 512 KiB chunks, 64 MiB assets, 16 MiB screenshots, and 256 assets/128 MiB per attempt,
plus configured global byte/count limits and bounded retention. Interrupted uploads never become
valid evidence. Private production storage validates regular single-link file identity and content;
scoped reads do not expose host paths.

Finalized bytes are necessary but insufficient. Result reads check typed UI steps against the
frozen scenario, including target, step order and identity, actions, expected values, actual
assertions, and screenshot references. A valid digest for invented or contradictory steps cannot
establish approval eligibility. Retired, missing, or invalid evidence remains visible as incomplete
coverage rather than being treated as a passing check.

Full asset hashing and scenario parsing are isolated from the SQLite control thread. A bounded
read-only verifier returns internal proofs bound to immutable manifests, file identities, and
frozen scenarios. The database owner repeats lease, cancellation, deadline, source/result, and
retention checks after asynchronous preflight and consumes the proof synchronously. Cold result
reads preserve runner outcomes but explicitly show evidence verification pending; required pending
coverage cannot establish approval eligibility. Shutdown drains these continuations before closing
SQLite. Per-download chunk hashing remains bounded and independent of this attestation cache.

### Windows and Web environments

Windows UI Automation runs only in an active unlocked interactive session with exclusive session
ownership. Operations and screenshots stay within the launched process tree and selected owned
window. The driver does not search unrelated desktop windows or use global input as a fallback.
Stop and reset must complete before releasing capacity; uncertain restoration quarantines the
session lease. A noninteractive Windows service does not become a UI executor by setting a label.

Web validation launches the configured application, proves ownership of its allocated loopback
endpoint, and uses a separate Chromium context with navigation restricted to that managed origin.
The browser and application are supervised process trees. Readiness, deterministic scenarios,
evidence, process draining, and reset form one bounded lifecycle. Browser context isolation does
not reset application data; configured reset commands remain necessary where applicable.

These are reliability, provenance, resource, and environment-ownership controls for registered
trusted execution code. They are not an adversarial same-user, operating-system, or network sandbox.

## Consequences and verification boundary

M14-M18 add plan persistence, separate validation results, evidence storage, profile dispatch, and
source-activation routing without rewriting legacy result tables. This increases lifecycle and
storage responsibilities but preserves the established credential and lease boundaries.

Component tests, real Windows/Web driver fixtures, and eight cross-host component-assembly cases
have passed. Connected Dashboard checks also exercised evidence rendering, rerun, cancellation,
and retained history. Those cases use synthetic workspace/source callbacks and a model stub;
real-repository checkout, installed toolchains, production model execution, and the intended
deployment's restoration procedure remain acceptance boundaries. The optional model-summary
adapter is wired but disabled by default pending production model acceptance.

Repository ACLs and audit-read APIs, configured repository concurrency/quotas, revision-bound human
decisions, publication/outbox delivery, notifications, and Prompt/profile evaluations remain
separate follow-up work. Exact repository query scope is not a multi-team authorization policy.
