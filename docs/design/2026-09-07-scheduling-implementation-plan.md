# Scheduling implementation plan

Status: P0 current waiting diagnostics were delivered in M27. M28 accepted slice 2, the durable
admission foundation. M29 completes slices 3 and 4: configured limits, queue-credit recovery,
repository/class service policy, bounded claim continuation, 100,000-Job owner measurements,
and connected scope/configuration/permission acceptance. Source evidence below describes the
M25 baseline from which this plan began. See the
[accepted implementation](2026-09-07-configured-scheduling-policy.md) and
[M29 report](../../artifacts/m29-scheduling-policy-20260907/REPORT.md) for the delivered evidence.

This plan covers the scheduling portion of the
[validation platform roadmap](2026-09-06-validation-platform-roadmap.md): P0 explanations for
waiting work and P1 repository/global execution limits, queue quotas, and scheduling fairness.
It replaces the persistence and admission model in the
[earlier limits proposal](2026-09-07-repository-scheduling-limits.md). Completing scoped
diagnostics alone does not complete configured limits or fairness.

## 1. Recommended model and source evidence

Persist every structurally valid, authorized execution as a real existing `jobs` row, with its
complete immutable template and normal Job ID. Add a separate `job_admission` row that controls
whether that Job occupies the admitted execution queue. Use `pending` and `admitted` admission
states while retaining the existing Job lifecycle states. A pending Job holds no current lease
and starts no attempt while waiting; retries retain their earlier attempts. It is visibly awaiting
admission, not a fake Job, placeholder template, or lost request.

Separate Legacy/V2 execution-intent tables, Legacy routing reservations, activation receipt
versions, and a second cancellation API are not required for this capacity-waiting case. The
existing Job already stores the immutable execution intent and supports those identities.

| Inspected source | What it proves |
| --- | --- |
| `migrations/0014_review_runs.sql:tr_review_run_job_link_insert` and `review-runs.ts:associateReviewRunJobInTransaction` | A new association requires a real `queued` Job, zero attempts, matching frozen identity, and current authorization. It does not require queue-capacity admission. A pending Job satisfies this existing structural contract. |
| `validation-job-factory.ts:createValidationExecutionTemplate` | A complete published profile/prompt and valid frozen source can form the immutable template independently of current Worker availability. Missing structural prerequisites still prohibit creating a Job. |
| `migrations/0018_github_review_run_sources.sql` and `github-review-runs.ts:pinGitHubLegacyJobInTransaction` | The immutable Legacy activation requires a real Job linked to the exact epoch/revision. A pending Job can use this existing route immediately; later profile bindings cannot replace it. |
| `github-ingestion.ts:scheduleJob` | First-usable-snapshot and semantic deduplication already preserve a Job across repeated observations. Pending admission does not invalidate that identity. |
| `validation-dispatch.ts:rerunValidationRequestInTransaction` and M17 control audit | A real pending Job can retain the existing Job-bearing rerun receipt, activation number, actor-bound idempotency, and association cap. No nullable/fabricated Job ID is necessary. |
| `github-ingestion.ts:supersedeJobs` and `validation-dispatch.ts:cancelValidationJobInTransaction` | Current withdrawal, supersession, and cancellation already cover unleased `queued`/`retry_waiting` Jobs. Admission must not exclude pending Jobs from those operations. |
| `validation_dispatch_checks` and its association trigger | It tracks V2 requests that have no Job. Association correctly removes that request from the old pending set; the new admission row then tracks the real Job's capacity wait. |
| `database-worker.ts:claimLease` | Claim is serialized in `BEGIN IMMEDIATE`, currently checks M25 pause and Worker/concurrency constraints, and scans global priority pages until exhausted. Add admission and limits here; a page size of 100 is not a total transaction bound. |
| Production source search | There are two Job insertion implementations: Legacy `scheduleJob` and V2 `insertJob`; initial dispatch and rerun share the latter. Retry transitions occur in `failLease` and `reapExpiredLeases`. These are the required admission entry points. |
| `review-run-queries.ts:summary/detail`, `dashboard-queries.ts` | Current projections count every queued/retrying Job together and clear readiness reasons once a Job exists. They must expose admission separately, rather than changing only quota SQL. |
| `configuration-audit.ts:project` and contracts `ConfigurationAuditEventSchema` | Historical repository snapshots currently use today's `ManagedRepositorySchema`; extend history with explicit strict old/new snapshot shapes. |

There remains a real distinction between two kinds of waiting:

- **No legal Job can be constructed:** an incomplete frozen V2 profile/prompt/source remains in
  existing `validation_dispatch_checks`. Never manufacture an invalid execution template.
- **A legal Job exists but cannot be scheduled yet:** persist it once and use `job_admission`,
  including queue pressure, pause after creation, and currently unavailable runtime prerequisites.

Creating or associating a new Job still requires current exact-revision authorization and an
enabled repository under existing guards. A request blocked before that point stays in the old
pending-request path. Capacity exhaustion itself is not a structural or authorization failure.

