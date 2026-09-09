# Issue reproduction bindings and later human decisions

Status: M22 is implemented across the backend, Worker, and Dashboard, with connected acceptance
using an isolated local Git source, headless commands, native Windows UI, and Web UI. Frozen
authoring, observations, screenshots, independent Server assessment, current/history projection,
and operator UI transitions have been exercised. The acceptance fixture uses a custom workspace
provider with real Git observations and a fixture disk-monitor callback; it does not establish
production repository checkout, production model execution, or deployment-specific toolchain
acceptance. See the [connected record](../../artifacts/m22-connected-20260907/REPORT.md).

M19 access control, [M20a decisions](./2026-09-07-run-human-decisions.md), and
[M21 finding disposition](./2026-09-07-finding-lifecycle.md) are separate completed slices.

Implemented boundaries: a mapped job receives the full frozen binding only when that binding
selects its request. Unmapped required profiles retain their old envelopes. Mapped UI profiles
cannot contain command secret references, and mapped Web profiles must explicitly publish
`trace: "off"`. Both drivers buffer screenshots until observation safety checks pass. These
restrictions do not establish support for authenticated UI reproduction. Generic legacy captures
cannot produce mapped observation facts. Optional model advice cannot replace the deterministic
assessment, and its input/output budgets include the complete receipts and assessment.

The implementation and acceptance scope includes Windows desktop UI, Web UI, and headless
validation. Both UI targets remain in scope; a headless implementation or a single UI target is not
a replacement for the approved dual-UI workflow.

## Problem and existing boundaries

Both `HeadlessValidationCheckRunner` and `UiProfileRunner` currently emit
`reproductionConclusion: "inconclusive"` for Issue reports. This is correct without an explicit
mapping between the reported defect and the observations a profile measures. A green build, a zero
exit code, or a passing generic UI scenario does not identify which Issue claim was exercised.
Conversely, a failed assertion may be the exact observation that demonstrates a defect, while a
failed launch demonstrates no application behavior at all.

The existing contracts provide useful boundaries:

- `packages/contracts/src/review-run.ts` freezes the Issue revision separately from the tested
  source commit and its authenticated operator authorization. The frozen plan also includes the
  published profile and prompt versions, required checks, and target.
- `packages/contracts/src/ui-scenarios.ts` records typed assertion `expected` and `actual` values in
  driver-produced step evidence. Click and fill steps have no observation value. The Windows and
  Web implementations currently reject oversized text values instead of clipping them.
- `packages/contracts/src/platform-configuration.ts` defines reusable commands and scenarios.
  Command steps currently provide no structured measurement protocol.
- `packages/contracts/src/validation-report.ts` separates runner checks and the runner's Issue
  conclusion from optional `ValidationSummaryV1` model advice.
- `apps/worker/src/execution/managed-process-runner.ts` already rejects incomplete stream capture,
  invalid UTF-8, nonzero exit, and ProcessHost truncation before returning successful command output.
  Display diagnostics may be redacted and shortened; they are not a measurement channel.

The missing unit is a frozen, Issue-specific interpretation of actual observations. It must be
declared before execution and evaluated by deterministic code. A model may explain the result but
cannot create observations, choose a retrospective signature, or replace the runner's conclusion.

## Ownership: run intent, not repository-wide Issue meaning

Add optional reproduction intent to `OperatorReviewRunCreateRequest`. A repository profile owns
reusable measurement capabilities: commands, UI locators, scenarios, declared probe fields, and
their execution environment. An individual run owns the claim being investigated, its observation
selection, and the meaning of observed values for that claim.

Do not add a repository-wide rule such as "this profile passed, therefore the Issue was reproduced."
The same profile can investigate different Issues, and one Issue may need different scenarios on
Windows and Web. A human-authored mapping is an experimental specification, not a manually entered
final verdict. The server never accepts observed values or a reproduction conclusion in run
creation input.

The first version investigates one explicitly named claim per run. Multiple cases can test that
same claim under different frozen scenarios, targets, or inputs. Independently described defects
must use distinct claims/runs until a multi-claim contract is deliberately introduced.

The following are proposed TypeScript interfaces, not existing exports. Identifier, SHA, string,
array, and encoded-size constraints must be implemented with the existing strict contract patterns;
unknown object properties are rejected.

