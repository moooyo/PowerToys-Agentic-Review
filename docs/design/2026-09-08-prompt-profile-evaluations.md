# Prompt and validation-profile evaluations

Status: M32 implementation in progress. This is the complete delivery design, not an acceptance
claim. Contracts or recorded-result scoring alone do not complete it. The accepted platform
[roadmap](2026-09-06-validation-platform-roadmap.md) and the user's prohibition on unapproved
real PR/Issue writes remain in force.

The current deployment model is [one long-lived Worker per VM](./2026-09-10-single-worker-vm.md),
with successive tasks on that Worker. VM isolation is managed by deployment. Evaluation does not
require a separate protected Worker journal, OS execution adapter, signing authority or
attestation-based admission protocol. Normal scheduling quotas, capabilities, leases, cancellation,
per-task cleanup and result ownership remain part of execution.

Model execution follows the [CLI-owned execution design](./2026-09-10-cli-owned-model-execution.md):
the Worker selects Codex or Copilot CLI, while the CLI owns login, provider configuration and HTTP
traffic. There is no global provider registry or project-owned provider HTTP ledger. The project
records CLI configuration, detected version, process exit and validated structured output.

The unused `executionAccepted` field is removed from the current development contracts. The
product is unreleased, so development directly maintains the current schema without database
resets, old-version upgrades, conversion or compatibility migrations. Verification uses isolated
synthetic records; existing data and historical artifacts remain unchanged.

The earlier populated schema-27 upgrade verification passed a complete synthetic history acceptance:
74 old tables and 101 rows, a finalized evidence file, 12 current readers and five exact old-receipt
replays were verified through schema 33. See the
[populated upgrade record](../../artifacts/m32-evaluations-20260908/populated-upgrade/REPORT.md).
This is retained implementation history, not a requirement for further old-version upgrades.
Actual Evaluation/model execution remains independently unverified.

## Product outcome

An operator can publish a known-example suite, select baseline and candidate Prompt/Profile
versions without changing production bindings, execute both configurations against every frozen
applicable case, inspect actual results and evidence, adjudicate findings, and publish an immutable
comparison report. The report separates execution coverage, agreement with human expectations,
finding quality and paired regressions. It never substitutes confidence values for measured quality.

V1 uses one repository and one workflow/target per suite, at most 32 cases, one published Profile
and Prompt per arm, and one declared trial per case/arm: at most 64 execution cells. All applicable
cells are created in the plan before scheduling. Unsupported environments, missing mappings and
failed executions remain visible. Windows desktop and Web are supported through their existing
distinct profile targets; a target selector is not proof of actual execution.

Both arms run new Jobs. An existing successful result cannot be attached as the baseline, selected
as the best attempt, or used to replace a blocked cell. Infrastructure attempts retain the existing
lease/retry history; a valid report containing failed assertions is not retried until it passes.
An explicit new evaluation creates a new immutable batch. Configuration promotion continues through
the existing separate binding action.

## Frozen samples and expectations

The suite draft has CAS revision control and an audit trail. Publishing atomically freezes its
source manifest and expectation manifest, each with its own version identity and digest.

Sources can be captured from a currently stored work item with an expected revision key, or from
an existing immutable ReviewRun plan. Current capture rechecks that the body and revision still
match; historical capture uses the original plan's full snapshot, not today's work-item body.
The server supplies numeric repository/work-item identity, canonical metadata, PR base/head or
the explicitly selected Issue commit, and the source digest. There is no arbitrary external URL
or raw claimed-result attachment API. Historical authorization is provenance, not permission to
execute another run. A fresh operator evaluation authorization covers the selected source manifest.

Each case retains stable case/criterion/expected-finding identifiers, applicability with a reason,
the known expected check outcome, and findings annotation completeness. Known bad code may correctly
produce a failed build or assertion. Complete negative examples explicitly declare an exhaustive
empty expected-finding set; an unlabeled or partial example is not a negative example.

Profile check identifiers include the Profile version. The evaluation plan therefore freezes an
explicit mapping from each criterion to each arm's fully qualified check identifier. Missing
mapping is a coverage omission and remains in the denominator. Applicability belongs to the frozen
expectation version and cannot be changed by deleting a candidate check. V1 uses a single check
per arm/criterion; split or merged criteria require an explicit new expectation version.

