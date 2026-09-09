# Repository Scheduling Limits and Operational Diagnostics

Status: superseded proposal; not implemented. The
[scheduling implementation plan](2026-09-07-scheduling-implementation-plan.md) replaces this
document's persistence, deferred-activation, Legacy scheduling, and retry-admission design.
The current plan uses real existing Jobs plus operational admission rows. Do not implement the
separate deferred execution-intent structures or automatic retry overage described below.
This retained proposal provides historical rationale for one remaining slice of the
[validation platform roadmap](2026-09-06-validation-platform-roadmap.md). It does not mark the
full roadmap complete or change the acceptance boundaries in the
[implementation ledger](../handoff/2026-09-07-validation-platform-implementation.md).

## Existing behavior

M17 already provides bounded, persistent repository rotation when converting pending validation
requests into queued jobs. Its sequence prevents repeated examination of the same blocked request
within a batch. Extend this dispatch path rather than introducing another scheduler service.
See [validation-dispatch.ts](../../apps/server/src/database/validation-dispatch.ts).

Execution claims have different behavior. `claimLease` applies Worker slot limits and
`concurrency_key` exclusion, then selects globally by priority, retry time, creation time, and ID.
There is no configured global or repository execution limit. PR jobs have higher priority than
Issue jobs, so dispatch rotation alone does not guarantee execution fairness. Claims now check
`managed_repositories.enabled` inside the same `BEGIN IMMEDIATE` transaction: queued and retrying
jobs for disabled repositories are held while other eligible candidates remain claimable. Existing
leases continue, and enabling the repository allows held jobs to resume. This includes disabled
discovered repositories; legacy jobs with no managed repository row remain compatible. See
[repository pause claims](2026-09-07-repository-pause-claims.md) and
[database-worker.ts](../../apps/server/src/database/database-worker.ts).

## Proposed policy and accounting

Add `schedulingLimits` to managed repository configuration:

```ts
type RepositorySchedulingLimits = {
  maxActiveLeases: number | null;
  maxQueuedJobs: number | null;
};
```

Finite values must be bounded positive safe integers. The proposed migration and omitted-field
default is `null`, meaning no additional repository limit. This preserves existing behavior; it is
not a user-selected production capacity policy. Continue using `enabled` for repository pause.
This slice does not introduce daily execution, monetary, publication, or model quotas.

| Measure | Definition |
| --- | --- |
| Active leases | Every `run_attempts` row whose status is `leased` or `running`. |
| Queued jobs | Every job whose status is `queued` or `retry_waiting`. |
| Awaiting admission | A pending activation without a materialized job, reported separately. |
| Repository ownership | Resolve through `jobs.work_item_id` and `work_items.repository_id`. |

Count Legacy and V2 together. Counting only `review_run_job_links` would omit Legacy execution.
Jobs without resolvable repository ownership remain included in platform totals and receive an
explicit unscoped classification; an inner join must not silently discard them.

A cancellation request does not release capacity while its attempt remains active. Neither an
elapsed lease deadline nor an offline or superseded Worker releases capacity by itself. Preserve
the existing conservative accounting until completion or the reaper makes the attempt terminal.
Existing process cleanup, desktop restoration, affinity, and fencing requirements remain binding.

## Queue admission and Legacy compatibility

`maxQueuedJobs` limits admission of newly materialized jobs, not all deferred work or database
storage. Check it immediately before insertion in the same SQLite transaction. V2 requests that
cannot enter the queue retain their frozen plan and pending dispatch record with a typed queue
limit reason. A multi-profile Run may admit some requests while others wait.

Retry transitions, migration of existing backlog, and lowering a configured limit may leave usage
above the limit. Report that overage and stop new admission until usage falls. Never discard an
accepted retry or cancel existing work merely to make the counter fit.

Legacy requires additional persistence. Its ingestion transaction currently creates a queued job
directly and records the scheduling event result. Skipping insertion can consume an authorized
event without retaining executable work; throwing a capacity error rolls back ingestion instead
of establishing durable deferral. See
[github-ingestion.ts](../../apps/server/src/database/github-ingestion.ts).

