# Evaluation execution SQL integration

Status: source-inspection design for M28, not an implementation or verification claim.
This document describes the schema produced by migrations 1 through 27 and the strict
execution contracts in `packages/contracts/src/evaluation-execution.ts`. No database,
test, build, runtime probe, or external PR/Issue mutation was executed for this analysis.

## Rebuild boundary

Only `review_runs` requires a table rebuild to admit the existing V2 execution contract.
Its M14 `request_epoch_id TEXT NOT NULL` and `plan_json` V1 discriminator are the blockers
(`migrations/0014_review_runs.sql:10,19`). Add an explicit `purpose` discriminator and a
unique evaluation-cell reference. Preserve the old rowid, every old column value, both
existing history indexes, both old unique constraints, and all old foreign keys.

The replacement table needs two complete branches:

- `purpose = 'review'`: non-null epoch, null evaluation-cell reference, and every old M14
  V1 plan check, including `authorization.requestEpochId`, unchanged.
- `purpose = 'evaluation'`: null epoch, non-null evaluation-cell reference, exactly one
  request, strict `ReviewRunExecutionPlanV2`, explicit JSON-null `requestEpochId` and
  `testedSourceAuthorization`, evaluation purpose with trial 1 and
  `upstreamMutationPolicy = 'forbidden'`, and an operator evaluation authorization.
  Bind the run, source revision, cell, request, arm, case, suite version, authorization,
  actor, and manifest digests to the new immutable evaluation records.

The old composite `(request_epoch_id, work_item_id)` foreign key can remain. A null
evaluation epoch does not require a synthetic `request_epochs` row. Keep the existing
repository/work-item/revision foreign keys: frozen historical execution still uses the
stored exact revision identity, not the work item's latest revision.

SQL must distinguish a required JSON null from an absent field:

```sql
json_type(plan_json, '$.requestEpochId') IS 'null'
AND json_type(plan_json, '$.testedSourceAuthorization') IS 'null'
```

`json_extract(...) IS NULL` alone accepts missing properties as well. Do not implement
the branch by changing the old discriminator to `IN (V1, V2)` or globally replacing all
epoch equality checks with null-safe equality. Contract validation remains strict and
rejects unknown properties; SQL additionally binds the exact persisted, owner-validated
source, authorization, request and configuration objects. Digest-shaped strings do not
prove that those objects or permissions are authoritative.

## Exact current trigger inventory

There are 14 current behavioral triggers with direct `review_runs` references, plus the
two triggers on the parent that prohibit update and delete. The inventory below uses the
latest definition of each trigger, not its first historical definition. It matches
`apps/server/src/database/migration-rebuild.ts:90`.