```ts
type ObservationValue =
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "number"; value: number };

type ReproductionObservationRef =
  | { kind: "ui_assertion"; scenarioId: string; stepId: string }
  | { kind: "probe_value"; testStepId: string; observationId: string };

interface ObservationEquals {
  observation: ReproductionObservationRef;
  equals: ObservationValue;
}

interface ObservationSignature {
  allOf: ObservationEquals[];
}

type ReproductionPrecondition =
  | { kind: "check_passed"; checkId: string }
  | { kind: "observation_equals"; predicate: ObservationEquals };

interface IssueReproductionCaseRequest {
  id: string;
  profileId: string;
  expectedProfileVersionId: string;
  context: string;
  preconditions: ReproductionPrecondition[];
  presentWhen: ObservationSignature;
  absentWhen: ObservationSignature | null;
}

interface IssueReproductionRequestV1 {
  schemaVersion: "IssueReproductionRequestV1";
  claim: string;
  cases: IssueReproductionCaseRequest[];
}

interface OperatorReviewRunCreateRequestWithReproduction {
  activationId: string;
  expectedRevisionKey: string;
  profileIds?: string[];
  testedSourceCommit?: string;
  reproduction?: IssueReproductionRequestV1;
}
```

Use exact, type-sensitive equality in the first slice. Strings are case-sensitive and are not
trimmed, case-folded, Unicode-normalized, or interpreted as regular expressions. Numbers must be
finite JSON numbers; canonicalization treats negative zero as zero consistently. No expressions,
scripts, JSONPath, regex engine, arbitrary log matching, or implicit negation is needed. A reusable
probe can expose a bounded numeric count or a precise normalized domain value when raw text is not
a stable observation; that transformation is part of the frozen probe implementation, not an
unrecorded transformation by the evaluator.

Suggested initial bounds are 32 cases per run, 16 predicates per signature, 16 preconditions per
case, and 2,048 characters per string value. These are additional bounds, not permission to exceed
the existing plan/result byte limits. Oversize input is rejected in full.

Creation validation must establish all of the following:

1. The work item is an Issue, each case resolves to a selected `issue_validation` request in the
   same repository, and an exact `testedSourceCommit` is supplied. Triage-only and PR runs cannot
   carry this binding.
2. The current authoritative Issue revision matches `expectedRevisionKey`. The server resolves
   repository identity, Issue identity, the actual published profile, and authorization inside the
   existing creation transaction. The client cannot supply these authoritative snapshots.
3. Each `expectedProfileVersionId` matches the version being frozen. A publish between viewing the
   profile and creating the run causes a conflict, even if the new version reuses the same step ID.
4. UI references name assertion steps only. Probe references name fields explicitly declared on a
   test command. A generic command outcome is allowed as a precondition, never as a bug observation.
   References cannot cross cases' profiles. Qualified check IDs resolve under the frozen version.
5. Each signature is nonempty, contains no duplicate observation reference, and agrees with the
   referenced observation's type. Preconditions and either signature must also be satisfiable.
6. When `absentWhen` is present, the two signatures are provably mutually exclusive: at least one
   shared observation reference must require different same-type values. With conjunctions of
   exact equalities this is a small deterministic check. Reject non-disjoint signatures; do not
   resolve them by evaluating `presentWhen` first. `absentWhen: null` explicitly means a
   positive-only experiment that cannot establish `not_reproduced`.
7. Every required repository request remains in the plan. Case selection identifies observations
   to interpret; it does not remove required checks or change scenario execution order. A case's
   frozen command arguments, UI path, locators, fill inputs, and reset policy come from its profile.
   New experiment inputs require a new published profile in this slice, rather than unvalidated
   per-run command overrides.

Canonical reproduction intent must enter the existing creation `intentDigest` before activation
lookup. Canonicalize semantically unordered IDs/predicates consistently, reject duplicates, and
preserve execution order where it is meaningful. The same activation and actor with the same intent
returns the existing frozen plan even if configuration later changes. A different claim, predicate,
selection, profile version expectation, actor, revision, or commit conflicts. Changing a binding
requires a new activation; attaching one after observing a completed run is not supported.

## Frozen binding and scope