## 2. User-visible semantics and operational limits

Add the same strict limit object at repository and platform scope:

```ts
type SchedulingLimits = {
  maxActiveLeases: number | null;
  maxQueuedJobs: number | null;
};
```

Use shared finite bounds: active limits 1..65,535 and queued limits 1..1,000,000, with safe-integer
validation in contracts and SQL. These are representational bounds, not recommended deployment
settings. Null means no additional limit at that scope. Zero is invalid; repository `enabled`
remains pause. A null repository limit still obeys finite global limits and Worker constraints.

Migrate all limits to null. Preserve repository PATCH omission; an explicitly supplied complete
limit object replaces its two fields, and null fields remove those limits. Repository changes use
existing `expectedVersion`, `configure` permission, and transactional audit. Platform changes have
their own CAS version and require platform administrator access. Bootstrap is one-time; environment
configuration must not overwrite saved settings on restart.

| Dimension | Exact definition |
| --- | --- |
| Active leases | Every `run_attempts` row whose status is `leased` or `running`. Count attempts, not distinct Jobs or Run associations. |
| Admitted queue usage | Jobs in `queued` or `retry_waiting` whose current admission episode is `admitted`. This is what `maxQueuedJobs` limits. |
| Awaiting admission | Jobs in `queued` or `retry_waiting` whose current admission episode is `pending`. They remain accepted, durable, visible, and cancellable. |
| Awaiting valid configuration | Existing pending V2 requests without a Job. Report separately from pending Job admission. |
| Overage | `max(0, usage - limit)` for finite limits, including migrated backlog or a lowered limit. |

`jobs.status = 'queued'` remains an existing execution-lifecycle value; it no longer alone proves
queue admission. Add explicit admission fields to public Job/Run projections and derive their
display state. The Dashboard must say `Awaiting admission` for pending Jobs, while `Queued` means
admitted and waiting for a claim. Add separate counters rather than silently omitting pending
Jobs from operational totals. Existing lifecycle status filters may keep their documented meaning,
but add an admission filter when the UI offers the narrower queue view.

`maxQueuedJobs` limits a schedulable buffer, not the number of accepted Job records, database
storage, daily executions, model spending, or evidence bytes. This definition is an explicit
capacity policy, not an implementation trick to make a quota test pass. The previous separate-intent
design also left accepted deferred work unbounded; representing it as a real Job does not create a
new storage guarantee. Show both admitted and pending usage so operators can see the full backlog.

Attempts still count while cancellation is requested, their lease deadline has passed but they
are unreaped, or their Worker is offline/superseded. Only a terminal attempt transition releases
capacity. Keep existing process cleanup, affinity, desktop restoration, and fencing requirements.
Changing admission never authorizes reuse of an uncleared desktop or release of an active lease.

Limits and service ordering are current operational policy. They must not rewrite frozen Run
plans, profile/prompt versions, templates, original priority fields, envelope digests, source
authorization, or result history. A limit-only repository version change does not invalidate an
existing Run. Creating a new plan may still require current configuration CAS.

## 3. Minimal complete persistence

Use six new tables, plus nullable limits on `managed_repositories`. Combine operational data
that has the same lifecycle; do not duplicate execution intent already present in Jobs.
The small scheduling singleton remains separate from M17's validation-request inspection state
because the new counters serve both Legacy and V2 Jobs. Adding independent columns to the M17
singleton is a valid future simplification, but reusing its inspection counter is not equivalent.

| Table | Required role and fields |
| --- | --- |
| `job_admission` | Job FK/PK; `state` pending/admitted; `attempt_base`; queue-episode sequence and requested time; admitted time; stable upstream repository bucket/ownership state; last checked time/reasons and bounded recheck metadata. Carries the small ownership and ordering projection, avoiding separate Job metadata/order tables. |
| `scheduling_state` | Singleton safe-integer queue-episode, successful-admission, and successful-claim sequences. Separate from M17's inspection sequence. Exhaustion fails explicitly. |
| `repository_scheduling_state` | Stable bucket PK; distinct last successful admission/claim tickets; distinct saturating PR-service streaks for admission and claims. One table, two independent service policies. |
| `claim_scan_state` | Worker node/instance/protocol/capability digest, bucket/class, primary or recheck cursor, captured queue high-water mark, and bounded completion/recheck fields. Progress is operational and persistent; it is neither a lease nor immutable evidence. |
| `platform_scheduling_configuration` | Singleton version, both nullable limits, fixed policy ID `repository-service-v1`, update time. Default null once. |
| `platform_scheduling_configuration_audit` | Immutable authenticated actor, old/new version, exact configuration snapshot, timestamp, ID; reject update/delete/replacement. Platform-only reads. |

Keep Job identity, execution JSON, requirements, activation number, semantic/concurrency keys, epoch
links, M18 routes, rerun receipts, and cancellation receipts in their existing tables. Do not copy
those payloads into admission rows. Do not add a new activation identity to the HTTP API.