| Current trigger | Latest definition | Evaluation behavior and minimum change |
| --- | --- | --- |
| `tr_review_run_request_consistency` | `migrations/0014_review_runs.sql:102` | Accept both purposes. Keep exact planned-request JSON equality and all request, workflow, target, required, Profile, Prompt and envelope-name/version comparisons. The evaluation plan must already be bound to its cell and contain its one complete published configuration. No epoch condition needs relaxing here. |
| `tr_review_run_job_links_consistency` | `migrations/0022_issue_reproduction_admission.sql:5` | Add a separate evaluation admission branch. Preserve the complete M22 ordinary branch, including all M22 reproduction/probe/UI capability extensions. Evaluation uses the frozen source and fresh operator authorization, null Job/Run epochs, strict context V2, one activation, exact cell/configuration identity, and the additional evaluation capability. Detailed predicates follow below. |
| `tr_validation_job_result_insert_consistency` | `migrations/0015_validation_job_results.sql:120` | Accept strict V2 evaluation contexts as a separate purpose branch. Existing line 143 uses `job.request_epoch_id = run.request_epoch_id`; line 156 requires V1. Preserve every attempt/result-byte/digest/current-job/link/revision/request/configuration check, the legacy-result exclusion, and anti-REPLACE guards. The V2 branch requires explicit null epochs and exact purpose/source/authorization/model-requirements equality with the admitted run. |
| `tr_job_success_review_result_consistency` | `migrations/0015_validation_job_results.sql:201` | Preserve its complete legacy and ordinary validation branches. Add evaluation success only through the matching immutable validation result, link, active attempt, run and request. Line 268's epoch `=` cannot admit evaluation. Require null Job/Run epochs and context V2 plus exact evaluation identity in the new branch. Failed assertions may still be a successfully completed execution with a valid report. |
| `tr_evidence_asset_insert` | `migrations/0016_evidence_assets.sql:70` | Accept evaluation evidence. It has no epoch or V1 discriminator and its existing run/request/Job/attempt/Profile/revision/plan binding is reusable. Preserve current lease generation, active attempt, worker identity, cancellation, supersession, upload-start and anti-REPLACE checks. Add the strict purpose/context binding predicate for evaluation defense in depth; never weaken evidence scope. |
| `tr_validation_control_audit_consistency` | `migrations/0017_validation_dispatch.sql:29` | Shared dispatch and request cancellation receipts may cover evaluations. Reject `action = 'rerun'` for an evaluation run: a second trial requires a new evaluation, not activation 2. Preserve all repository/run, anti-REPLACE and receipt/Job checks. Evaluation-wide authorization cancellation belongs to the new evaluation audit/state. |
| `tr_validation_dispatch_check_scope` | `migrations/0017_validation_dispatch.sql:77` | Accept both purposes without removing repository/run equality. Evaluation requests remain in the same fair pending queue. No epoch or schema-version relaxation is required. |
| `tr_validation_dispatch_request_pending` | `migrations/0017_validation_dispatch.sql:87` | Preserve insertion of a pending dispatch row for every new request, including evaluation. Persist the complete matrix transactionally before the scheduler can observe these rows. Do not exclude evaluations from operational scheduling. |
| `tr_github_review_run_activation_insert` | `migrations/0018_github_review_run_sources.sql:67` | Reject evaluation. Add `purpose = 'review'` to its `mode = 'review_run'` run lookup at line 84. Preserve current authorized epoch/source/revision and server-ingestion actor checks, and the existing non-validation legacy branch. |
| `tr_review_run_decision_insert` | `migrations/0021_finding_dispositions.sql:107` | Reject evaluation by adding `run.purpose = 'review'` to its run-scope lookup. Preserve all M21 receipt, stream, supersession and withdrawal checks. Evaluation adjudication uses separate records. The M20 definition is superseded by M21. |
| `tr_finding_disposition_event_insert` | `migrations/0021_finding_dispositions.sql:214` | Reject evaluation by adding `run.purpose = 'review'` to its result/run-scope lookup. Existing disposition insert/update/apply triggers remain protected through their exact event bindings. Preserve occurrence, receipt, CAS and state-stream checks. |
| `tr_publication_intent_insert` | `migrations/0026_publications.sql:98` | Reject evaluation independently of decision creation by adding `run.purpose = 'review'` to the decision/run join. Preserve anti-REPLACE and intent JSON bindings. Preview, confirmation and delivery claim must independently reject evaluation in owner code. |
| `tr_notification_event_insert` | `migrations/0027_notifications.sql:115` | Reject evaluation in this per-PR/Issue inbox table by requiring `purpose = 'review'` in the run-scope query. Keep all sequence, retention, deduplication and source checks. Batch progress belongs to the evaluation workspace. |
| `tr_notification_validation_terminal` | `migrations/0027_notifications.sql:217` | Exclude evaluation before either insert executes. Change the `WHEN` linked-Job existence test to join a review-purpose run, and filter both the counter insert and event insert with `run.purpose = 'review'`. Merely tightening `tr_notification_event_insert` would abort and roll back an evaluation Job's terminal transition. |

Recreate these two parent triggers unchanged for both purposes:

- `tr_review_runs_immutable_update` (`migrations/0014_review_runs.sql:225`).
- `tr_review_runs_immutable_delete` (`migrations/0014_review_runs.sql:226`).

The link trigger's M14 definition is superseded by M22. In particular, using the M14
fixed capability count of two would silently discard M22's reproduction, structured
probe, and UI observation admission rules.

## Evaluation admission branch

Retain M22's initial association-count limit and consecutive-activation test. Add the
evaluation restriction `NEW.activation_number = 1`; the existing primary key then
prevents another Job association for that cell/request. Infrastructure retries stay in
`run_attempts` for the same Job and do not create another link.

The minimal safe structure is an explicitly purpose-gated ordinary `EXISTS` using the
complete current M22 predicate, or a separate explicitly purpose-gated evaluation
`EXISTS`. An inner join to `request_epochs` cannot sit outside that choice. Keep the
ordinary current-source and GitHub-authorization checks inside the ordinary branch.

The evaluation branch must retain or introduce all of these bindings:

1. The repository is enabled. The immutable run belongs to an existing evaluation cell
   in that repository, and the cell belongs to the authorized immutable batch/matrix.
   The evaluation and its authorization have not been cancelled. Check current operator
   permission before creation/replay/admission as required by the owner API contract.
2. Join the exact `run.revision_id`, not `epoch.current_revision_id`. Match work-item,
   repository, revision key/kind, exact PR base/head or explicitly selected Issue
   commit, and the persisted source snapshot and digest. Current item state, current
   revision, reviewer assignment, and current GitHub policy are not evaluation authority.
   A closed or advanced source item must not rewrite the frozen source.
3. Both `run.request_epoch_id` and `job.request_epoch_id` are null. The Job has no
   `source_event_id` and no `job_request_epochs` link. Its execution context explicitly
   contains null `requestEpochId` and `testedSourceAuthorization`.
4. Keep the existing fresh-Job checks: queued, attempt count zero, no `run_attempts`,
   correct work-item and resource revision, and workflow-derived Job kind. Bind every
   resource property, `canonicalSnapshot`, repository numeric ID/name, PR base/head/draft
   or Issue revision digest to the exact frozen plan/source as M22 already does.
5. Require `ValidationJobContextV2`, the exact run/plan digest/activation/request/Job
   activation/repository/work-item/revision/workflow/target/required identity, and exact
   canonical `purpose`, `source`, `authorization`, and `modelRequirements` objects from
   the plan. The purpose has the persisted evaluation/cell/case/arm/suite-version/
   authorization/execution-manifest identity, trial 1, and forbidden upstream mutations.
6. Keep complete frozen Profile, Prompt envelope, Prompt version identity, required
   checks, source revision, timeouts, and empty allowed-recipe-list equality. Resolve
   published versions by their actual immutable IDs, without consulting or changing
   current production bindings for evaluation selection.
7. Keep M22's exact conditional `issueReproduction`, `structuredProbeOutput`, and
   `uiAssertionObservation` labels and their corresponding frozen request/binding
   predicates. Add `validationEvaluation = '1'`. The evaluation label count is
   `3 + reproduction + probes + uiObservations`, with the same conditional terms as
   M22; the ordinary label count remains `2 + reproduction + probes + uiObservations`.
   Extra, missing, and incorrect labels still fail. The server and actual Worker
   capability negotiation must enforce this code-generated capability too.
8. For mapped Issue reproduction, require the exact V2 reproduction binding to the
   evaluation source, selected commit, operator authorization, activation, request,
   Profile version/configuration digest, and target. Replace only the ordinary
   `testedSourceAuthorization` requirement in this branch. V2 Issue validation requires
   a selected commit; V2 Issue triage remains snapshot-only with no checkout.
9. Preserve readiness/admission constraints. M22 only tolerates the existing dynamic
   `unsupported_target`, `missing_capability`, and `evidence_delivery_unavailable`
   readiness reasons during association. New evaluation blockers must not turn into
   an unrestricted bypass of that list. Pending/blocked cells remain in the immutable
   denominator and do not acquire historical successful results.

The result-insert and Job-success evaluation branches must recheck the persisted
identity described above, but must not invent a new GitHub freshness requirement at
completion. Normal lease loss, cancellation and late-output fencing continue to apply.

## Child tables and Job constraints

No existing child table requires a rebuild solely for a null evaluation epoch and
context V2, provided the result wire format remains `ValidationJobResultV1`.