The full Issue title/body remains in the existing frozen work-item snapshot. The operator's `claim`
is displayed alongside that snapshot as its declared interpretation; schema validation cannot prove
that an arbitrary natural-language interpretation faithfully describes a report. This limitation is
explicit and auditable, without allowing an operator to type the resulting verdict.

```ts
interface FrozenIssueReproductionCase
  extends Omit<IssueReproductionCaseRequest, "profileId" | "expectedProfileVersionId"> {
  requestId: string;
  profileVersionId: string;
  profileConfigSha256: string;
  target: "headless" | "web" | "windows_desktop";
}

interface IssueReproductionBindingV1 {
  schemaVersion: "IssueReproductionBindingV1";
  activationId: string;
  repositoryId: string;
  githubRepositoryId: number;
  workItemId: string;
  githubWorkItemId: number;
  issueRevisionKey: string;
  testedSourceCommit: string;
  authorizedBy: { issuer: string; subject: string; authorizedAt: string };
  claim: string;
  cases: FrozenIssueReproductionCase[];
}

interface FrozenIssueReproductionBinding {
  binding: IssueReproductionBindingV1;
  bindingDigest: string;
}
```

The server creates this binding from authoritative rows and the existing tested-source
authorization. `bindingDigest` hashes the complete canonical binding; the enclosing plan digest
then includes both. Do not put the enclosing plan digest inside its own hashed binding. References
to the frozen profile are sufficient to identify the exact locator, scenario sequence, probe
command, and measurement declaration; do not copy mutable live configuration into results.

Every received observation additionally binds to the run, request, job, accepted attempt, lease,
plan digest, profile version, and check. A local case cannot combine observations from different
attempts. Run aggregation uses only the authoritative current job association and accepted attempt
for each request, never a previous successful attempt while its replacement is pending.

## Actual observations and capture integrity

### Windows and Web UI

Reuse the typed `actual` from the verified `UiScenarioExecutionEvidenceV1` document and its finalized
manifests. A scenario-level outcome string, screenshot caption, model observation, click, or fill is
not a typed value source. `actual: null` means unavailable; it never means `false`, empty text, or
absence of a bug.

Both native drivers, the Worker composer, and server verification must agree that an assertion's
value is complete, has the frozen identity/action/expected value, and has a coherent assertion
outcome. Re-evaluate failed assertions too; the current passed-only consistency checks are not
sufficient authority for mapping a failed assertion to a positive witness. A timeout, unavailable
provider, ambiguous locator, invalid capture, or blocked step cannot masquerade as a measured
boolean or an assertion mismatch. Keep driver sequence and stop-on-failure validation.

For example, a frozen assertion expects the status text `Ready`. The Issue binding declares
`presentWhen = status equals Duplicate` and `absentWhen = status equals Ready`. A real, complete
`Duplicate` observation can confirm the bound defect even though the correctness assertion failed.
`Starting`, a missing status control, and an application launch failure do not establish either
signature. Evidence and lifecycle requirements still apply.

An individual observation is not complete merely because a JSON document containing it was fully
read. Preserve the current oversized-value rejection in both UI targets. Any future adapter that
shortens, normalizes, or replaces a value must expose it as unavailable to this evaluator, unless
that measurement operation was explicitly part of the frozen observation definition.

### Headless probes

Add an optional declared probe-output contract to a published test step. Its declarations describe
measurements, not Issue conclusions. Generic build/test steps remain unchanged.

```ts
interface TestProbeOutputDeclarationV1 {
  schemaVersion: "TestProbeOutputDeclarationV1";
  fields: Array<{
    id: string;
    description: string;
    type: "boolean" | "string" | "number";
  }>;
}

type ProbeObservation =
  | { id: string; state: "observed"; value: ObservationValue }
  | { id: string; state: "unavailable" };

interface ProbeObservationsV1 {
  schemaVersion: "ProbeObservationsV1";
  observations: ProbeObservation[];
}

interface TestProbeReceiptV1 {
  schemaVersion: "TestProbeReceiptV1";
  requestId: string;
  jobId: string;
  runAttemptId: string;
  planDigest: string;
  profileVersionId: string;
  checkId: string;
  capture: "complete";
  output: ProbeObservationsV1;
  outputSha256: string;
}
```

