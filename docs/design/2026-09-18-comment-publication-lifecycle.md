# Comment publication lifecycle and Dashboard tracking

Status: implemented and remotely verified. Actual PR/Issue writes require their own authorized scope.

## Decision

Promote the existing progress outbox into a durable `CommentPublication` that tracks intended and
confirmed content internally. Task execution remains authoritative for investigation progress. The
publication service owns delivery, recovery, and publication history. The Dashboard presents an
ordinary comment delivery history from these server records.

Each repository conversation has one static-analysis comment and one independent E2E comment,
created only when the corresponding channel is enabled and used. Assignment intake, new Tasks,
resumes, and new reports update the same channel comment. A newer accepted cycle becomes its
producer; late events from older Tasks cannot replace that producer's content. A cycle can begin
before a Task exists, and attaching the Task preserves the publication identity.

Retain the existing SQLite transactions, durable outbox, stable comment marker, publisher checks,
and fenced dispatcher. This proposal does not require a message broker, a general workflow engine,
or a Worker rewrite. New conclusion-only replies use the same conversation publisher. Historical
ActionIntent replies remain available for audit and read-only recovery. Verified historical
comments can be adopted with their exact publisher, marker, external ID, and previous body;
ambiguous writes block a new create until resolved. Migration never deletes existing GitHub comments.

## Starting point before this implementation

The current progress outbox already stores `desired`, `published`, a frozen `operation`, and a
processing lease. Task transitions and the desired publication update share a transaction.
Its external transport verifies the publisher, repository, comment owner, conversation, marker,
and expected previous body before an edit. These are the foundations to preserve.

The current receipt projects `operation ?? published ?? desired` into one stage. This hides the
distinction between a completed Task and a comment still displaying an earlier stage. Historical
transitions and attempts are overwritten. The Dashboard exposes only recent delivery snapshots
inside repository settings, without Task-level summaries, pagination, or recovery actions.

Failed or exhausted unknown deliveries can stop permanently even when the Task later completes.
The acknowledgement is currently queued only after import and Task creation. Non-completed
terminal Task states share a failure heading, and any settings version change blocks pending
publication even when it only changes template wording.

## Ownership and invariants

1. Task or assignment-intake state describes the investigation. Publication state describes
   synchronization. A GitHub failure never changes a successful Task into a failed Task.
2. An accepted business transition and its desired comment revision commit atomically. No network
   request or publisher identity lookup runs inside that transaction.
3. A confirmed comment revision advances only after a validated response or read-only reconciliation.
   A generated revision, attempted request, or elapsed timeout is not confirmation.
4. A publication serializes writes to one remote comment. A slow response cannot erase newer local
   intent. An ambiguous earlier request must be resolved before a newer write can overtake it.
5. Finished attempt receipts and content revision inputs are immutable. Recovery appends evidence
   instead of rewriting the earlier failure or unknown outcome.
6. Enabling a feature, saving a template, migrating records, or opening a page never backfills old
   Tasks or silently creates replacement GitHub comments.
7. Source snapshots remain complete. Public comments expose safe progress and report content,
   not private execution diagnostics or credentials.

## Two independent state dimensions

### Investigation progress

The public progress view derives from existing intake, Task, attempt, and checkpoint records. It
does not introduce a second executor state machine.

| Public state | Source and meaning | Expected next step |
| --- | --- | --- |
| Received / Preparing | Authorized assignment accepted; source preparation is incomplete | Prepare the frozen investigation input |
| Queued | Task exists and has not been claimed | Wait for an eligible Worker |
| Running | Worker owns a valid lease | Continue the recorded investigation phase |
| Waiting for action | Work cannot proceed without information, environment, budget, or authorization | State the specific responsible party and action |
| Interrupted | Execution stopped without a complete result | Explicit resume when prerequisites are restored |
| Cancelled | Cancellation became effective | No automatic continuation |
| Failed | Execution failed before a complete result | Show a safe reason and available recovery |
| Completed | A complete report was sealed | Present its conclusion and recommended follow-up |

An execution retry is an attempt attribute, not an invented Task state. Display "Queued for resume"
or "Running, attempt 2" when supported by saved attempts. Do not promise automatic resume where the
current workflow requires an operator. A complete triage report requesting more information is
`Completed` with that assessment; it is not a system failure. Completion never implies merge readiness.

### Comment synchronization