`attempt_base` is the Job's `attempt_count` for the waiting episode that received admission. Claim
requires it to equal the candidate's current attempt count. Grant increments Job attempt count
under the existing transaction. A later retry must obtain a new episode for that new count;
an old admitted bit cannot accidentally authorize another attempt after a missed retry hook.

Add indexes for pending selection by bucket/episode and admitted Jobs by bucket, and an exact
attempt `(job_id, status)` accounting join where the measured SQL plan needs it. Ownership and
queue episode are protected operational projections, not fields supplied by operator HTTP bodies.
A missing/inconsistent row is an integrity error, never an implicit admitted default.

Add database guards for admission identity/replacement and for lease transition: only a matching
admitted episode can authorize `queued`/`retry_waiting` to `leased`. Admission state changes and
credit recovery must require an unleased waiting Job; they cannot modify the admission of an
active attempt. Install those guards after deterministic migration backfill. The trusted helper
and guards complement each other rather than relying on every caller to remember a predicate.

### Ownership

Use stable GitHub numeric repository identity for scheduling buckets, resolving current managed
configuration by that ID. Verify associated work-item and frozen template identity agree. M25
already checks parsed template identity for unassociated Legacy Jobs; those Jobs must charge the
same repository capacity. Rename, transfer, or later management must not create a new bucket.

A genuinely unresolved identity uses one explicit unscoped bucket and still counts globally.
A known associated repository remains chargeable even if the template is corrupt. Conflicting
active ownership that makes exact repository accounting impossible blocks new claims with an
integrity diagnostic; it does not erase the active attempt. Invalid queued templates retain
existing dead-letter behavior and cannot bypass limits.

Accounting and read authorization are separate. Inferring an unassociated Legacy Job's bucket
does not grant a repository reader access to that Job; current platform-only Legacy access remains.

### Migration

Backfill every existing Job with an operational admission row. Existing waiting Jobs start
admitted, preserving their execution eligibility and historical queue backlog; null defaults add
no new capacity restriction. Existing active/terminal Jobs retain their lifecycle and attempts.
Use an explicit migration basis for any introduced admission timestamp; do not present migration
time as evidence of when an old Job originally entered a queue. For waiting Jobs `attempt_base`
equals current attempt count; for an active episode it reflects the pre-grant count, so a future
retry still requires its normal new episode. Terminal Jobs cannot claim regardless of admission.

Populate ownership without changing any existing Job/template/audit bytes. Validate bounded
payloads with the production parser during the upgrade/backfill process, retaining explicit
invalid/unscoped classification instead of losing rows. Claims must not start against a partially
backfilled database. Do not alter M14 association, M17 immutable control receipt, or M18 routing
tables just to accommodate capacity waiting: their current invariants already fit this model.

## 4. Acceptance, admission, retry, and cancellation

Introduce shared helpers in `database/scheduling-admission.ts` and
`database/scheduling-accounting.ts`. Job acceptance and queue admission are separate operations.

### New Jobs

Inside the existing ingestion or V2 creation transaction:

1. Validate the complete frozen template, exact source, and current authority as today.
2. Insert the real Job and its `pending` admission episode together.
3. Perform normal epoch/Run associations and Legacy/V2 activation pinning. Keep existing semantic
   deduplication and first-usable-snapshot behavior.
4. Record the existing receipt containing the real Job ID. Queue pressure is not an ingestion
   error and cannot roll back an otherwise valid accepted event.
5. Optionally run the shared fair admission selector. The newly created Job is admitted only if
   it wins the same policy used for all older pending Jobs; there is no owner-specific fast lane.

Legacy transport replay resolves the same Job and existing M18 route even while pending. Adding
a profile binding cannot replace it with V2. Rerun uses the existing actor-bound activation ID,
sequential Job activation, and immutable Job-bearing receipt. A second rerun is blocked by the
existing live-Job query because a pending Job remains unstarted `queued` work. Existing association
limits count it naturally. A 201 response can accurately mean the real Job was created; clients
read its admission state rather than assuming execution started. No new 202 receipt schema or
pending-activation cancellation endpoint is necessary.

For V2, distinguish structural readiness from current Worker availability. The factory and
association code already separate those concepts. Missing profile/prompt/valid source stays in
the old no-Job pending request; absent compatible runtime can produce a valid pending Job with
its exact immutable requirements. Never relax structural validation just to produce an ID.

### Admission

Only the shared selector may change a waiting episode from pending to admitted. Inside one
`BEGIN IMMEDIATE`, it rechecks scope/current source, authorization, pause, structural integrity,
relevant runtime support, current queue usage at both scopes, and fairness. A successful admission
updates its service ticket and state together. It neither consumes an attempt nor assigns a Worker.

The admitted queue should contain work that can progress under known supported execution paths.
Do not admit an unsupported target solely to consume a scarce global buffer slot. Current Worker
slot occupancy is normally why a queue exists, so occupied slots alone do not forbid admission.
Runtime inspection must be complete before asserting that no compatible execution path exists.