Suite publication and plan creation enforce both count limits and aggregate UTF-8 byte budgets.
Large source bodies are rejected with a specific limit error, never silently truncated. List and
matrix APIs return bounded summaries; full source and result bodies are read per case/cell.

Assessment labels, expected findings and matching decisions stay in the Server. They are not
included in Worker prompts, model workspaces or model-readable execution manifests. Profile-defined
test assertions and actual runner observations remain part of the production workflow being tested;
they are distinct from the withheld assessment labels.

## Execution identity and authority

An evaluation owns a complete matrix of baseline/candidate cells. Each cell owns a real ReviewRun,
one frozen request and its new Jobs/attempts/results/evidence. The existing scheduling, quotas,
fairness, cancellation, ProcessHost and evidence mechanisms are reused.

Old `ReviewRunExecutionPlanV1` and `ValidationJobContextV1` keep their original bytes and review
meaning. New strict V2 branches carry evaluation purpose, evaluation/suite/case/cell/arm identity,
the frozen execution-manifest digest and a server-created operator authorization. An evaluation
has no GitHub request epoch. Its new nullable epoch is not an invented assignment or review request.
Its command/model restrictions include `upstreamMutationPolicy: "forbidden"`.

The Server resolves real published Profile versions belonging to the repository/workflow/target,
and real global Prompt versions of the same workflow. Prompt templates and versions currently
have no repository ownership. Their global catalog APIs require platform authority; repository
configure permission must not silently bypass that policy. Batch selection must resolve which
versions are already authorized in this repository's binding or frozen Run context, and preserve
platform authority for additional global-version access. It must not expose arbitrary global
Prompt contents through a repository-scoped candidate selector. Neither selected version needs
to be a current binding. The Server freezes complete content,
rendered prompt, schema,
source and configuration digests before dispatch. Runtime capability and command-registration
requirements are still checked. No temporary binding changes or fake published version IDs are used.

Envelope V2 can carry the strict V1/V2 validation-context union. A new code-generated evaluation
capability prevents older Workers from claiming evaluation contexts. Existing envelope/driver
capabilities retain compatibility with ordinary Jobs. Cell/request identity is part of semantic
deduplication and concurrency keys; interactive desktop exclusion remains separate.

The complete cell matrix is persisted before bounded admission. Repository/global usage includes
evaluation Jobs. Pending cells use the same fair scheduling mechanism and cannot bypass admission
limits. Cancellation and lease loss stop actual execution, preserve attempts and fence late output.
Repository pause and explicit evaluation authorization cancellation prevent further admission.

Frozen historical commits must be fetched exactly. A deleted or unreachable source becomes a
visible blocked outcome; fetching the current PR head is not a substitute. Mapped Issue reproduction
inputs must be frozen and compatible with both selected versions, or the affected cell is blocked.

## Purpose isolation

Purpose is checked in contracts, Server handlers, SQL and Worker execution context. Evaluation
rows cannot create normal decisions, finding dispositions, GitHub source activations or publication
intents. Preview, confirmation and delivery claim reject evaluation purpose independently. Every
ordinary ReviewRun branch retains its current epoch/source/configuration rules.

Normal work-item latest-job, reviewed-revision, latest-run, approval and Issue-conclusion projections
exclude evaluation rows. GitHub ingestion cannot supersede, pin or relink evaluation Jobs as
ordinary review work. Operational queues and capacity metrics still include their real usage.
M31's per-PR/Issue validation notification producer excludes evaluation cells; the evaluation
workspace exposes batch progress and report readiness without pretending each sample is a new
PR/Issue validation result.

The Worker retains the complete frozen V2 evaluation context when the profile executor delegates
to a model executor. The legacy V1 entry cannot substitute for that evaluation context.
Profile commands and model subprocesses run inside the deployed VM. A purpose flag, a hidden
Publish button or a prompt instruction alone does not provide confinement; deployment owns that
isolation. Existing process-tree cleanup, workspace cleanup and failure quarantine still apply
before the long-lived Worker starts another task.