| Existing table or constraint | Consequence |
| --- | --- |
| `jobs.request_epoch_id` (`migrations/0002_github_ingestion.sql:249`) | Already nullable. Its FK is valid for null. `source_event_id` is also nullable. No Job table rebuild is required. |
| `jobs.execution_json` (`migrations/0001_initial.sql:55`) | `TEXT NOT NULL`, with no table CHECK fixing the validation context schema or requiring an epoch. The V1 restriction is in the M22/M15 triggers and owner validation, not this column. `execution_digest` was added nullable in M2; evaluation admission must still require the real canonical template digest. |
| `jobs` epoch deduplication index (`migrations/0011_job_activation.sql:9`) | The unique index is partial on non-null epoch and therefore does not deduplicate evaluation cells. Use a cell/request-specific semantic key and the existing Job `semantic_key` uniqueness. Concurrency keys need purpose/cell/request identity while retaining separate interactive desktop exclusion. |
| `review_run_requests` (`migrations/0014_review_runs.sql:53`) | No epoch or V1-context constraint. Keep frozen request JSON, workflow/target limits, `(run, request)` primary key, `(run, Profile version)` uniqueness, and Prompt/envelope null pairing. Evaluation's single complete request is a stricter branch of the existing table. |
| `review_run_job_links` (`migrations/0014_review_runs.sql:79`) | Activation permits positive integers; enforce evaluation activation 1 in the link trigger. Keep globally unique Job association and its request FK. |
| `validation_job_results` (`migrations/0015_validation_job_results.sql:24,53`) | Fixed result schema `ValidationJobResultV1` and report schema `ValidationReportV1`, not context V1. No epoch column exists. All current result identity, bounds, workflow, report and model-review checks remain applicable. A future V2 result schema would require its own reviewed table rebuild; do not introduce that change merely to carry V2 execution context. |
| `validation_job_results.modelReview` (`migrations/0015_validation_job_results.sql:80`) | A completed legacy model review remains `PrReviewPlanV2` or `IssueTriageV2`. UI/Issue-validation model output already uses optional `report.modelSummary` and `modelReview.state = 'not_requested'`; it does not need a new table CHECK. Evaluation must independently prove that the required actual model ran and produced the summary. |
| `evidence_assets` (`migrations/0016_evidence_assets.sql:11`) | No epoch/context-version constraint. Preserve the existing immutable scope, metadata/media/size/state checks and request/attempt FKs. |
| `validation_control_audit` (`migrations/0017_validation_dispatch.sql:1`) | Its existing `dispatch`, `rerun`, and `cancel` action CHECK supports shared dispatch/cancel. Reject evaluation rerun in the trigger. Do not add batch-specific action values to this table; new evaluation records own batch actions. |
| `validation_dispatch_checks` (`migrations/0017_validation_dispatch.sql:58`) | No epoch/context-version constraint. Keep evaluation requests in this existing pending queue and capacity mechanism. |
| `job_request_epochs` (`migrations/0002_github_ingestion.sql:279`) | Epoch is NOT NULL. Evaluation must never insert a row here; no constraint relaxation or table rebuild is appropriate. |
| `github_review_run_activations` (`migrations/0018_github_review_run_sources.sql:33`) | Epoch is NOT NULL with a work-item-scoped FK. Evaluation must never enter this ordinary GitHub routing table. |
| Decisions, dispositions, publications and notifications | Their Run FKs can remain. Purpose guards reject evaluation writes. Notification source-kind CHECK intentionally has no evaluation-batch variant; batch progress does not require rebuilding this inbox. |

## Indirect guards that the direct-reference inventory does not cover

The following existing triggers do not directly reference `review_runs`, so they are
not part of the 14-trigger rebuild inventory. They still matter to purpose isolation.

- `tr_job_request_epoch_link_consistency` (`migrations/0002_github_ingestion.sql:385`)
  currently checks only that Job and epoch have the same work item. It can therefore
  attach a null-epoch evaluation Job to an ordinary epoch. Add an evaluation-only
  rejection trigger on `job_request_epochs`, checking both trusted V2 context identity
  and any evaluation run link. Keep the existing review behavior unchanged.
- `tr_job_scheduling_links_consistency` (`migrations/0002_github_ingestion.sql:360`)
  only validates non-null epoch/event links during Job insert. Add evaluation-only
  insert/update guards to require null epoch and source event. A context claiming
  evaluation must be strict V2, and a V2 context must resolve to evaluation purpose.
  Do not rely solely on the absence of an epoch to classify a Job.
- `tr_review_run_linked_job_identity` (`migrations/0014_review_runs.sql:215`) already
  freezes linked Job work item, epoch, kind, revision, execution JSON and execution
  digest. Preserve it unchanged. Its null-safe comparisons protect evaluation too.
- `tr_review_result_reject_validation_job`, `tr_validation_job_initial_success_rejected`,
  `tr_completed_job_validation_identity`, both completed-attempt/revision identity
  triggers, and result immutability triggers in M15 remain applicable to evaluation
  unchanged. V2 validation must never use the legacy `review_results` projection path.
- `tr_validation_result_evidence_references` (`migrations/0016_evidence_assets.sql:127`)
  remains unchanged. Evidence still belongs to the exact Run/request/Job/attempt/
  Profile/revision/plan/check, and non-headless complete reports still need UI evidence.