All production insertion sites use this authority. An immediate dispatch of all profiles in one
new Run must not refill each free queue slot ahead of older pending repositories. Multi-profile
Runs may have independent admitted and pending Jobs, retaining the same frozen requests.

### Queue-credit recovery

A finite global queue creates another fairness boundary. With a limit of one, A can occupy the
only admitted slot and then be paused or lose its only compatible Worker. B must not wait forever
behind that unusable queue reservation while B's execution path is available.

Treat admission as revocable for unleased waiting Jobs. A bounded reconciliation pass can return
a proved unschedulable admitted episode to pending, preserving its Job ID, episode identity,
original waiting age, template, M18 route, and receipts. Re-admission uses the same fair selector.
Never demote a leased/running/cancel-requested Job; active capacity is independent. Do not demote
merely because Workers are busy or an inventory scan is partial.

When finite queue capacity prevents an otherwise progressing repository from entering, the
selector must also consider repository-specific active-limit blockage rather than indefinitely
parking every global queue slot behind an already saturated repository. Reconcile the affected
unleased reservations before admission, without cancelling their Jobs. A full global active pool
is a shared execution limit, not a reason to churn every admission reservation. Apply this policy
consistently to repository and global queue limits and show the current hold reason.

This is a fairness/capacity transition, not an execution retry or cancellation. It needs no separate
intent table. Keep it bounded and transactionally ordered with new admission; changing configuration
must not eagerly rewrite a million Job rows inside its CAS transaction. Reconciliation may continue
in finite batches, and pending diagnostics should identify that work honestly.

### Retry

`failLease` and `reapExpiredLeases` must update admission in their existing terminal-attempt
transaction whenever they transition a Job to `retry_waiting`. Preserve the Job/template,
attempt history, retry time, retry policy, max attempts, and affinity. Create a new pending episode
whose `attempt_base` matches the unchanged Job attempt count and whose sequence is new. It then
competes fairly for admission; backoff remains enforced even if it becomes admitted earlier.

This explicitly changes retry queue accounting from automatic re-entry to durable re-admission.
It does not discard an accepted retry or fabricate a new Job. Migration and lowering limits can
still yield overage; ordinary new retries need not create quota overage. Report that policy change
and test it instead of retaining an accidental implicit retry bypass.

Terminal replay returns the original terminal response without creating another admission
episode. A failed transaction leaves both attempt/Job/admission state unchanged. Add a claim SQL
guard and a lease-transition integrity guard so missing/stale admission cannot grant a lease even
if a future insertion or retry path forgets the helper.

### Source withdrawal and operator cancellation

Keep current `supersedeJobs` and cancellation predicates broad enough to include pending Jobs.
They become stale/cancelled normally; usage queries count only waiting lifecycle states, so a
terminal pending row cannot retain queue or awaiting-admission usage. Admission reconciliation
and actual claim recheck current lifecycle/authority before granting anything.

Preserve multiple-epoch authorization: withdrawing one of several active links does not revoke
work still covered by another applicable epoch. A source revision moving away and back has a
new source sequence under M18; old waiting Jobs cannot be silently reactivated against it.

## 5. Fairness and bounded owner work

### Repository and work-class policy

Use persistent least-recent-successful-service tickets across repository buckets, separately for
admission and claims. Only successful service advances a bucket's ticket. Pause, saturation,
incompatibility, and incomplete inspection do not. A new bucket starts at the current service
sequence so continually arriving repositories cannot jump ahead of existing waiters. An idle
bucket retains one old ticket, not accumulated unlimited credit.

Do not use one global repository-ID cursor for execution. Interleaved claims from an A/B/C-capable
Worker and an A/C-only Worker can repeatedly move that cursor past B. Service tickets keep B old
while A/C advance, allowing the next compatible Worker to prefer B.

Within each bucket, maintain a saturating PR streak 0..2 for each service stage. Increment on PR
service; reset only on Issue service. At two PR grants, an eligible Issue gets the next compatible
repository turn. A PR-only Worker may keep working when it cannot execute an Issue, but it must
not erase the Issue debt. An Issue-only or PR-only backlog remains work-conserving. Both Issue
triage and validation belong to the Issue class; PR static/build and UI belong to the PR class.

The recommended 2:1 policy preserves existing PR preference while bounding Issue starvation.
It governs starts on compatible service opportunities, not CPU time, monetary cost, or every
third fleet-wide claim. Non-preemptible execution and unavailable prerequisites still matter.

For claims, preserve original priority in the envelope while limiting its ordering advantage:

```text
readyAt = max(queueEpisodeRequestedAt, nextAttemptAt)
priorityBoostMs = clamp(originalJobPriority, 0, 100) * 6_000
rankAt = readyAt - priorityBoostMs
withinClassOrder = rankAt ASC, queueEpisodeSequence ASC, jobId ASC
```

