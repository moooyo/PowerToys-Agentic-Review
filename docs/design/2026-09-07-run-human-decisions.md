# Revision-bound human decisions

Status: M20a persistence, HTTP, and Dashboard integration pass automated regression and connected
synthetic HTTP/browser acceptance. Finding disposition and Issue reproduction mapping remain
subsequent work under the accepted validation-platform roadmap at this milestone. The later
[M21 finding lifecycle](./2026-09-07-finding-lifecycle.md) implements disposition-aware policy and
V2 decision snapshots while preserving the M20 history described here.

## Recorded meaning

One Run has one ordered human-decision stream. This is an explicit recorded Run decision, not a
vote aggregation, a work-item-wide approval, or a GitHub review. Different Runs retain independent
decisions even when they refer to the same source revision.

PR actions are `approve`, `request_changes`, `comment`, `override_approve`, and `withdraw`. Issue
actions are `request_changes`, `comment`, and `withdraw`; the Issue UI labels the first action
"Request more information". None changes the runner's reproduction conclusion. A reason is
required for every action.

Ordinary actions require repository `review` permission. An exception approval requires
`configure`, available to maintainers and administrators. Withdrawing another operator's decision
also requires `configure`; its author may withdraw with `review`. Both cases require the explicit
current target decision ID. The Server derives the actor from the authenticated session.

Every event increments a shared stream version. A comment does not supersede the recorded
decision. A withdrawal is a tombstone; it does not expose an older approval as current. A reviewer
may explicitly replace an ordinary decision after reading the current stream version. This slice
does not add quorum, independent votes, or branch-protection behavior.

## Exact result binding

The Server generates a `ReviewRunDecisionSnapshotV1` inside the final SQLite transaction. It binds
the repository, work item, Run, plan, activation, request epoch, revision, source sequence, and
current repository authorization facts. It includes every planned request, even optional requests
and requests with no Job. Each request identifies its latest Job activation, last attempt, and
accepted result ID and digest when present.

The canonical snapshot digest is the result-set identity submitted by the Dashboard. The complete
snapshot is retained privately alongside the event. Prompt text, commands, evidence bodies, and
mutable display previews are not copied into it. The frozen plan digest already binds execution
configuration and exact tested source.

A rerun changes the result-set identity as soon as its new Job is queued. An infrastructure retry
changes the attempt identity. Returning from source A to B to A changes the observed source
sequence and cannot reactivate an older human decision. A manual Run for the now-current exact
revision may receive a new decision after a new review; an obsolete automatic source activation
remains obsolete. Missing source metadata cannot establish current approval authority.

Heartbeat timestamps, elapsed time, progress messages, phase labels, evidence-cache hits, and
temporary verification status are excluded from the digest. Evidence availability and approval
policy are evaluated again when reading or recording a decision. A matching digest alone is not
proof of valid current approval.

## Persistence and concurrency

M20 stores immutable decision events with a Run-scoped version and idempotency key. A write carries
the expected stream version, revision, plan, and result-set digest. The Server stores its own actor,
time, full result snapshot, and contemporaneous policy. Public receipts include a bounded compact
policy summary; the complete policy is retained privately.

Ordinary state, history, and receipt reads select only public columns and a compact policy summary.
They verify a digest of the public receipt and its stream relationships without loading private
policy or snapshot JSON. The append boundary validates the complete private record once, and
database triggers prohibit replacing, editing, or deleting events. Private audit bodies remain
under that trusted immutable storage boundary; ordinary reads do not claim to rehash those bodies.

Authorization precedes idempotent replay. An identical accepted intent returns its original
receipt even after later comments, withdrawal, rerun, source changes, or evidence expiry. The
receipt describes a historical accepted event and never promises that the decision is still
current. Reusing the key with a different actor or intent conflicts. Revoked access cannot be
recovered by replaying a receipt.

New events must pass compare-and-swap and all supplied binding checks. `approve` additionally
requires current source authority and satisfied current policy with verified required evidence.
`override_approve` records a qualified exception; it cannot bypass source identity, access control,
or recovery mode, and it does not modify checks or policy eligibility. `request_changes` also
targets the current source. Comments and withdrawals can annotate a historical Run after refreshing
its current result-set context.

