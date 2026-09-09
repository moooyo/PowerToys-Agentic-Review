# Finding disposition and comparison

Status: M21 persistence, read models, policy integration, and Dashboard components pass integrated
regression and connected synthetic HTTP/browser acceptance.
Issue reproduction mapping remains separate work.

## Occurrence identity

An occurrence is an item in a complete immutable accepted validation result, identified by
`resultId`, `resultDigest`, namespace, and original zero-based array ordinal. Namespaces are
`pr_finding` and `validation_observation`. Its server-generated key is the SHA-256 of the canonical
`FindingOccurrenceV1` identity object. Model IDs, display position, priority, and source line are
not identity. Repeated model IDs do not merge independent occurrences.

The reader validates the exact repository, Run, request, Job, activation, attempt, profile, Prompt,
revision, execution digest, and result digest. It reads one bounded complete result for a listing
or two explicitly selected results for comparison. It never resolves identity from the eight-item
Dashboard preview or its shortened text. Model output availability is independent of whether its
finding array is empty: a failed or unrequested model is not a completed zero-finding review.

Lists preserve complete finding text and original ordinals while paginating. Up to twenty entries
fit the explicit 2 MiB response boundary, including JSON escaping and disposition actor metadata;
the limit must not be inferred from unescaped character counts. The selected result's
source currency and latest activation status are separate fields. A historical result remains
readable without becoming authoritative for its replacement.

## Human disposition

| Action | Stored state | Meaning under policy v2 |
| --- | --- | --- |
| accept | accepted | A reviewer acknowledges the finding as requiring attention. P0/P1 remains blocking. |
| dismiss | dismissed | A reviewer explicitly declines the finding with a reason. It no longer blocks as a finding. |
| resolve | resolved | A reviewer records the finding as addressed. This is a human record, not new execution evidence. |
| reopen | open | The finding requires attention again. P0/P1 blocks again. |

An occurrence with no events is `open` at version zero. Changes require current repository review
permission, a nonempty reason, an exact result digest, an expected context digest, and a per-finding
version. Reasons support paragraphs. No-op state changes and conflicting versions are rejected.

The context digest binds the selected immutable result plus its current source and latest request
activation. If a rerun or source change occurs while an editor is open, a new submission conflicts
instead of silently applying to a result that has become historical. An operator can refresh,
review the historical context, and explicitly submit against that occurrence. Its disposition
never transfers to a new result.

Events are append-only and atomically update a protected current-state projection. Both retain
exact scope, actor, time, reason, state transition, and version. The event records both the selected
context digest and the complete Run result-set digest at the time of the change; these digests have
different scopes and are not interchangeable.

Idempotency is scoped by repository and change ID. Authorization precedes replay. An identical
accepted intent returns its original receipt after subsequent changes; the receipt does not claim
to be current state. Changing its actor, target, body, or expected context conflicts. The UI keeps
an unknown-outcome retry unchanged and requires explicit review after a conflict.

## Policy and decision versions

The original `required-checks-and-p0-p1-v1` remains valid for historical decisions. Current policy
uses `required-checks-and-unresolved-p0-p1-v2`. It retains the raw `blockingFindingCount` and adds
`unresolvedBlockingFindingCount` and `findingDispositionDigest`. Raw findings remain visible.

Only open and accepted P0/P1 occurrences block the finding part of policy v2, including findings
from optional requests. Dismissal or resolution cannot change a failed build or UI assertion,
missing or expired evidence, modified source, incomplete lifecycle, stale revision, or a required
request's missing result. Human resolution is not proof that a bug was fixed or reproduced.

New human decisions use `ReviewRunDecisionSnapshotV2`, which adds the current Run disposition
digest. That digest includes original occurrence identity, current state, version, and event ID
for only the latest accepted results of all planned requests. Historical-only disposition changes
do not affect a replacement result. Returning a state to its earlier value does not restore an
earlier approval because its version and event identity have changed.

Evidence preparation remains asynchronous outside SQLite transactions. Final approval rechecks
current access, evidence, source, all result identities, disposition digest, policy, and version
within one short transaction. A concurrent disposition change prevents approval of the old basis.

Upgrade to v2 intentionally makes previous v1 decisions historical once, requiring a new review
under the new policy. Historical event JSON, digests, IDs, actor records, and exact retry receipts
are preserved. The UI validates and labels both versions rather than reinterpreting a v1 receipt.

## Migration and storage boundaries

Migration 0021 leaves the checksum and source of migration 0020 unchanged. Inside the existing
migration transaction, it temporarily defers foreign-key enforcement, copies old decision rows
verbatim into a replacement table whose self references point to that replacement, renames the
table, and recreates its immutable triggers and indexes. V1 snapshots pair only with policy v1;
V2 snapshots pair only with policy v2 and matching disposition digests. Foreign-key enforcement
stays enabled and deferred checks reset at transaction completion.