| Sync state | Meaning | Service response |
| --- | --- | --- |
| Not enabled | No publication was enrolled for this cycle | Explain the current configuration; no retroactive send |
| Pending | A newer desired revision needs delivery | Observe queue and next attempt |
| Sending | An owned attempt is preparing or submitting the revision | Observe; do not start another writer |
| Synced | Desired revision equals the last confirmed revision | Show confirmation time and the GitHub link |
| Retrying | A proven safe, retryable failure has a scheduled retry | Show reason and next attempt time |
| Unconfirmed | A write may have succeeded but its result is unresolved | Reconcile the exact operation using reads |
| Paused | Authorization, configuration, or operator policy prevents writes | Explain which prerequisite must be restored |
| Needs attention | Retry budget exhausted, content cannot be rendered, or another terminal delivery problem exists | Offer the applicable recovery action |
| Conflict | Remote comment was changed, deleted, or has ambiguous ownership/candidates | Require a separately reviewed repair |

`Synced` means confirmed at a recorded time. It does not claim continuous knowledge of subsequent
manual GitHub edits. The API also returns a structured `reasonCode`, a public explanation, a
`requiresAttention` flag, and server-derived available actions. Exhausting reconciliation retries
keeps the state `Unconfirmed` and raises that flag; it never converts uncertainty into proof of
failure. Transport errors and investigation errors use separate fields.

## Persistent model

Use three logical domain records, with ordinary indexes and bounded pagination. The exact public
contracts are defined in `packages/contracts/src/investigation-comments.ts`; publication revisions
remain internal, while actual attempts use the dedicated comment delivery collection.

### CommentPublication

One aggregate per logical comment:

The durable scope is `(repository ID, conversation kind, conversation number, static | e2e)`.
Repository and GitHub conversation identities are checked before reuse. Task and assignment
indexes point to this aggregate; they are not comment identities. Delivery attempts retain the
Task that produced their frozen body, while task-scoped summaries expose the current producer
and the queried associated Task IDs. A preparing assignment can attach only its own unbound
delivery attempts. Historical duplicate comments are retained with their writers retired; multiple
unresolved historical writes require reconciliation before the shared writer can proceed.

```text
id, version
repository identity, target kind, GitHub target ID, target number
mode: progress | result
canonical assignment receipt reference?, taskId?, reportRef?
trigger identity, receivedAt, firstStartedAt?, lastActivityAt?, completedAt?
publisher identity?, externalCommentId?, commentUrl?, stableMarker
desiredRevisionId, confirmedRevisionId?, lastConfirmedAt?
syncState, reasonCode?, nextAttemptAt?, automaticRetryCount
activeAttemptId?, dispatch lease and fencing token
authorizationEpoch, render schema version
createdAt, updatedAt
```

`version` supports compare-and-swap API commands. It is not a content revision number.
`taskId` is nullable while an assignment is preparing. The numeric target identities and canonical
receipt establish that early scope; no placeholder Task is created.

### CommentRevision

Append an immutable revision when a meaningful public change is accepted:

```text
id, publicationId, sequence, sourceEventId
public progress snapshot, attempt number, source revision, timestamps
safe reason and next action, sealed report reference?
template version and snapshot selected for this update, immutable render inputs and content digest
createdAt
```

These are local application versions, not GitHub revision numbers. Unique source-event binding
prevents a replay from generating duplicate versions. Heartbeats alone do not generate revisions.

A new logical comment update selects the latest saved template, including updates for an already
running Task. The revision stores that template version/snapshot and immutable render inputs;
publisher identity discovery remains asynchronous.
The first prepared delivery freezes the exact rendered body, verified publisher identity, and
body digest for that revision. Subsequent attempts reuse those bytes. A generated revision alone
does not create a Dashboard delivery-history entry. The body appears with its create or update
attempt, whether that attempt succeeds, fails, or has an unknown outcome.

### CommentDeliveryAttempt

Keep every create, update, and reconciliation attempt:

```text
id, publicationId, revisionId, attemptNumber
operation: create | update | reconcile
reconcilesAttemptId?, retryOfAttemptId?, initiatedBy
frozen rendered body/reference, body digest, publisher identity
expected remote comment ID, expected previous body digest, request identity
preparedAt, dispatchedAt?, finishedAt?
effect: not_sent | rejected | applied | unknown
errorCode?, public reason?, retryable?, HTTP status?, externalCommentId?
```