Prompt evaluations require actual model execution, including UI/Issue workflows whose production
summaries are otherwise optional. Missing CLI support or missing/invalid structured model output
makes the model dimension blocked/incomplete. Profile check
observations can remain independently valid; they cannot stand in for Prompt evaluation.
Configured CLI/model choices and the detected CLI version remain recorded facts, without claiming
independently verified remote-model identity. Content digests do not attest to OS isolation. Actual CLI/model execution and
the intended VM deployment still need acceptance; they are not a blanket software refusal gate.

## Persistence migration

Migration 28 is `0028_prompt_profile_evaluations.sql`. It adds suite/version/source/expectation,
evaluation/cell/authorization, adjudication and immutable assessment records. Every reference is
repository-scoped, and every replay rechecks current operator permission before returning a receipt.

Source snapshots are separate immutable records. A suite version pairs independent source and
expectation manifests, preserving case identity across them. Drafts and expectation manifests
have a 2 MiB aggregate budget; the source-reference manifest is limited to 64 KiB and its referenced
source bodies to 16 MiB in total. Lists return summaries; case/source detail is read separately.
Publishing advances the suite CAS revision even when its draft text is unchanged.

All cases, including not-applicable cases, receive both preallocated cell/Run/request identities.
Only applicable cells receive Jobs. Cells store their future Run IDs without a forward FK;
`review_runs.evaluation_cell_id` is the unique reverse FK. The creation transaction inserts the
batch, fresh authorization, complete cells, Runs and requests, then a seal that records that the
entire matrix exists. This database seal is a completeness record, not a digital signature.
Scheduling requires that record and an active control record. Cancellation changes
the control record with audit history, without modifying the authorization or frozen manifests.

Digest dependencies are acyclic: source and configuration manifests precede the cell manifest;
the execution manifest references those digests; authorization references the execution manifest;
then each V2 plan and execution template receive their own digests. The cell manifest contains
preallocated identities and prompt text/output-schema digests, never a plan or execution-template
digest that would refer back to its own authorization. Expected outcomes, check mappings, human
labels and adjudication remain in separate Server-only scoring records.

The `review_runs` table needs a controlled rebuild: its existing epoch is NOT NULL and its plan
constraint admits only V1. Old rows become `purpose='review'` with no evaluation-cell reference;
new evaluation rows require their cell reference, null epoch and matching V2 plan. Their shared
Run/request/result/evidence links keep the existing relational identities.

Only the exact, pending M28 migration receives the special rebuild path in `runMigrations`.
The production owner lock is acquired before this startup phase; RPC readiness and the evidence
verifier come afterward. Foreign-key enforcement is changed outside the transaction, checked on
readback, and always restored before readiness. The transaction creates the replacement table,
copies old columns and rowid verbatim, drops dependent triggers, replaces the parent table and
recreates the complete current schema. Existing JSON/digest/receipt bytes are not recanonicalized.
Inbound child tables and their data remain in place.