The proposed optional `ValidationCommandStep.probeOutput` is valid only in the `test` phase.
A command declares at most 32 unique fields and emits exactly one complete strict UTF-8 JSON
document on stdout, bounded initially to 128 KiB. Progress/logging belongs on stderr. Unknown or
duplicate fields/object keys, missing declared fields, wrong types, non-finite values, excess
bytes, and extra JSON documents are errors. An explicit unavailable field supplies no value.
Neither the protocol nor a receipt accepts a verdict, model advice, or Issue conclusion.

The Worker collects this document from the successful `ManagedProcessRunner` return before creating
display diagnostics. Exit zero, settled stdout and stderr, absence of capture truncation, and
complete process teardown are mandatory. Never parse the 4 KiB diagnostic previews, a partial
buffer, the last matching log line, or the output attached to a nonzero-exit exception. A failing
test can use a separate successful observation command to report a measurement; a failed command
does not invert the meaning of a probe.

The Worker creates and scopes the receipt after validation; the command cannot supply its own
identity, hash, or capture attestation. Store the complete bounded safe output and its canonical
hash in the accepted result, not only a hash of discarded output. This can initially be an optional
inline result extension and need not introduce a new filesystem evidence kind. Enforce the total
result size across all receipts; reject excess data rather than keeping the first measurements.

The server can independently validate and hash stored complete output, scope, the frozen field
declaration, and matching successful execution diagnostics. The hash is an integrity binding, not
proof that a program actually ran. Native execution remains under the authenticated Worker's
existing trust boundary, as it does for current command and UI facts.

### Secret handling and unavailable values

Secret redaction must never create a match. Do not evaluate transformed diagnostic text, substitute
`[REDACTED]` and compare it, truncate a secret-bearing value to a safe-looking prefix, or expose a
hash of a withheld secret as a measurement. The observation boundary must detect unsafe values
using the existing resolved sensitive-value handling before durable capture or model context.
An affected observation becomes unavailable; if an existing evidence format cannot safely retain
that state, reject the affected capture instead of weakening evidence validation. Do not log the
value while reporting the failure.

Only a complete, safe, untransformed measured value may reach a predicate. This rule applies to each
individual UI value and every headless probe value, not just to their enclosing output streams.
Configured secret references, environment values, or model-generated replacements never supply
comparison values. Missing, withheld, malformed, and partially captured observations are explicit
unknowns; none can prove absence.

## Pure domain evaluation

Introduce a small module such as `packages/domain/src/issue-reproduction.ts`. It performs no I/O,
model calls, profile lookup, asset reads, or string parsing. Worker/server boundary code converts
fully verified data into its input. These are proposed internal types, not client-supplied proof:

```ts
type VerifiedObservationFact =
  | {
      caseId: string;
      observation: ReproductionObservationRef;
      state: "observed";
      value: ObservationValue;
      evidenceIds: string[];
    }
  | {
      caseId: string;
      observation: ReproductionObservationRef;
      state: "unavailable";
      reason: string;
    };

interface ReproductionCaseExecution {
  caseId: string;
  state: "pending" | "verified" | "blocked";
  passedPreconditionCheckIds: string[];
  observations: VerifiedObservationFact[];
  reasons: string[];
}

interface IssueReproductionCaseAssessment {
  caseId: string;
  state: "present" | "absent" | "inconclusive" | "blocked";
  matchedObservationRefs: ReproductionObservationRef[];
  evidenceIds: string[];
  reasons: string[];
}

interface IssueReproductionAssessmentV1 {
  schemaVersion: "IssueReproductionAssessmentV1";
  rulesVersion: 1;
  bindingDigest: string;
  planDigest: string;
  issueRevisionKey: string;
  testedSourceCommit: string;
  conclusion: "confirmed" | "not_reproduced" | "blocked" | "inconclusive";
  coverage: "complete" | "partial";
  cases: IssueReproductionCaseAssessment[];
}

declare function evaluateIssueReproductionCases(
  binding: IssueReproductionBindingV1,
  executions: readonly ReproductionCaseExecution[],
): IssueReproductionCaseAssessment[];

declare function aggregateIssueReproduction(
  frozen: FrozenIssueReproductionBinding,
  planDigest: string,
  cases: readonly IssueReproductionCaseAssessment[],
): IssueReproductionAssessmentV1;
```