The rebuilt decision table and the two new finding tables use `WITHOUT ROWID`, preventing an
explicit physical-row replacement from evading logical-key immutability guards. Finding audit
insertion is the only supported projection mutation. Triggers reject replacement, update, delete,
invalid transitions, and mismatched scope, and ensure the projection reflects the accepted event.

Ordinary policy and decision reads use bounded disposition metadata and do not parse another
complete result for every finding. Full original result JSON remains unchanged. A finding history
read returns bounded public receipts, not duplicated model or execution payloads.

## Conservative comparison

The operator explicitly chooses both results. Comparison requires the same repository, work item,
workflow, target, profile version, and Prompt version, with complete relevant model collections.
A missing newest result never silently falls back to an older successful result.

The versioned `exact-content-v1` algorithm matches namespace, exact path, title, and body. Text
normalization only unifies line endings; path case, internal whitespace, and Unicode are preserved.
Line numbers, priorities, confidence, model IDs, and original array positions are not matching keys.

| Comparison state | Meaning |
| --- | --- |
| persistent | Exactly one matching occurrence exists on each side. |
| new | A complete new result contains an occurrence not present in the complete baseline. |
| not_observed_again | A baseline occurrence was not reported in the complete new result. This does not mean resolved. |
| incomparable | Configuration, model availability, ordering, or duplicate matching candidates prevent a reliable comparison. |

Comparison never changes disposition or policy and never inherits a previous occurrence's human
state. Ambiguous groups are kept visible rather than paired by model ID or presentation order.

## HTTP and Dashboard

The base path is
`/api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/requests/:requestId/jobs/:jobId/findings`.
It provides a paginated list, `/comparison` with an explicit baseline tuple, an occurrence's
`/history`, and `POST /:occurrenceKey/disposition`. Every operation uses M19's session-bound database
path; mutations also retain Origin and recovery read-only guards.

The result drawer provides complete finding content, disposition controls, immutable history, and
an explicit comparison baseline. Foreground refresh preserves drafts and updates Run policy and
human-decision applicability when another operator changes a disposition. Permissions or session
changes do not reuse another principal's cached records. The page distinguishes reported findings
from unresolved blockers and human records from execution evidence.

Connected mode provides the complete workflow. Development sample mode retains original model
display and explicitly declines simulated disposition/comparison writes, since independent sample
stores cannot establish an authoritative shared policy or audit. HTTP errors never select a sample
fallback. Tests and acceptance use isolated synthetic data; no GitHub PR or Issue is modified.

## Recorded verification

Final Linux regression passed 3,623 Server tests with one skip and 878 contracts/domain/Codex/source
boundary tests. Dashboard passed 2,125 tests, formal type checking, and production build. Eleven
real DatabaseClient tests cover policy changes, optional findings, stale context, historical edits,
Issue observations, and a 32 MiB evidence-preparation race in which reopening a finding prevents
approval of the old result-set digest while heartbeats continue.

Migration checks preserve every old decision field and JSON byte, exercise commit and rollback,
retain foreign-key integrity, and reject replacement bypasses. Full-content read and comparison
checks preserve original ordinals and duplicate model IDs. A regression also verifies that twenty
legal escaped findings remain readable when their serialized page exceeds 1 MiB; the 2 MiB
response boundary preserves complete content and actor metadata.

Connected acceptance used two explicitly prepared synthetic results with twelve findings each.
Real HTTP and browser actions recorded exactly five disposition events, two projections, and one
platform approval. Reopening blocked eligibility and invalidated the earlier approval; resolving
restored eligibility without restoring that approval. The original ordinal-eight finding retained
its complete 1,228-character body and tail marker. Explicit comparison returned nine persistent,
one new, one not-observed-again, and four ambiguous occurrences. Four stable screenshots and an
empty browser-console error list corroborate the HTTP and database checks.

All forty-eight pre-existing non-authentication tables retained their complete row hashes,
including both original result/report JSON records. The temporary Server and tunnel stopped before
their fixed deadline and released their ports. See
[the acceptance report](../../artifacts/m21-findings-20260907/REPORT.md) and
[browser evidence](../../artifacts/dashboard-e2e/m21-verification.json).

The connected exercise authenticated one fixture administrator and submitted synthetic Worker
results during setup. It did not execute a compiler, model, GitHub checkout, or new Windows/Web
scenario. Lower-role, conflict, and Issue-observation behavior has automated integration coverage,
but actual OIDC and lower-role browser sessions remain separate deployment acceptance work.