Later arrivals beyond the ten-minute boost cannot indefinitely overtake an older eligible Job.
This stable rank supports keyset continuation. Retry receives a new episode; diagnostic reads,
unsuccessful scans, and temporary admission-credit recovery do not reset its waiting age. Pending
admission uses repository/class service policy and oldest accepted episode first within each class.

### Claim and continuation

Extract current eligibility into `database/scheduling-eligibility.ts`, shared by claims and
diagnostics. Preserve credential/Worker/protocol/capability-digest checks, Worker max slots,
available-slot input, retry time, attempt limit, affinity, concurrency key, template/schema checks,
M25 pause including discovered repositories, prepared V2 labels, and profile requirements. Add
current admission and exact active limits in the existing immediate lease transaction.

Initially bound each claim to 128 template/capability inspections, in small rounds over at most
16 repository candidates. Persist Worker-instance/capability-specific keyset progress with a
captured queue-episode high-water mark; do not restart at the same incompatible first page.
New episodes enter a later finite pass. Capabilities/instance changes invalidate their relevant
compatibility state, while unrelated heartbeats do not restart all scans.

Partial inspection of an older bucket need not prevent useful work elsewhere, but its continuation
retains priority. Once eligible candidates are found, apply service tickets and class debt to the
known candidates. Incomplete Issue inspection is not evidence that an Issue turn may be discarded.
Budget exhaustion returns bounded `no_work`/retry, retains progress, and records partial inspection;
it does not claim the entire queue lacks compatible work.

Use compact affected-key recheck cursors in the same scan-state table for concurrency release,
affinity, backoff due time, and admission changes. Do not materialize a recheck row for every
matching Job in a heartbeat/release transaction. Reserve primary-pass progress while servicing
rechecks, initially 96/32 inspections with unused budget transferable. Global/repository counts
and Worker slots remain fresh scalar gates. Revalidate all actual grant predicates in the same
transaction as Job lease transition and attempt insertion.

Extend the existing bounded M17 dispatch pump: first materialize structurally valid pending V2
requests, then reconcile/admit real Jobs through shared service ordering. Admission and claim
use separate successful-service counters; M17 inspection progress does not imply either service.
Use existing Server lifecycle/background ownership with coalesced wakes on accepted Jobs, retry,
capacity release, relevant Worker changes, enable, and limits. The lease-reaper timer remains a
fallback; failed reaping must not permanently strand pending admission. No new scheduler process
or service is needed. Shutdown stops wakes and drains the owned bounded operation before SQLite.

Fairness acceptance assumes recurring claims by a compatible Worker, eventual capacity and
prerequisite stability, and finite older work in each captured pass. Tests must cover sustained
new arrivals and heterogeneous Workers under those assumptions. It is not a guarantee during
permanent global outage, explicit pause of the waiting repository, or unrecoverable desktop hold.

## 6. Exact accounting and historical immutability

Use shared indexed exact SQL counts joining `job_admission`, Jobs, and attempts. Do not parse all
execution JSON for every claim or infer ownership only from Run links. Read/check usage in the
same transaction that admits or leases. Diagnose unscoped usage explicitly. Start with exact
queries rather than extra mutable counter tables; the large-fixture latency gate below decides
whether a transactional, rebuildable counter projection is actually required.

Lowered limits stop new admission/grants without implicitly cancelling or preempting existing
work. Preserve visible overage. Queue-credit recovery is based on scheduling holds and fairness,
not a hidden deletion of excess accepted work to make a counter look compliant.

Before extending `ManagedRepositorySchema`, define fixed strict
`RepositoryConfigurationSnapshotV1Schema` with the exact current fields and V2 with required
`schedulingLimits`. Do not derive historical V1 using `Omit` of an evolving live DTO. Both variants
retain `additionalProperties: false`; malformed new fields cannot fall through to an old shape.
Update contracts and database `configuration-audit.ts:project`, retaining identity/version,
reviewer pairing, timestamp, and byte-limit validation. Existing audit JSON bytes are unchanged.
Old snapshots show `Not recorded in this snapshot`, not today's limits or assumed unlimited.

Repository limit changes use the existing `updated` audit action in the CAS transaction. Global
settings have their own small immutable audit table and strict contract; do not masquerade as
prompt/repository events. Existing `ReviewRunRepositorySnapshotSchema` stays unchanged. No
current-limit comparison may require an old Run's frozen configuration version to equal today's
version at dispatch or claim.

## 7. Scoped diagnostics and public contracts

Add `packages/contracts/src/scheduling-diagnostics.ts` and export strict reason/observation DTOs.
They are live reads, not part of immutable plan readiness or result digests. A bounded observation
contains observation time, exact subject/scope, stage, pending/admitted state when applicable,
complete/partial inspection, current repository/platform policy versions, typed reasons, and
observed retry/recheck time. A no-Job request and a pending Job are different subject variants.