Preparation and the dispatch fence are durable before the network call. An unfinished attempt can
advance through those steps; a finished receipt is immutable. A later reconciliation has its own
record pointing to the original write. A crash after the dispatch fence becomes `unknown`, never
an assumed unsent request.

The internal audit records retain revisions and attempt receipts. Revisions superseded before
dispatch remain inspectable without being unnecessarily posted. The Dashboard delivery history
contains actual create/update attempts only. Reconciliation evidence belongs to the associated
attempt's details and can resolve its displayed outcome without changing the immutable receipt.
Task progress events remain in Task records. Internal identifiers and raw transport details stay
in operator diagnostics.

## Publication algorithm and recovery

1. Commit the business transition, new desired revision, and outbox wake-up record together.
2. Claim the publication with a renewable lease. Resolve any dispatched but unresolved operation
   before preparing a new write.
3. Select the newest eligible desired revision for either the first POST or a later PATCH.
   Normally the first revision promptly acknowledges receipt. If delivery is delayed until work
   has started or completed, create the comment with that current state and retain the received
   time and trigger in its history. Intermediate unsent revisions can be superseded; do not replay
   obsolete preparing/running messages merely to expose every internal transition. An earlier
   in-flight request can temporarily leave confirmed state behind desired state; finish or
   reconcile it before applying the newer revision.
4. Verify the current target, publisher, authorization epoch, and account grants. Render outside
   the business transaction, then freeze the exact request and body under the current fence.
5. Immediately before dispatch, recheck ownership and whether the selected update was superseded.
   Persist the dispatched marker before performing at most one mutation for that attempt.
6. On confirmed success, advance the confirmed revision and append the receipt. If desired is
   newer, continue toward it. Otherwise the publication is synced.
7. On failure, use the structured effect and retry classification below. Do not infer whether a
   write happened from a generic exception message.

| Outcome | Recovery policy |
| --- | --- |
| No request was dispatched; transient local/read failure | Bounded exponential backoff with jitter |
| Upstream definitively rejected the write and permits retry | Retry the same frozen body within policy and server rate limits |
| Upstream rejected identity, permission, or conversation ownership | Pause or mark conflict; do not repeat blindly |
| Response lost, timeout after dispatch, or crash after dispatch fence | Read-only reconciliation first |
| Readback proves the exact body, owner, marker, and target | Confirm the original revision and continue toward latest desired |
| Readback after an ambiguous update still shows the frozen expected previous body | Remain unconfirmed; this does not prove that the earlier request cannot still apply |
| Readback finds an unexpected body, changed ownership/marker, or multiple candidates | Conflict; retain all observations |
| Readback cannot find a possibly-created comment | Remain unconfirmed; absence alone does not authorize another POST |
| Retry/reconciliation budget exhausted | Keep desired state and a durable attention record; expose recovery |

Use a default bounded retry policy, initially three automatic attempts with approximately
10/20/40-second backoff where applicable; honor stronger upstream retry constraints. Reconciliation
has its own read budget. New desired revisions do not reset an unresolved-write budget or create
a duplicate POST. A newly available terminal result can supersede an unsent failed intermediate
revision only when the earlier operation is proven not applied and the retry policy allows it.

The transport retains the existing owner/target/marker/body checks. Stable markers support lookup;
they do not make GitHub POST exactly-once. Manual remote edits and deletion require explicit repair
scope. A normal Refresh or Reconcile control never performs a GitHub mutation.

## Earlier acknowledgement and cycle identity

The earliest local boundary is the existing signed, authorized, durably accepted assignment receipt.
Create its publication in the same transaction with public state `Preparing`, then let intake and
publication proceed independently. Before the first remote comment, still verify the exact remote
repository, work item, and applicable assignment grant. Large source/comment imports are not a
prerequisite for an acknowledgement. Import failure can therefore update the same publication.

Extract a minimal trusted `CommentTarget` from the accepted receipt: registered repository identity,
GitHub work item ID, kind, and number. The current transport must explicitly support this pre-Task
target; moving the existing Task-dependent enqueue call is insufficient.

