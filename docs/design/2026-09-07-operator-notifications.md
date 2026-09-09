# Operator notifications

Status: M31 implemented and accepted against an isolated connected fixture. The final browser
session passed 39 commands and all 35 coverage requirements. M30 publication acceptance remains
historical evidence; neither milestone authorizes any actual PR or Issue mutation. See the
[acceptance report](../../artifacts/m31-notifications-20260907/REPORT.md).

## Product behavior

The application needs to surface recorded completion and failure without making an operator
poll every Run. An all-repository overview shows unread activity grouped by repositories the
current operator can read. Its bell reports a capped unread count. Selecting a repository opens
the corresponding event inbox with PR/Issue and unread/read/archived filters. The overview uses
repository counters; it does not fetch every repository's results or interleave unbounded scans.

Events link to the exact historical Run/request/Job or publication outbox. A newer rerun must not
replace the selected Job. Opening a notification, refreshing, or reading a result does not change
personal read state. Explicit single-row or selected-row actions mark notifications read, unread,
or archived. These personal actions require read permission, not review/configure permission.

A succeeded validation Job means that a valid report was recorded. Its notification says
validation completed and shows measured check counts, missing required checks and lifecycle
blockers. It does not claim current approval eligibility. A publication notification distinguishes
published, failed, blocked and unknown; unknown links to the existing conservative reconciliation
flow without offering a resend shortcut. Notification payloads contain bounded identities,
enumerations and counts, never prompts, findings bodies, logs, publication bodies or credentials.

## Authoritative event recording

Migration 27 creates shared repository events and per-principal personal state. SQL producers
append an event in the same transaction as each associated validation Job entering succeeded,
failed, dead_letter, cancelled, or stale. This includes queued cancellation, ingestion staleness,
invalid claim candidates and lease expiry. retry_waiting and cancel_requested are not terminal.
The unique source key is the validation Job ID; an operator rerun has a distinct Job and event.

Publication outcome events are derived from immutable publication_attempt_events inserts, keyed
by that exact source event ID. This covers preflight blockers and lease recovery as well as the
normal publisher. A separate unknown-to-unknown reconciliation is a new recorded outcome; replay
of an existing confirmation or control does not create another notification. Event source scope
and result identity must agree with existing immutable Run/request/Job/intent associations.

Repository sequences provide stable keyset ordering without exposing a global sequence. The
repository candidate window is at most 256 records; state/kind filters are applied within that
window. An empty filtered page can still have an older cursor and explicitly reports a limited
scan. No exact all-event count or deep OFFSET query is used for the event inbox. The overview's
repository pagination is separate from event pagination.

## Personal state and authorization

An absent personal row means version 0/unread. Explicit state changes use CAS and a retained
change ID, with at most 50 unique selected notifications in one atomic request. Current repository
permission is checked before reading or replaying a receipt. The actor is injected from the
authenticated session, never selected by a request body. A retry with the same actor and exact
payload returns the original receipt; conflicting content or versions require a refreshed view.

All queries apply current repository authorization before returning rows, counts or personal
receipts. Membership, existing read-state rows and source IDs are not alternative credentials.
The Dashboard includes repository, principal, authentication epoch and current access state in
query ownership. Access checking, revocation, failed authorization or a new session removes old
rows, counts, selection and result content; late responses cannot restore the previous view.
The same rule applies to exact Job/Run/publication links and browser back/forward navigation.

## Retention and bounded work

Events start when this migration enables recording. Earlier terminal rows are not retrospectively
presented as new notifications; normal Run and publication history remains independently available.
The API exposes the actual recording start and retained boundary.

Retention uses 90 UTC calendar days. Shared totals and personal read/archived counters are bucketed
by recorded UTC day. A monotonic day boundary removes expired buckets and events from visible
queries together. Physical cleanup subsequently deletes bounded batches of old state, receipt and
event rows without an unbounded cascade. Deleting an expired read-state row must never make an
old read notification visible as unread or produce negative counts during intermediate commits.
Repository sequence allocation remains monotonic even after its last event expires.

An internal background reaper performs bounded maintenance and drains on shutdown. The maintenance
RPC is not on the operator allowlist and has no HTTP route. Recovery maintenance does not start the
reaper or permit personal-state writes. Inbox reads do not run evidence verification, evaluation,
publication delivery, or real upstream operations.

## Integration and acceptance

The implementation includes strict contracts, migration/transactions, owner RPC integration,
authenticated routes, scoped Dashboard adapters, the repository overview/inbox/bell and exact
result navigation.
Contract and presentation checks may run on the explicitly authorized local machine; production
SQLite/owner/lifecycle verification runs on Linux/test-env. Preserve all failed artifacts.

Acceptance must prove real producer events for a completed result containing failed checks,
terminal execution failure/cancellation, repeated receipt replay, publication uncertainty and
GET-only reconciliation. Two repositories with the same work-item number and two distinct
operators must retain independent events, scopes and personal state. Verify CAS batch rollback,
lost-response replay, retention at every intermediate cleanup step, candidate limits, capped
counts, current ACL loss and restoration, exact historical result links, and browser navigation.
All upstream responses are isolated mocks; no actual repository write is allowed by this plan.

Connected acceptance also exposed and repaired publication read loops after 404 responses and
loss of uncertain confirmation state during access rechecks. Terminal read guards retain active
error queries without polling or evicting sibling resources. Verified permission rechecks keep
the same pending confirmation mounted, hide its body and consent, and disable its actions.
Explicit semantic keys survive Ant Space Fragment expansion; repeated effects for the same
preview fingerprint do not erase the original request. Real permission or identity changes still
invalidate the old view. The final browser exercised both sequential access-check stages before
replaying the original confirmation bytes and change ID.

Prompt/profile sample-set evaluation and real candidate execution remain separate unfinished
roadmap work. Existing same-configuration finding comparison is not configuration evaluation.
Actual Windows applications, the observed model network-isolation gap, deployment identities and
private checkout remain independent acceptance requirements.
