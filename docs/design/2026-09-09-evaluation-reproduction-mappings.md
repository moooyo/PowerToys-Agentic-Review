# Issue evaluation reproduction mappings

Status: implementation integrated; verification is recorded in the mapped-reproduction handoff.
This increment does not open evaluation or model execution gates and does not authorize upstream
PR/Issue writes.

## Operator workflow

Historical reproduction claims and their present/absent signatures come from an immutable ReviewRun.
The source reader verifies its original plan and binding digests under current repository access.
The operator selects cases and explicitly maps their observation references and check preconditions
to each arm's published profile. Original claim text, context and predicate values remain read-only.
Scoring criterion mappings, expected outcomes and finding annotations are a separate Server-only
input and do not supply execution mappings.

The Dashboard offers a read-only Server preview for the current source, profile versions and mapping
selection. Its response contains only scope, profile identities and readiness/blockers, not an
execution authorization or a temporary frozen binding. Changing any input invalidates the preview.
A blocked preview is a valid result and can create an explicitly blocked matrix. Sources without
reproduction retain the existing creation flow.

## Frozen data and digest order

`EvaluationReproductionSourceDefinitionV1` preserves the verified original claim and cases together
with source, original Run and digest identities. `EvaluationReproductionCellRecordV1` contains the
selected case IDs, one arm's explicit mappings, readiness/blockers and its rebound binding, if ready.
Each record has a separate aggregate byte budget.

The small `EvaluationReproductionManifestV1` contains source-definition and cell-record digests.
`EvaluationCellManifestV2` binds that manifest and each cell's readiness, record digest and optional
binding digest. The existing execution manifest and authorization bind the cell-manifest digest.
The owner reads and verifies only the bounded definition and record needed for the selected cell,
instead of repeatedly parsing every cell's full reproduction document.

Generation is acyclic: allocate cell/run/request/activation IDs and known actor/time; rebind the
source cases; compute record and reproduction-manifest digests; compute the cell and execution
manifests; then create the complete evaluation authorization and plans. The rebinding constructor
uses an explicit pre-authorization context. No dummy authorization or placeholder execution digest
is needed.

Batches containing historical reproduction or explicit reproduction selections use CellManifestV2.
Other batches retain the original V1 generation path. Missing selections for an applicable historical
reproduction source produce blocked V2 cells, rather than silently downgrading the batch to V1.
Non-applicable cells remain in the complete matrix.

## Mapping and runtime authority

Mappings must reference declared, compatible profile observations and checks. Both probe values and
Windows/Web UI assertion observations are supported. Original predicate values and interpretation
are preserved. Missing, ambiguous or incompatible references produce explicit blockers; oversized
records are rejected or blocked without truncating their original meaning.

A rebound binding uses the current evaluation actor/time and its fresh activation, request and
profile identities. Evaluation source authorization remains independent, with
`testedSourceAuthorization: null`. A dedicated domain validator checks the complete evaluation
source and authorization while reusing canonical binding and profile-reference validation. Ordinary
Issue source authorization retains its existing path.

The database cell reader exposes one authoritative reproduction readiness result. Dispatch, claim,
summary input, evidence, completion and observation paths consume it. Missing mapping is reported
as `reproduction_mapping_blocked`, a plan prerequisite rather than a missing Worker capability.
Ready cells pass only their own frozen definition to the Worker. Profile-only evaluation still
creates no model work; required-model completion and Worker execution gates remain independent.

## Persistence and HTTP

Migration 0033 extends the evaluations table's manifest-version constraint through the controlled
rebuild path and adds immutable reproduction records. Original rows, serialized data, digests,
foreign-key relationships and earlier migration bytes are retained. SQL guards independently reject
omitted source definitions, false inapplicability and unbound records.

The repository-scoped source, batch-plan and cell-detail GETs require current read access. The
preview POST requires configure permission plus the normal session and exact Origin checks; it is
read-only and remains available during recovery. Creation resolves and validates current permissions,
source and selected versions again. All responses are bounded, scope-checked and non-cacheable.

## Acceptance limits

Verification must cover both arms, probe and Windows/Web references, original interpretation,
independent authorization, missing mappings, immutable replay, tampering, current permissions,
bounded records, prior V1 archives, Worker observations and Dashboard configuration/read behavior.
Synthetic model or execution records remain explicitly synthetic. Actual Windows applications,
model confinement and intended deployment acceptance remain separate requirements.