Canonicalize assignment admission before a first POST can be scheduled. Retransmitted deliveries
and equivalent events resolve to the same canonical receipt/publication. Repeated assignments for
an already active investigation of the same target, reviewer, kind, and PR revision join that cycle.
They do not create another progress comment or silently restart its Task. Issue assignments join
the active cycle for the same target/reviewer; an explicit new assignment after completion can
start a new cycle. A new PR revision starts a distinct cycle with an explicit source relationship.

Webhook Task idempotency should bind this canonical admission ID. The imported snapshot remains
an immutable input binding, rather than serving as a second independent decision about whether a
new cycle exists. This avoids discovering two acknowledgements belong to the same Task only after
both have already been posted. Manual Task idempotency remains unchanged. This admission change
must be verified independently from comment delivery before early acknowledgements are enabled.

Our own acknowledgement can appear in the subsequently imported conversation. Preserve it in the
complete raw snapshot and annotate verified application-owned comment IDs as progress metadata in
the model input. A marker copied by another author is not proof of ownership. Do not silently drop
discussion, treat our comment as a new human instruction, or let its update timestamp alone create
another investigation cycle. Keep existing source-change detection and bounded import retries.

## Public comment format

Use a stable, server-rendered status card around four configurable English narrative layouts:
received/preparing, working, attention/stopped, and completed. The renderer always supplies the
current status, trigger, source scope, relevant times, and next action. An optional short history
retains first receipt/start, resume, and completion without including heartbeat noise.

Every comment begins with a server-owned identity statement, including received, started, stopped,
and completed updates. It identifies the author as an AI assistant operating through Agentic Review
and names the verified GitHub publishing account on whose behalf it acts. The statement is outside
editable narrative templates, so a template change cannot remove or falsify this disclosure.
The assignment sender and recipient do not supply the publishing identity.

Before a model identity is recorded, use:

```markdown
I'm an AI assistant running through Agentic Review on behalf of GitHub user `@[publisher]`.
```

Once trusted execution records establish the model identity, use:

```markdown
I'm [recorded model], an AI assistant running through Agentic Review on behalf of GitHub user `@[publisher]`.
```

Use actual recorded model identities, including multiple models where applicable; never guess a
model before execution or take its identity from model-generated prose. Reuse the existing report
identity/disclosure section at the top of completed comments rather than duplicating it inside the
embedded result. Preserve the identity statement with every saved delivery body.

The attention layout has a dynamic status heading and a safe reason; cancellation and interruption
must not inherit a hard-coded failure heading. The received layout must not claim that a Task is
queued before one exists. The working layout uses recorded phase and attempt information only.

Completed content reuses the existing PR/Issue report rendering. Surface conclusion, validation
level, reviewed commit or issue snapshot, and next steps before collapsed details. If the current
PR head differs from the reviewed commit, show the scope difference without claiming the earlier
review covered the new code. Publishing never implies approval or merge authorization.

If the full comment exceeds the supported size, still publish an accurate completed status and
safe conclusion summary. Preserve the complete report in the Dashboard with an access-controlled
link when an externally usable Dashboard URL is configured. Explicitly label that the full report
is not embedded. Do not expose an internal/private URL or silently truncate findings. Without an
appropriate link, explain that the complete report is available to repository operators in the
Dashboard and surface the delivery limitation there. A public report export is a separate feature.

Apply template changes to subsequent logical comment updates, including updates within an already
running Task. Saving a template does not itself rewrite any published comment or create an outbound
update. When the next lifecycle event produces a new revision, select the latest saved template
and record its exact version and snapshot. Already generated revisions and their delivery history
remain unchanged. A retry or reconciliation of a prepared/dispatched update reuses its frozen body;
it is recovery of the same update, not a new update rendered with another template.

For example, a Task's received comment can use template version 1. If the template is then edited,
its next running or completed update uses version 2. The existing GitHub comment remains unchanged
until that next update; the Dashboard retains the earlier version 1 body and its delivery records.

`settingsVersion` remains an edit-concurrency version; `authorizationEpoch` changes when publication
authority is revoked or its security scope changes. Keep the grant's `authorizedById` separate
from template `updatedById`: editing wording does not transfer standing authority to the editor
or revoke an active publication. Re-enabling a revoked grant does not silently resume previously
paused writes; a scoped resume command binds the reviewed current authority.

## Worker liveness and progress frequency

Run Task lease-expiration handling on a server timer, initially every 30 seconds, independent of
Dashboard traffic and new Worker claims. The persisted lease is the source of truth; the timer
does not create a second timeout rule. Record an interruption and its desired comment revision
atomically when expiration takes effect.