Before an execution is classified as verified, its authoritative scope and original source state
must match, required setup/build/readiness and declared case controls must be satisfied, and
required evidence, reset, cleanup, process exit, and stream draining must be confirmed. An unknown
live process or changed/unknown source cannot produce a valid witness. Expected assertion failure
is distinct from a lifecycle failure. Do not require the bug-observation assertion itself to pass,
and do not erase a valid witness merely because unrelated correctness checks failed. Run execution
eligibility continues to account for all existing required checks independently.

Predicates use three-valued logic: a complete unequal value is false; an unavailable value is
unknown; a complete equal value is true. A conjunction is true only when every member is true,
false when a member is known false, and otherwise unknown. A single available discriminator can
make the opposite signature false, but it cannot supply missing values required by its own
signature. Declared preconditions must be true before either interpretation is allowed.

| Case facts | Case assessment |
| --- | --- |
| Preconditions true, present signature true, absent signature false or absent | `present` |
| Preconditions true, explicit absent signature true, present signature false | `absent` |
| Neither signature matches, or required observations are unknown | `inconclusive` |
| Execution, precondition, source, capture, evidence, or teardown is blocked | `blocked` |
| Execution is pending or not reached without a conclusive measurement | `inconclusive` with a reason |

Both signatures matching is an invalid binding/fact combination, not a tie to break. Reject it at
the authority boundary; a defensive evaluator must not emit `present` or `absent` if it encounters
such input. A positive-only case that does not match is always inconclusive, never absent.

Run aggregation has explicit, bounded meaning:

- Any valid positive case yields `confirmed`, with that case and target cited. Other blocked or
  unfinished cases remain visible as partial coverage. A positive Windows case and a negative Web
  case show environment-dependent behavior, not contradictory measurements of one execution.
- `not_reproduced` requires valid explicit absence in every selected case. It means "not observed
  under these frozen conditions at this commit," not "the Issue is invalid," "fixed," or "cannot
  occur." A narrower selected experiment must be displayed as narrower; it does not satisfy
  dual-UI acceptance or imply coverage of an unselected platform.
- Without a positive case, a known obstruction produces `blocked`; otherwise incomplete coverage,
  no matching signature, pending work, or unavailable observations produces `inconclusive`.
- No binding means not evaluated and preserves `inconclusive`. Empty mappings are invalid.
- Version 1 does not derive `needs_information` from a failed test or missing mapping. That existing
  enum value remains readable, but generating it deterministically would require a later structured
  missing-input contract. A human request for information is a separate decision.

Do not combine retries into an implicit repeatability claim. Each case describes one planned
experiment in its current accepted attempt. Future repetition/flakiness policies must explicitly
freeze trial counts and aggregation rules. Historical results remain readable; an Issue edit or a
replacement run makes them historical rather than silently changing their recorded conclusion.

## Worker composition and server recomputation

The narrow integration point is `ProfileJobExecutor`, after runner normalization and evidence
finalization and before optional model summarization. The native drivers measure values; they do
not interpret arbitrary Issue text. Lower runners retain their default inconclusive behavior when
no binding exists. The composer evaluates the cases belonging to that frozen request and records
their versioned trace. Its per-profile conclusion is explicitly local to those cases; only the
server aggregates full run coverage across requests.

The server must independently recompute. Extend the existing result admission and read model
around `apps/server/src/database/validation-results.ts` and `review-run-queries.ts`:

1. Resolve the immutable plan/binding and current request/job/attempt under existing authorization
   and lease rules. Reject missing, foreign, duplicated, or substituted scope/observation IDs.
2. Revalidate original tested source, operator source authorization, Issue revision, profile hash,
   qualified checks, diagnostic outcomes, and lifecycle state. Validate both passed and failed UI
   assertions against the frozen operation and actual value.
3. Reuse the evidence verification control plane to obtain verified complete typed UI documents
   and manifests. Verify probe receipts against their complete output, declaration, result digest,
   and execution record. No synchronous unbounded asset rereads belong on the SQLite owner thread.
4. Recheck authoritative state after asynchronous verification, then run the same pure evaluator.
   Compare any Worker assessment and top-level conclusion with the recomputed per-request result;
   inconsistent claims are rejected. Persist or project a server-derived canonical assessment, not
   an unchecked Worker or model verdict.