| Reason | Evidence required |
| --- | --- |
| `awaiting_admission` | Real waiting Job has a current pending episode. Refine with known admission blockers. |
| `repository_paused` | Current managed row is disabled, including discovered rows. |
| `repository_queue_limit` / `platform_queue_limit` | Exact admitted queued/retry count blocks pending admission; use restricted global details for repository-only readers. |
| `repository_active_limit` / `platform_active_limit` | Exact active-attempt count blocks a new lease, retaining cancellation/unreaped attempts. |
| `retry_backoff` | Exact future `next_attempt_at`; not an estimated execution start. |
| `concurrency_busy` / `affinity_worker_unavailable` | Existing concurrency holder or required node constraint; do not reveal foreign holder/node identities. |
| `no_registered_worker` / `no_compatible_worker` | Complete relevant bounded inventory proves absence or incompatibility; partial scans cannot prove absence. |
| `compatible_worker_unavailable` | A compatible registered Worker is offline/draining/disabled/revoked/superseded. |
| `worker_slots_occupied` | Matching active instances have no Server-counted slot. |
| `worker_capacity_unavailable` | Last heartbeat reports zero local slots despite remaining Server-counted slots. Today's protocol does not explain the local cause. |
| `authorization_changed` / `source_obsolete` | Current exact source/epoch/policy observation; distinguish restorable holds from terminal obsolescence. |
| `plan_prerequisite_missing` / `invalid_job_configuration` | Existing structural prerequisite or validated template/identity failure. A read does not repair/dead-letter a Job. |
| `inspection_incomplete` | Bounded inventory/candidate work is partial; do not invent an availability guarantee. |

An eligible observation means no blocker was observed at that time, not reserved capacity, a
guaranteed next position, or an ETA. Display `Waiting for a Worker claim` when appropriate.
Multiple proven blockers may coexist in a stable order. Limit reasons to 32, canonical times,
bounded requirement names, strict response bytes, and finite batch sizes.

Use the claim's shared rules for reasons labeled as enforced claim gates. Current `claimLease`
does not call dispatch's `assertCurrentAuthorization`; source/authorization observations must
not be falsely described as a currently enforced claim check. If added to claims, implement the
same gate in both paths and preserve unassociated Legacy and multi-epoch behavior.

Worker diagnostics use committed heartbeat observations; the next claim supplies its own fresh
available-slot value. Show age. Current heartbeat has state/disk/memory/slots, not structured
missing-credential or locked-desktop causes. Do not invent those causes or treat repository
metadata connectivity as private-checkout readiness. Richer prepared-runtime health is a separate
versioned protocol extension, not something inferred by this diagnostic read.

### API and authority

Use new `routes/scheduling.ts`, `bindOperatorDatabase`, explicit `operator-request.ts` rules,
`protocol.ts` operation map, and `database-worker.ts` dispatch. Internal RPC registration does
not make an operation operator-accessible. Authorization and the final scope/policy/usage read
share a synchronous read snapshot; no transaction spans external probes or evidence hashing.

| Route | Owner operation and permission |
| --- | --- |
| `GET /api/v1/operator/repositories/:repositoryId/scheduling` | `getRepositorySchedulingStatus`; repository read, exact scoped counters and limits. |
| `GET /api/v1/operator/repositories/:repositoryId/jobs/:jobId/scheduling` | `getRepositoryJobScheduling`; repository read plus exact associated Job ownership. |
| `GET /api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/requests/:requestId/scheduling` | `getValidationRequestScheduling`; repository read plus exact Run/request relationship, no-Job or latest Job state. |
| `GET /api/v1/operator/scheduling` | `getPlatformSchedulingStatus`; platform administrator, including global/unscoped usage. |
| `PATCH /api/v1/operator/scheduling` | `updatePlatformSchedulingConfiguration`; platform administrator, CSRF/origin/read-only guard and CAS audit. |
| `GET /api/v1/operator/scheduling/jobs/:jobId` | `getPlatformJobScheduling`; platform administrator, including unassociated Legacy Jobs. |
| `GET /api/v1/operator/scheduling/activity` and `/activity/:eventId` | Bounded platform scheduling audit list/detail; platform administrator. |

Keep existing rerun and Job cancel routes/contracts. A pending Job already has everything those
operations need. Repository readers get their exact usage/limits, own requirement names, and
coarse global-capacity state. Do not return global counts, foreign repositories/holders, Worker
names/node IDs, tokens, raw capabilities, or templates. Distinguish restricted capacity details
from null/unlimited using a strict visibility union. Revalidate after asynchronous preparation;
scope switching or access revocation must not retain a previous authorized response in the UI.

The existing `getJob` SQL inner-joins work items, even though platform authorization understands
unassociated Legacy Jobs. The new platform scheduling read must query such Jobs directly; do not
promise their visibility through the current Job detail endpoint without extending that contract.

## 8. Frontend and precise edit map