Record Worker heartbeat activity locally for the Dashboard. Publish meaningful phase changes,
effective stop/resume events, and final outcomes. Ordinary running phase updates are coalesced and
rate-limited, initially to at most one every two minutes per publication; acknowledgement and
terminal outcomes are not delayed by that cosmetic-update interval. Do not turn every heartbeat
into a GitHub edit or claim model progress from elapsed time alone.

## Dashboard information architecture

### Task list

Add a `GitHub comment` column beside `Execution`, showing only comment status and the latest delivery
attempt time. A completed Task remains completed even when comment delivery fails or its outcome is
unknown. Include lightweight comment summaries in the list response as an opt-in batch expansion;
avoid one request per row.

### Task details

Use one `Comment delivery history` component after the Task summary and before the full report.
Each row represents an actual attempt to create or update the comment and shows:

- Attempt time and operation (`Create` or `Update`).
- Delivery status, such as sending, delivered, failed, or outcome unknown.
- The body used for that attempt, collapsed until the row is expanded.
- A safe failure or uncertainty reason when applicable.
- The GitHub comment link and server-authorized recovery actions when available.

A failed or unknown attempt still retains its own attempted body; its status must not imply that
GitHub accepted it. If preparation failed before a body existed, explain that no body was prepared.
With no create/update attempts, show `No comment delivery attempts yet`.

There is no separate default body panel, body selector, or target/confirmed version comparison.
Generated content that was never attempted does not appear in this history. Task progress stays
in the Task's existing records. Reconciliation and retry details can be expanded within the
relevant delivery record, with each new create/update attempt retained as its own row.

Example:

```text
Comment delivery history
Time (UTC)   Operation   Status          Details
14:10        Update      Outcome unknown Request timed out; awaiting readback. [Expand]
14:05        Update      Delivered       [Expand]
14:00        Create      Delivered       [Expand]
```

Expanding a row shows the exact saved body for that attempt and its delivery details. The report
remains in the existing Report workspace.

### Comments workspace

Add a repository-scoped `/comments` workspace using the same delivery-history component for
progress and conclusion-only comments. Add repository, PR/Issue, and Task columns to the same
attempt time, operation, status, expandable body, and reason fields. Support repository, PR/Issue
number, Task, delivery status, and time-range filters. Use server-side cursor pagination ordered
by attempt time and stable ID, not a client-side slice of the most recent 20 rows. Store filter
state in the URL and keep stable delivery-record links.

Create/update attempts made before Task creation appear in the same list with their repository
and PR/Issue target; the Task cell remains empty until the existing record can link to its Task.
An accepted assignment or a generated revision alone is not a comment delivery record.

Repository settings keep switches, templates, and small operational counts linking to Comments.
They are not the primary publication history page. Reuse the current DataTable, Chip, Accordion,
code/body preview, scope controls, and action-guard presentation rather than introducing another
Dashboard visual system.

### Refresh behavior

Comment polling follows synchronization state independently of Task polling. An active comment
continues refreshing after its Task completes. Start with five-second polling for pending/sending
states, a scheduled check around the next retry, and a slower refresh for unconfirmed/attention
states. Stop dense polling when stable or the page is hidden, and refresh on focus or manual request.
This is local API polling; a page refresh does not trigger a GitHub write or live readback.

## API and access rules