The runner reads `foreign_key_check` results before commit, checks the expected schema inventory,
and fails on unknown dependent objects. Failure before commit rolls back the schema, data and
migration ledger. Failure restoring FK enforcement after commit still prevents readiness and is
reported as a committed migration with startup failure, not as a rollback. No `writable_schema`
shortcut or deferred-counter reset is used. These choices follow SQLite's documented
[table rebuild procedure](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes)
and [foreign-key enforcement rules](https://www.sqlite.org/foreignkeys.html#fk_enable).

## Scoring and adjudication

Scoring input binds evaluation/repository, the frozen source and expectation manifests, both
configurations, and every expected cell/Run/request. Observation capture is internal to the owner
and derives actual Job/attempt/result/evidence identities from that matrix. A branded in-memory
object prevents accidental API misuse; it is not authorization or proof that a result is genuine.

Check agreement compares actual outcomes with frozen human expectations. Incomplete execution,
missing evidence or source mismatch reduces coverage instead of producing a fabricated pass/fail.
Deleting a check or its mapping cannot remove an applicable criterion from the denominator.

Model findings require explicit result-digest-bound adjudication. A finding occurrence can match
one expected problem, be a duplicate of a designated primary match, be a confirmed false positive,
or remain unjudged. One expected finding contributes at most one true positive. Partial annotation
only supports explicitly scoped known-positive metrics; unjudged occurrences keep quality provisional.
An invalid or unexecuted model does not supply an empty findings list. Zero denominators remain
null, not 100 percent. Labels and adjudications are never model self-reported confidence scores.

The report shows execution/evidence coverage, check agreement, finding TP/FN/FP/duplicates/unjudged,
and paired quality changes separately. A valid baseline with an unavailable candidate is a coverage
regression, not a disappearing pair. New coverage cannot offset regressions in the original scope.
Comparisons must retain differences and uncertainty in the recorded CLI/model configuration;
the application does not claim to verify a provider's underlying model identity.

Adjudication updates use CAS/change IDs and produce audit receipts. Publishing an assessment freezes
its source/result/expectation/adjudication digests, scorer version, numerators, denominators and
unscored reasons. Later adjudication produces a new assessment version. Changing the suite's human
expectations produces a new suite version and a new evaluation; old reports remain unchanged.

## Dashboard workflow

The repository-scoped Evaluations workspace manages suite drafts/versions and evaluation history.
Prompt and Profile version details link to candidate-prefilled evaluation creation. Operators review
the selected suite, baseline/candidate, all applicable cases, explicit check mappings, execution
requirements and blockers before starting the frozen batch.

The batch page displays every cell, including pending, blocked, failed, not-run and cancelled cells.
Each cell links to its exact result, attempts, logs and evidence. A case comparison shows expectations,
two real outputs and adjudication controls. The immutable report shows its coverage and quality
limits before any claim of improvement. Applying a candidate uses the existing binding workflow.

All reads and mutations are authenticated and repository-scoped. Configure permission controls
suite publication and execution authorization; reviewer permission controls adjudication. Explicit
CAS replay, request bounds, Origin checks, recovery read-only mode and stale-session invalidation
follow the existing operator APIs. Temporary checking hides protected content without losing an
uncertain same-scope mutation; real identity/permission changes invalidate it.

The source/suite management API uses `/api/v1/operator/repositories/:repositoryId` with
`evaluation-sources` and `evaluation-suites` resources. Published version cases are read through
`evaluation-suites/:suiteId/versions/:versionId/cases` and its `:caseId` detail, independently of
the current draft. Source bodies remain separate reads; case summaries do not include them.

Recovery mode is independently enforced by the database owner's trusted startup mode and the
HTTP route's internal replay-only restriction. That restriction is outside public request bodies
and outside the mutation intent digest: it can only forbid a new write, never authorize one.
Replaying the original request after a mode transition still requires current configure permission
and returns the same recorded response fields without recapturing a source or updating a draft.

## Completion evidence

M32 is complete only when all of the following have evidence:

1. Strict contracts and deterministic scoring cover cross-version mappings, missing/partial labels,
   empty findings, duplicate/ambiguous matches, blocked cells, zero denominators and coverage regressions.
2. The full M27 database upgrades with old bytes/FKs/results/evidence/decisions/publications intact.
   Fault injection proves rollback and FK restoration; no owner/RPC readiness occurs on failure.
3. Real evaluation creation freezes every baseline/candidate cell, published configuration and fresh
   execution authority; binding changes and source updates cannot rewrite the plan.
4. Actual new Jobs use the existing admission/lease/fairness/evidence chain, including older-Worker
   exclusion, pause, cancellation, stale ownership and terminal replay. Both arms execute all applicable
   cells; existing historical results cannot be attached as a substitute.
5. Evaluation Jobs cannot alter ordinary latest results, approval, decisions, reproduction conclusions,
   GitHub activations or publication, even through direct SQL/owner paths. No real PR/Issue write is
   performed by automated acceptance without exact user approval.
6. Model-dependent evaluation actually exercises the frozen prompts through the selected CLI in
   the intended VM, with recorded configuration, exit, structured output and per-task cleanup.
   A stub or missing optional summary is not success.
7. Persisted adjudication and immutable assessments agree with the real results and frozen denominator;
   scope, lost responses and read-only replay are verified through the actual Dashboard.
8. Both Windows/Web profile targets, migration recovery and evidence lifecycle retain their existing
   acceptance requirements. Tmpfs or isolated mocks are described accurately and never stand in for
   deployed identity, persistent-disk, real application or actual provider execution acceptance.

Implementation proceeds through contracts/scoring, source/authority/migration, actual execution,
operator APIs and Dashboard, then full regression and connected acceptance. Intermediate milestones
remain explicitly partial; they do not reduce this completion definition or the wider roadmap.