Evidence preparation occurs outside database transactions. The final short transaction rechecks
current access, consumes the prepared proof, reads the complete result-set snapshot and policy,
checks the expected version, and inserts the event. No transaction crosses an asynchronous wait.
An already accepted receipt is replayed before evidence preparation, so evidence retention cannot
prevent reading the receipt.

## HTTP and Dashboard

- `GET /api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/decisions` returns the
  current binding, stream version, policy, recorded decision, and its current applicability.
- `GET .../decisions/history` returns at most 20 immutable events per page.
- `POST .../decisions` records one event or replays its accepted receipt.

All operations use M19's session-bound database path. Mutations retain Origin and read-only
recovery guards. Scope, actor, intent, version relationships, and bounded responses are validated
at their boundaries. A repository viewer may inspect decisions but cannot create them.

The Run panel keeps policy eligibility separate from "Recorded run decision". A historical
approval stays an approval event while its applicability becomes stale or ineligible. An exception
approval is always explicitly qualified. The panel shows the actor, time, reason, source/result
binding, and history, with a statement that nothing has been published to GitHub.

The UI retains reasons after conflicts and failed requests. Exact transport retries reuse the
unchanged intent. A conflict never silently advances the expected version and resubmits; the
operator must refresh, review, and submit a new intent. Successful receipts trigger separate state
and history refreshes instead of optimistic changes to approval eligibility.

## Acceptance and remaining work

Required verification includes concurrent reviewers, comment/withdraw behavior, withdrawal
permissions, Issue approval rejection, required and optional reruns, retry attempts, A-to-B-to-A,
expired evidence, authorization changes during verification, and historical receipt replay. HTTP
and Dashboard checks must distinguish synthetic fixtures from actual deployment acceptance.

The final Linux Server regression passed 3,078 tests with one skip. Contracts/domain/Codex and
production source-boundary suites passed 751 tests. Dashboard passed 1,770 tests, formal type
checking, and production build. Eleven real DatabaseClient tests exercise approved/failed/missing
evidence, role changes, optional reruns, manual A-to-B-to-A, and revocation/rerun during 32 MiB
evidence preparation. The 56 persistence tests include a history page whose twenty private policy
bodies each exceed 2 MiB, while ordinary reads select only public fields and produce less than
32 KiB of output. These checks do not establish real-repository/model or OIDC acceptance.

Connected acceptance upgraded the retained synthetic M19 database to M20. Real HTTP and production
Dashboard actions appended exactly six scoped events: approval, comment, withdrawal, request for
changes, comment, and withdrawal. Comments preserved the earlier decision; the final withdrawal
left policy eligibility true while the human decision was withdrawn. Historical receipts and
conflicts added no extra events. All nine existing business/access tables retained their complete
row digests, and the retained Windows PNG retained its exact bytes and SHA-256. Four stable browser
screenshots, eight DOM observation stages, and an empty console-error list corroborate the API and
database evidence. Temporary services stopped before their deadline and released both ports.
See [the acceptance report](../../artifacts/m20-decisions-20260907/REPORT.md) and
[browser evidence](../../artifacts/dashboard-e2e/m20-verification.json).

The connected exercise used one configured loopback platform administrator and synthetic data.
It did not exercise an actual OIDC provider, live lower-role browser sessions, production models,
repository checkout, or new Windows/Web execution. Those boundaries remain explicit.

Automated acceptance uses isolated synthetic data and does not write to repository PRs or Issues.
Any future live external write requires the user's explicit approval for its targets, operations,
and content, as recorded in the root `AGENTS.md`.

Finding occurrence history and disposition are implemented by M21, using full immutable result
ID/digest, namespace, and original ordinal. Its explicit policy v2 and decision snapshot v2 bind
current disposition versions without reinterpreting historical v1 receipts. Issue reproduction
mappings, production model/repository
acceptance, publication, notifications, and configured execution quotas remain on the full roadmap.