Introduce a durable Legacy deferred schedule containing the immutable execution template,
requirements, exact revision, authorization epoch, source sequence, and activation identity.
Deduplicate transport replays against that identity. Commit deferral with ingestion, and extend
M17's existing repository rotation to examine these records alongside pending V2 requests.
Recheck current source and authorization before materialization. Closure or obsolescence must
produce an explicit non-dispatchable outcome.

Routing must recognize a deferred Legacy activation before considering current profile bindings.
Adding a binding while it waits must not replace its frozen Legacy intent with V2 execution.
Queue admission, job creation, epoch links, routing resolution, and deferred-record transition must
commit atomically. A retry of that transaction must not create another activation.

## Claim enforcement and fairness

Put repository pause and active-limit enforcement inside the existing `claimLease`
`BEGIN IMMEDIATE` transaction, together with candidate selection, the job state transition, and
attempt insertion. HTTP preflight or dispatch checks cannot enforce concurrent claims safely.
Use one shared accounting implementation for Legacy and V2. Preserve their existing distinct
concurrency keys; repository capacity is an additional constraint.

Lowering a limit or pausing a repository prevents new leases without implicitly cancelling active
attempts. Evaluate current operational limits on every admission and claim. Do not rewrite frozen
Run plans, prompt/profile versions, execution envelopes, or their digests. A repository version
increment caused only by limits must not invalidate an existing Run.

The scheduling milestone should close the execution fairness gap within the existing claim path: exclude saturated
repositories, rotate among eligible repositories, and apply bounded waiting-time aging or an
explicit PR/Issue service policy within each repository. The exact fairness policy requires
documented selection before implementation. A claim cursor must be separate from M17's dispatch
cursor so the two operations cannot disturb each other's progress. Candidate scanning needs a
bounded continuation strategy; repeatedly traversing a saturated or incompatible backlog must
not monopolize the SQLite owner.

## Configuration and historical audit

Reuse repository `expectedVersion`, `configure` permission, and the existing transactional audit
write. Limits, version advancement, and the authenticated audit snapshot commit together. Bootstrap
must remain a one-time import rather than overwriting operator configuration.

M23 currently validates historical repository snapshots with `ManagedRepositorySchema`. Adding a
required field there would reject old retained events. Introduce distinct strict historical
snapshot shapes for records before and after limits were introduced, and accept both in audit contracts and projections.
Preserve old audit bytes. A missing historical limit means it was not recorded, not that today's
default or current configuration was effective then. See
[configuration-audit.ts](../../apps/server/src/database/configuration-audit.ts).

## Operational diagnostics

Expose a separate scheduling diagnostic DTO rather than adding transient capacity facts to
immutable plan readiness. Include observation time, stage, current policy version, usage, limit,
and applicable retry time. Cover pause, queue or active limits, overage, retry backoff, concurrency
exclusion, absent compatible Workers, occupied Worker slots, obsolete authorization, and incomplete
bounded inspection.

Diagnostics and claims must share accounting and eligibility rules. Diagnostic reads never reserve
capacity and must not promise a future lease. Show active, queued, and awaiting-admission counts
separately in repository details, and explain waiting in both Run requests and existing Job details.
Current Run projections clear readiness reasons once a job exists, so dispatch blockers alone
cannot cover this requirement. Repository readers receive only their authorized scope; platform
Worker inventory and other repository identities remain protected.

## Implementation and acceptance

Add migration 24, shared scheduling accounting, diagnostic contracts and scoped reads. Update
managed repository persistence/routes, claim, validation dispatch, Legacy ingestion/routing, audit
compatibility, and Dashboard repository/Run/Job adapters and views.

Required regressions cover concurrent cross-Worker claims, mixed Legacy/V2 usage, cancellation and
unreaped expiry, retry and limit-reduction overage, pause after queueing, saturated-repository
skipping, and sustained PR traffic with Issue progress. Verify durable deferral replay, later
capacity recovery, source withdrawal, binding changes while deferred, and partial multi-profile
admission. Verify configuration CAS, scope enforcement, unchanged historical audit bytes, and
diagnostic/claim agreement. Extend existing claim, dispatch, ingestion, repository, and audit suites.

Run verification on `ssh test-env` unless local verification is explicitly authorized for that task.
Use isolated synthetic data and mocked or read-only upstream interactions. No test may mutate real
repository PRs or issues without explicit approval of its exact targets, operations, and content.