Runtime resources:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/comment-deliveries` | Scoped, filtered, paginated create/update delivery history |
| `GET /api/comments?taskIds=...` or `?commentIds=...` | Bounded batch status summaries |
| `GET /api/comments/:id` | Comment status, latest delivery attempt time, target link, and available actions |
| `GET /api/comments/:id/attempts` | The same delivery-history records scoped to one comment, with expandable attempt evidence |
| `POST /api/comments/:id/reconcile` | Schedule only a remote read and record the observation |
| `POST /api/comments/:id/sync` | Schedule a safe authorized synchronization to a specific desired version |

Commands include an idempotency key and expected publication/desired version. Return conflicts
for stale UI commands. `sync` cannot override an unresolved earlier write, authorization revocation,
or a foreign/modified comment. Both actions return durable operation references for delivery details.
An explicit resume of paused publication requires current publication grants and binds their epoch.

All reads require repository scope. Active reconciliation requires `action:prepare` and the
`comment` capability. Synchronization additionally requires `action:execute` and a valid standing
publication grant whose authorizing account still has the required management/publication rights.
The server returns available actions rather than letting the UI infer them from a status label.
Commands require current origin/session checks. Actual remote mutations additionally require
exact target/publisher binding and the external-write gate. Raw tokens, private diagnostics, and
upstream response bodies never appear in a public receipt. Product permission checks do not
authorize automated live verification.

Existing repository reply endpoints remain compatibility adapters during migration. Task list/detail
summary expansion is optional so existing clients and the Task contract need not be replaced at once.

## Implementation organization

1. **Explicit state and history:** the publication contracts, versioned additive storage
   migration, revisions, attempt receipts, and delivery-history API. Adapt current progress records;
   preserve their exact comment IDs, markers, frozen bodies, unresolved operations, and authority.
   Expose legacy conclusion replies through a read adapter and read-only ActionIntent recovery.
   Adopt verified confirmed replies into the shared conversation publisher without another POST.
2. **Dashboard and recovery:** Task summaries/details, the Comments workspace, structured transport
   outcomes, bounded retries, and controlled reconciliation/synchronization. Add lease-expiration
   scheduling. These changes address silent stale comments before moving acknowledgement timing.
3. **Earlier acknowledgement:** canonical assignment admission, pre-Task CommentTarget support,
   and bind the accepted receipt to the publication. Test import failure, duplicate deliveries,
   self-comment snapshot interactions, and Task attachment before enabling the new behavior.
4. **Presentation and settings:** the fixed comment identity/status fields, precise stopped-state copy, compact
   resume history, template/authorization separation, and the explicit oversized-report fallback.

Migrate in-progress records under a single writer with the old dispatcher stopped or fenced. A
migrated sending/unknown operation remains unresolved until reconciled; migration never sends it
again. For old records lacking history, display the retained snapshot and the date history became
available. Do not invent earlier versions, attempts, or confirmation timestamps.

## Acceptance criteria

- A normal assignment produces one comment, updates it through execution, and shows consistent
  delivery records in Task details and Comments.
- Delayed first delivery publishes the latest true status, preserving receipt history without
  briefly publishing an obsolete preparing state. A timed-out PATCH whose old body is still
  visible remains unconfirmed and is neither mislabeled as a manual edit nor blindly resent.
- Task completion with a failed comment update remains `Completed` plus an actionable sync problem;
  safe recovery reaches the terminal revision without rerunning the investigation.
- A dispatched timeout, restart, expired publisher lease, or duplicate webhook never causes a
  blind second POST. Unresolved operations cannot be overtaken by newer updates.
- Failed, blocked, interrupted, cancelled, and resumed Tasks have accurate headings and next steps.
  A complete needs-information report remains a completed investigation.
- Every stage starts with an AI identity statement and the verified publishing account. Model
  attribution appears only when supported by trusted execution records. Template edits cannot
  remove the identity statement, and completed comments include it once rather than twice.
- Import failure before Task creation remains visible and can update its existing acknowledgement.
  Repeated active assignments and own progress comments do not create duplicate cycles.
- The server detects expired Worker leases with no open Dashboard and no other Worker claim.
- Every prepared body and finished attempt remains inspectable after retry or reconciliation.
  Superseded intermediate revisions are distinguishable from confirmed GitHub updates.
- Task details and Comments use one delivery-history component: each create/update attempt has a
  time, operation, status, expandable attempted body, and failure reason when applicable. There is
  no additional default body panel or target/confirmed version comparison. Unknown attempts remain
  visibly unknown, and generated revisions that were never attempted are absent from this history.
- Manual remote edits, deletion, permission revocation, publisher change, and repository rebinding
  produce explicit safe states and preserve evidence instead of overwriting another author's work.
- Saving a template leaves published comments and historical revisions unchanged. The next logical
  update, including one for an active Task, uses the latest template and records its version.
  Recovery of an already prepared/dispatched update preserves its frozen body. Template edits do
  not strand active publications; revoked authority prevents writes.
- Complete oversized reports retain their full stored content and yield an honest terminal public
  status, without private links or silent removal of findings.
- Pagination, task summaries, pre-Task records, independent polling, and scoped actions work with
  synthetic data and mocked transports. Verification runs on the designated remote environment;
  actual PR/Issue writes require a separately approved live scope.