5. Aggregate only current accepted request results. Pending verification or a superseding job must
   not fall back to an older positive/negative result. Revoked, missing, or expired evidence cannot
   satisfy a current evidence-dependent action; preserve the historical record with its current
   availability status.

The optional model summary receives the immutable assessment as additional read-only context when
supported. Its own `reproductionConclusion` remains labeled model advice. A disagreeing model does
not change the binding, measured values, runner checks, source state, case results, or server
assessment. Model failure/disablement cannot turn a real measurement into a different conclusion.

## Compatibility and capability admission

Prefer optional, explicitly versioned nested extensions to the existing strict V1 plan/profile/
report schemas, following the existing optional UI configuration precedent. Omit absent fields;
do not insert `null`, backfill derived mappings, or reserialize old published content and change
its hash. Add a typed binding reference/subset to the execution envelope and optional receipts and
assessment to the result contract. These are proposed contract changes, not currently supported
wire fields.

Mapped jobs require an explicit implemented reproduction capability in addition to the existing
headless/Web/Windows and evidence capabilities. Workers advertise it only after the evaluator and
required observation collectors are actually available. Old workers cannot receive enriched jobs
and silently drop their mapping. A configured probe requires the corresponding structured-output
support even if a particular run does not use its values for reproduction.

Existing runs/results with no mapping remain readable and inconclusive. Do not reinterpret their
passing checks or model summaries, and do not retrofit them with a later operator signature.
Versioned rules must remain available to read old assessments; an evaluator upgrade must not
silently rewrite a recorded conclusion. New runs use the newly frozen binding/rules version.

## Human decisions and finding disposition: separate subsequent workflow

Human decisions/findings are a separate planned workflow; M20 may deliver that slice before this
mapping is implemented. Suggested decisions include accepting a finding, rejecting a finding with
a reason, requesting information, and recording an operator's handling decision. Their exact
contracts and persistence are owned by the decision design, not invented as production APIs here.

Each decision must identify its actor, timestamp, reason, run/plan/revision and the exact finding or
assessment version being considered. Changes should be append-only audited decisions, not edits to
runner results. Optimistic/current-state checks must prevent a decision about an old Issue revision
or superseded finding from being silently applied to a new one. Authorization is a separate gate;
an affirmative reproduction assessment does not grant publication, approval, merge, or code
execution permission.

The UI should present three distinct facts: measured reproduction assessment with scoped evidence,
optional model interpretation, and the human handling decision. A human can decide that a report
needs more information or is out of scope while preserving an inconclusive/confirmed runner result.
A human can also record disagreement with a model. Neither action completes the missing mapping or
changes historical observations. No decision button should overwrite `reproductionConclusion` or
convert a generic green profile into a reproduction claim.

## Implementation and acceptance slices

1. Add strict nested contracts, bounded creation intent, frozen binding validation, capability
   admission, and the pure evaluator. Verify mutual exclusivity, duplicate rejection, type matching,
   idempotency, exact profile/revision/source freezing, and legacy byte/hash preservation.
2. Bind Windows and Web typed assertions through their existing verified evidence paths. Test a
   failed correctness assertion that exactly matches the bug signature, a real negative signature,
   neither signature, missing/ambiguous controls, oversized values, withheld values, stop-on-failure,
   source changes, incomplete evidence, and unconfirmed teardown on both targets.
3. Add declared headless measurements and complete bounded receipts. Test valid stdout, nonzero exit,
   stdout/stderr drain failure, driver/host capture truncation, invalid UTF-8, duplicate JSON keys,
   missing/extra/wrong-type fields, total byte limits, and secret handling that cannot create a
   predicate match. Assert that preview diagnostics and generic passing commands are never parsed
   as reproduction measurements.
4. Recompute at server admission/read time and exercise cross-profile/run/attempt substitutions,
   forged conclusions, positive-plus-negative target coverage, all-negative coverage, pending
   replacements, revoked evidence, and Issue edits during asynchronous verification. Model advice
   must have no influence on these outcomes.
5. Add the operator mapping editor and scoped result display in the Issue workflow. Keep the Windows
   and Web cases visible and independently verifiable, retain headless support, and expose partial
   coverage/reasons. Complete native acceptance for both UI targets and real headless probes before
   describing reproduction mapping as implemented and accepted.

This document was prepared from static source review. No implementation, model execution, native
probe, or test run is performed by this design slice.