| Area | Required changes |
| --- | --- |
| Contracts | `platform-configuration.ts`: limit schema/current repository DTO/PATCH. `configuration-audit.ts`: fixed old/new snapshot union. `dashboard.ts` and `dashboard-runs.ts`: explicit admission on Job reads and distinct awaiting-admission counts. New scheduling DTOs and exports. Existing `dashboard-runs-action.ts` Job-bearing receipts remain sufficient. |
| Persistence/claim | New accounting/admission/eligibility/diagnostic helpers; `database-worker.ts` claim, `failLease`, reaper; both Job insertion helpers in `github-ingestion.ts` and `validation-dispatch.ts`; migration/default/backfill/index/lease integrity guards. |
| Configuration | `managed-repositories.ts`, database/contracts `configuration-audit.ts`, `routes/repositories.ts`, new scheduling routes, `operator-request.ts`, `protocol.ts`, app route registration, global config/audit handler. |
| Read projections | `review-run-queries.ts:summary/detail` and Job columns; `dashboard-queries.ts` Job/Work Item projections and `getSystemSnapshot.oldestQueuedAt`. Distinguish admitted queue, pending admission, and no-Job prerequisites consistently. Pending execution must still block required approval. |
| Scheduler lifecycle | Extend `validation-dispatch.ts` pending materialization and fair admission pump; existing `background/lease-reaper.ts` fallback and owned coalesced wakes. Keep cancellation/supersession predicates inclusive of pending Jobs. |
| Services | New `apps/dashboard/src/services/scheduling/{adapter,http-adapter,sample-adapter,validation,index}.ts`; update repository and review-control DTO mappings. Strict scope, bounds, counts, and time validation. No sample fallback on production failure. |
| Repository UI | `pages/Repositories/form.ts` and `index.tsx`: Scheduling group, Unlimited toggles, finite inputs, CAS/dirty-form behavior, active/admitted/pending/no-Job counts and overage. Lowering below usage is allowed with an explanation of current behavior. |
| Run/Job UI | `components/ReviewRuns/RunDetails.tsx`, `RequestActions.tsx`, `components/JobDetails/index.tsx`: visible awaiting-admission state/reasons, existing cancel/rerun actions using the real Job ID, frozen readiness separate from live scheduling. |
| Queue/System UI | `pages/Jobs/index.tsx`: admission filter and complete detail explanation; bounded current-page summary if necessary. `pages/System/index.tsx`: platform-only global limits, unscoped usage, policy description, audit. Keep PR/Issue workspaces separate. |
| Configuration history UI | `components/ConfigurationAudit/index.tsx` and service validators: old snapshots show limits were not recorded, new snapshots show exact values. Preserve existing source scopes and pagination. |

Refresh visible waiting details at the existing five-second cadence, cancel obsolete queries, and
scope keys by repository/Job/request. Invalidate affected reads after save/cancel/rerun. Refresh
does not synchronize GitHub, create a rerun, reserve capacity, or advance scheduling cursors.

## 9. Delivery slices

1. **P0 current waiting diagnostics:** extract existing eligibility without changing it, add scoped
   observations/API/UI for queued/retry and no-Job requests, preserve M25 and partial-inventory
   honesty. This can land before P1 but does not claim limits/fairness are complete.
2. **Admission foundation:** add/backfill `job_admission`, update both insertion and retry paths,
   enforce admission in claim, and expose explicit waiting state throughout API/UI. Null limits
   preserve capacity defaults. Verify existing routes, M14/M18, replay, cancel, and source handling.
3. **Configured limits and complete service policy:** add repository/global CAS/audit, exact counts,
   fair admission with queue-credit recovery, fair claims/class debt, and bounded persistent scans.
   Activate editable queue limits only once every creation/retry path obeys them. Keep migration
   steps deployable; a temporary all-unlimited mode is not final P1 acceptance.
4. **Integrated acceptance:** affected contracts/domain/Server/Dashboard checks plus real scoped
   browser cases against synthetic data. Demonstrate at least two repositories, both work classes,
   quota pressure/recovery, pending rerun cancellation, and old audit reads. Record final source
   and artifact digests, pass/fail/skip counts, fairness traces, and owner latency observations.

Extend existing `validation-claim`, `validation-dispatch`, `github-ingestion-replay`,
`github-review-runs`, `managed-repositories`, configuration-audit migration/integration,
`operator-request`, access integration, route, repository form/adapter, Run action/permission,
and configuration-audit UI suites. Add focused admission/fairness/continuation tests with
independent expected traces, rather than copying the selector into the expected-value code.

## 10. Required regression matrix

