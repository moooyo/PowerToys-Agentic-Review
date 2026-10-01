# Review Console capability decisions and implementation

This record describes the 2026-10-01 product decisions and the behavior implemented
in the current capability change. It supersedes the current-state claims in the
[initial capability-gap record](2026-10-01-review-console-capability-gaps.md), which
is retained as history. The [Dashboard README](../../apps/dashboard/README.md)
describes navigation, native API usage, and permission boundaries. This document
does not establish test completion, live acceptance, or deployment.

## Native Prompt content and future-task binding

Native PR review and Issue investigation each have a repository-scoped version
catalog. A version contains its name, both source-review and snapshot-analysis
Markdown bodies, creation metadata, and an exact ID/version/content-digest
reference. The built-in version initializes each catalog. Generic legacy Prompt
configuration does not control these native templates.

Repository members can read the catalog. Repository managers can edit a draft and
publish a new immutable version. Publishing preserves the active binding; a
separate operation sets a selected exact version as current. Catalog publication
and binding changes compare the caller's expected version with the saved version
and reject conflicts. Failed catalog reads disable mutation until a successful
read is available.

Task creation copies the selected native content and reference into the task's
`promptSnapshot`. The Worker consumes that content rather than resolving a
mutable catalog binding and checks the kind, reference, and content digest.
Changing the binding affects subsequently created tasks only. Existing tasks,
saved progress, and resumed tasks keep their frozen content. Historical tasks
without a frozen snapshot retain the built-in compatibility behavior without
claiming their old reference identifies catalog content.

Protocol, permissions, execution restrictions, result rules, and dynamic
recipe/prior-review-baseline guidance remain outside editable versions. The
catalog exposes those runtime constraints separately from editable Markdown.

## Source authors, trigger metadata, and GitHub profiles

This change adds source-author metadata without expanding module or Issue-label
metadata. Source import retains a valid GitHub author when supplied. Older work
items can use `GET /api/work-items/:id/author`; the reader checks repository and
work-item identities and obtains only author metadata. It does not refresh or
rewrite a historical work item, source snapshot, task, or report. An unavailable
lookup remains explicit.

Native delivery projections distinguish assignment, Code Review request,
re-request, E2E comment command, and E2E revision observation. A re-request label
is based on the canonical task's frozen prior-review baseline, not on a guessed
transport event or current mutable conversation. An alias receipt remains its
own event and retains its own actor metadata, while exposing its canonical
delivery relationship.

Settings can optionally resolve a GitHub login or numeric user ID to a login and
avatar through `GET /api/repositories/:id/github-users/:lookup`. Saved reviewer
and trusted-actor authority remains numeric. A resolved profile is metadata; it
does not verify a publishing account or its credential scope.

## Webhook address and retained delivery observations

`INVESTIGATION_GITHUB_WEBHOOK_PUBLIC_URL` supplies an explicit canonical public
receiver URL. Without it, the console displays a candidate formed from the
configured public origin and `/api/github/webhook`. The response identifies which
source was used rather than presenting the candidate as a confirmed external
receiver.

`GET /api/repositories/:id/intake-details` returns receiver configuration and
the latest retained signed delivery for that repository, including its ID,
timestamp, and event name. A past receipt is an observation at a point in time.
Neither it nor a configured receiver proves current network connectivity or
service health. The implementation adds no publisher-account identity or
token-scope diagnostics.

## Current comments and immutable finding source

The Comments view retains delivery history and the last confirmed applied body.
`GET /api/comments/:id/current` independently reads the saved upstream comment
using GET requests. It distinguishes present, edited, deleted, not published, and
unavailable observations and preserves the last-confirmed body and timestamp
separately. A failed read does not establish deletion. Deletion is reported only
after the associated repository and work-item checks can support that conclusion.

Reading the current comment does not reconcile a publication, alter a receipt,
queue a write, or repair the upstream body. Historical progress-record formats
are read without migration; their retained body remains available, and current
readback is explicitly unavailable. Historical legacy result publications retain
their original operation workflow and receive no new repost action.

`GET /api/reports/:id/findings/:findingId/source` selects an exact saved finding
location rather than accepting an arbitrary path or branch. The reader binds the
report, finding version, location, subject, immutable commit, and line range. It
resolves the commit's Git tree and blob, verifies the blob bytes, and returns
numbered original-source context. Recorded submodule locations use the saved
child repository and commit.

The console does not substitute a mutable head, replacement suggestion, or
current checkout for original source. No readable immutable commit, inaccessible
source, unsupported subjects such as `local_patch`, and invalid saved ranges
produce an unavailable state. The native coverage ledger remains part of reports,
but coverage counts and coverage details are removed from the console. Saved E2E
feature outcomes remain in native reports rather than a console pass/total count.
Session output continues to show observed
command status without introducing numeric exit codes.

## Worker names, contact, and retained activity

Workers can have a configured display name, with their saved ID as the fallback.
Authenticated Worker requests provide the Server's last-contact observation.
The Server projects contact freshness separately from active task ownership and
cleanup leases. This supports Online, Busy, Offline, Cleanup pending, and explicit
unconfirmed labels without claiming an independent operating-system or process
health check.

Expired contact does not erase retained ownership or make a desktop appear idle.
When available, the console shows the owned task and its last recorded stage.
Admission changes retain the versioned administrator-only E2E policy. Disabling
can request stopping active execution and still await cleanup confirmation.
Worker read failures disable mutations, including an already-open confirmation;
a successful refresh is required before acting on current state.

## Completed reports and saved-report delivery recovery

The **Completed · Publication unconfirmed** group remains. A complete Review can
have automatic replies disabled, missing delivery, or an uncertain publication
without becoming a failed Review or increasing the attention badge solely for
missing publication. Related activities retain their current selector pending a
later product discussion.

`GET /api/tasks/:id/publication-recovery` determines whether the exact complete
final report of an eligible completed native root task can be delivered. Supported
roots are PR review, root PR E2E, and Issue investigation. Child/saved-plan tasks,
unavailable or mismatched reports, changed target identities, legacy workflows,
and missing authorization or publisher prerequisites remain blocked.

A newer root task or native publication for the same conversation and channel
blocks recovery of an older report. An existing native publication retains its
normal versioned `sync`/`reconcile` workflow. If an older write is uncertain, the
operator must reconcile it before the report can advance. Failed status reads
disable recovery actions until the state is read successfully.

For a missing eligible publication,
`POST /api/tasks/:id/publication-recovery` compares the exact state version and
report ID and uses an idempotency key to enroll delivery in the native publisher.
This operation reuses the saved report. It does not rerun investigation, create a
Worker attempt, or schedule another model invocation. New native delivery reuses
the same GitHub conversation comment; every saved report and delivery revision
remains available. Exact-report receipts identify previously posted results
without asserting that their old body is still the current comment.

## Execution limits and removed disposition

The 2026-10-01 capability change retained the then-existing token, round, and
duration limits. The subsequent 2026-10-02 product decision replaces execution
quotas with a fixed cumulative two-hour allowance, removes token and round caps,
and preserves report capacity as a storage safeguard. See the
[time-only execution policy](2026-10-02-time-only-execution-budget.md) for current
behavior, resume boundaries, and historical compatibility.

Ignore/dismissal controls, undo, the dismissed group, and reads of old browser
dismissal storage are removed. Old stored choices therefore cannot continue to
hide records. Intake's protocol `ignored` state continues to describe a rejected
event, not a team or personal Review disposition.