- `tr_validation_dispatch_job_associated` (`migrations/0017_validation_dispatch.sql:93`)
  remains unchanged and clears the same pending request after evaluation association.
- `tr_github_review_run_job_source` (`migrations/0018_github_review_run_sources.sql:95`)
  remains an ordinary-activation guard. Evaluation is excluded at activation insertion;
  it must not receive a fake activation to satisfy this trigger.
- M24/M25 admission, queue episode, active-attempt, lease and fairness triggers must
  still count evaluation usage. Before an evaluation Job is leased, require its exact
  persisted Run/cell/request association and active evaluation authority. A standalone
  V2-looking Job must not become runnable just because it has an admission row.
  `tr_job_admission_legacy_identity` also protects admitted null-epoch ownership inputs
  and should remain unchanged.

Use new narrowly scoped evaluation-only triggers for indirect restrictions when
possible. The current rebuild helper's `inspectAfterRebuild` rejects changed SQL for
any pre-existing object outside `expectedObjects`
(`apps/server/src/database/migration-rebuild.ts:286-305`). Replacing an indirect trigger
requires an explicit reviewed extension of that replacement inventory. The helper also
requires existing child-table SQL, child foreign keys and row counts to remain unchanged
at lines 307-328. Do not silently broaden the rebuild to remove those guarantees.

## Source, configuration, report and probe integration

SQL admission is only one part of the existing completion chain. Owner completion code
currently has its own epoch `=` join, V1 plan assertion, authorization access, expected
template reconstruction and source authorization requirements
(`apps/server/src/database/validation-results.ts:405-595`). These need an explicit V2
branch as well; changing SQL triggers alone will not make an evaluation cell executable.

Preserve these independent bindings when adding that branch:

- Source: recompute source, manifest, plan and template digests from authoritative
  bounded canonical bytes. Bind numeric repository/work-item identity, stored exact
  revision ID/key, full frozen metadata/body and tested commit. Historical capture
  provenance is not execution permission. Do not copy current mutable metadata over
  an immutable historical snapshot or allow a successful result from a different cell.
- Configuration: `validatePublishedSnapshots` at
  `apps/server/src/database/validation-results.ts:536` resolves complete actual
  published Profile/Prompt versions and recomputes their configuration/content digests.
  Preserve this check and the authoritative workflow output-schema comparison.
  Evaluation selection must bypass only current production binding requirements in
  ordinary Run creation, not published-version existence, scope, or byte equality.
- Checks: preserve exact Profile-qualified IDs, uniqueness, kind, required flag,
  lifecycle phase, diagnostic outcome/exit-code consistency and completeness. Missing
  checks lower coverage. Required-check derivation remains bound to the complete
  frozen Profile. The evaluation criterion-to-arm mapping is a separate server-side
  assessment object and must not replace or remove executed Profile checks.
- Probes: preserve `validateProbeReceiptObservations`
  (`apps/server/src/database/issue-reproduction.ts:42`). Each complete receipt binds
  request, Job, attempt, plan digest, Profile version and declared test check. It requires
  a passed runner check, a settled passed test diagnostic with exit code zero, exact
  bounded canonical output digest, and the complete declared typed observation set.
  Successful declared probes require exactly one receipt. Diagnostic previews are not
  observations and arm/cell results cannot share a receipt merely because check IDs match.
- Reproduction: `recomputeIssueReproductionRequestAssessment` currently rejects null
  `testedSourceAuthorization` and derives repository/work-item identity from that V1
  object (`apps/server/src/database/issue-reproduction.ts:175-200`). Add a dedicated
  evaluation authorization/source branch, reuse the observed probe/UI evidence checks,
  and persist evaluation assessment separately from ordinary Issue conclusions.
- Model: UI/Issue-validation summary presence, actual execution and verified runtime
  identity are additional evaluation requirements. Existing optional-summary or
  `modelReview.state = 'not_requested'` conventions do not attest model execution.
  SQL purpose/identity enforcement cannot attest subprocess confinement or requested
  versus observed model identity; missing accepted evidence remains blocked/incomplete.

Ordinary latest-Job, reviewed-revision, latest-Run, approval and Issue-conclusion reads
must select review purpose. Operational capacity, fair dispatch, attempts and evidence
retain both purposes. Ingestion must exclude evaluation from supersession, pinning and
epoch relinking. No production binding mutation, fabricated epoch or synthetic
published-version ID is needed for any evaluation branch.