| Area | Required evidence |
| --- | --- |
| Complete insertion coverage | Legacy and V2 initial/rerun create a real Job plus pending row atomically. No admitted default for missing rows. M14 association, M18 pinning, and existing receipt schema pass unchanged. |
| No structural fiction | Missing frozen profile/prompt/source produces no Job and retains existing pending request. Runtime availability can leave a structurally valid Job pending without changing its frozen requirements. |
| Replay and routing | Legacy event replay and rerun lost-response replay resolve the same Job/actor/activation. Binding changes during pending admission cannot switch Legacy/V2 mode or templates. Existing old receipts and routes remain byte-identical. |
| Retry episodes | Both `failLease` and reaper enter a new pending episode with unchanged Job ID/template/backoff/max attempts/affinity. Old admitted episode cannot authorize it. Terminal replay creates no episode. Transaction failure rolls back all transitions. |
| Atomic execution limits | Two Workers race for one global or repository slot; exactly one lease. Other unsaturated repositories remain runnable. Attempts, Job state, admission, and service ticket commit or roll back together. |
| Ownership and release | Mixed Legacy/V2 and unassociated Legacy charge the correct bucket. Rename/transfer/later management do not split usage. Cancellation-requested, offline/superseded, and expired-but-unreaped attempts still count until terminal. |
| Queue limits | Only admitted waiting Jobs count toward queue quota; pending counts remain visible. Due and future-backoff admitted retries count. Limit reduction/migrated overage does not cancel/drop work. |
| Credit recovery | Global queue size one: A admitted then paused/unsupported/scope-saturated, B can progress. A returns to pending with identical identity/episode/age and later re-admits. Busy slots and partial inventory do not trigger speculative demotion. Active leases are never demoted. |
| Source and cancellation | Pending and admitted Jobs both stale/cancel normally. One of several active epoch withdrawals preserves remaining authority; total withdrawal/closure stops execution. Revision away-and-back uses a new source sequence. |
| Rerun and partial Run | Pending rerun has normal Job ID, consumes the normal association number/cap, blocks another live rerun, and cancels through the existing route. One Run may contain admitted and pending profiles without false completion or approval. |
| Admission fairness | Continuously arriving A cannot refill each queue slot ahead of pending B. Repeat with Legacy/V2/initial/rerun/retry mixtures and arrivals during a bounded pass. |
| Claim fairness | Continuous backlog across repositories progresses; new repositories, pause/resume, and restart do not reset service history. Interleaved A/B/C versus A/C-only Workers still let B progress. |
| Class and priority fairness | Continuous compatible backlog respects PR:Issue 2:1 service. PR-only claims retain Issue debt. Both Issue workflows progress. High-priority arrivals beyond the finite boost cannot overtake an older eligible Job forever. |
| Scan bounds and progress | More than 128 incompatible Jobs, more than 16 repositories, continuous arrivals, restart, and affected-key rechecks. Each RPC stays bounded and reaches later compatible work; partial Issue scanning never erases debt. |
| Diagnostic agreement | Enforced reasons match actual admission/claim rules at the same observed state. Reads mutate no Job/attempt/admission/service/scan state. Partial observations do not claim absence or reserve a lease. |
| Worker observation limits | Distinguish no/incompatible/offline/draining/revoked Worker, occupied Server slots, and zero reported local slots. Do not fabricate locked-desktop or credential explanations unsupported by heartbeat data. |
| Scope | Repository A cannot query B with substituted Job/Run/request IDs; unassociated Legacy/global details need platform authority. No foreign names/IDs/raw capabilities/secrets/global usage leaks. Revocation and repository switching clear stale authorized data. |
| Configuration and history | CAS conflict, null/omission/zero/negative/overflow, one-time bootstrap, rollback of configuration/audit. Strict V1/V2 audit shapes preserve exact old bytes, timestamps, list order, and all frozen execution/result digests. |
| Projection semantics | Run counters, queue filters, Work Item display, Job details, System oldest queued time, and repository usage agree on admitted versus pending/no-Job. Pending required coverage cannot qualify for approval. |
| Browser acceptance | Save limits, see concrete pending reasons, reclaim a paused queue reservation, observe another repository progress, restore capacity, rerun/cancel a real pending Job, read an old pre-limits audit event. |
| Scale/lifecycle | Large isolated fixtures including 100,000 queued Jobs: record query plans, inspection counts, claim duration, heartbeat/cancel latency. No all-history JSON parsing or unbounded owner loop. Shutdown drains one owned scheduler operation and prevents late wakes. |
| External side effects | Synthetic databases/mocked upstream or read-only live metadata only. No PR/Issue comments, reviews, labels, assignments, creation, state changes, or merges without exact user approval. |

Verification uses `ssh test-env` unless local checks are explicitly authorized. This task has
local and test-env authorization, while production SQLite/storage acceptance remains on Linux
under the current execution plan. Neither authorization permits live repository mutations; follow
[AGENTS.md](../../AGENTS.md) for any separately proposed exact target/action/payload approval.

P1 completion requires the whole model: durable accepted work, explicit admission semantics,
configured global/repository limits, every insertion/retry path, usable queue-credit recovery,
cross-repository/class fairness, bounded owner work, scoped diagnostics/UI, and immutable history.
These changes do not prove unrelated model isolation, Windows/Web execution coverage, publication,
notifications, or prompt/profile evaluation.
