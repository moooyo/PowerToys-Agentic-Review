# Agentic Review Console

The Dashboard is the monitoring and recovery console for native PR Reviews and
Issue investigations. It uses React 19, Material UI 9, React Router, TanStack
Query, and Vite. `src/app.tsx` registers the console shell and
`src/console/` contains its Inbox, record detail, and Settings views.

The console follows the Review Console handoff: an 88px navigation rail, a 72px
header, a grouped Inbox beside record details, and seven Settings sections.
Desktop layouts around 1100px and wider are the primary scope. Both Chinese and
English and both light and dark themes are available without reloading.

## Navigation and records

| Route | Behavior |
| --- | --- |
| `/inbox` | Review records for the selected accessible repository. |
| `/settings?section=intake` | Event intake configuration and recent deliveries. |
| `/settings?section=replies` | Automatic conclusion and progress replies and templates. |
| `/settings?section=prompts` | Native Prompt content, immutable versions, and the binding for future Reviews. |
| `/settings?section=execution` | Shared static concurrency and fixed E2E capacity. |
| `/settings?section=workers` | Administrator Worker admission controls and contact information. |
| `/settings?section=accounts` | Administrator local account management. |
| `/settings?section=profile` | Current account, session expiry, password change, and logout. |

`repositoryId` selects an accessible repository. `recordId`, `taskId`, and
`workItemId` select a Review when its record is available. Legacy `/webhooks`,
`/repositories`, `/workers`, `/accounts`, and `/account` paths open their
corresponding Settings section. Other paths open the Inbox shell. The old separate
PR, Issue, Task, Report, and Comment page navigation is no longer registered.

The Inbox groups records by needs attention, in progress, published, and completed
with unconfirmed publication. Completed reports without a confirmed
publication are kept outside the attention badge and are not labelled published.
It prefers the first record needing attention, then the first active record.
Search matches the number, title, and any available module metadata without case
sensitivity; matching records are displayed without groups. Selecting a repository
uses that account's explicit repository grants.

Ignore, dismissal, undo, and the dismissed group have been removed. The console
does not read old dismissal storage, so a prior browser reminder choice cannot
hide a Review. Intake's protocol-level `ignored` receipt state still describes an
event rejected by intake policy; it is not an operator disposition.

Each record has a four-step Trigger, Review, Report, and Publish presentation.
The detail reader checks report ownership against the exact repository, source,
and native execution identity. Repeated Reviews retain their own source revision
and report identity; a successful older publication must not establish that a
newer Review has been published.

The source author is shown when recorded metadata is available. Older work items
can obtain author metadata through a read-only GitHub lookup that checks the saved
repository and work-item identities. That lookup does not refresh historical
source snapshots or add module and Issue-label metadata.

Related reproduction, E2E, repair, and verification work is grouped under its
original Review record. The detail selector opens each related activity's own
report, session, and recovery controls. Completed related work does not imply
that it has its own GitHub comment or that the original conclusion was rewritten.
An exact related activity link selects that activity within its Review family.
Explicit links that cannot be resolved show an unavailable state instead of
silently opening another Review.

The Inbox polls server state. Running details display the recorded execution
stage, the real selected model and Worker, elapsed time, and the age of the most
recent visible output. Output older than three minutes is marked stale. The
console does not display a percentage or treat a heartbeat as Agent output.

## Reports, sessions, and comments

The Report tab reads immutable report headers and all findings pages for the
selected report version. PR conclusions use the recorded assessment rather than
the number of findings. Findings show their priority, source location, impact,
and suggested repair. Issue results preserve their actual Bug, Feature, or other
classification, including information, verification, and decision requirements.
Scope-unit coverage counts and coverage details are no longer displayed in the
console, including the former E2E pass/total count. Native reports still retain
their coverage ledger and saved E2E feature outcomes.

A finding can open original source context for its exact saved report, finding,
and location. The Server reads the pinned commit, resolves its Git tree and blob,
and checks the blob bytes before returning numbered context lines. Recorded
submodule paths use the saved child repository and commit. No mutable branch is
used as a substitute. A finding without an accessible immutable source revision,
including a `local_patch` subject, shows unavailable context rather than a repair
suggestion or guessed current source.

The Session tab reads normalized assistant messages, command output, system
events, and gaps. It merges append/replace events by their saved item identity.
Private reasoning is never part of the feed. Command output can be expanded;
command status is displayed without inventing an exit code. Automatic scroll
following stops when the reader is more than 48px above the bottom and resumes
near the bottom. Retention or display limits produce a visible notice. An
expanded dialog is available for longer sessions.

The Comments tab reads retained delivery history. Its preview is a previously
confirmed applied body, not an unsuccessful proposed update. Sending, failed,
cancelled, and uncertain outcomes remain distinct. These retained observations
do not assert that an external user has not subsequently edited a GitHub comment.
An explicit current-comment read performs GitHub GET requests only and distinguishes
present, edited, deleted, not published, and unavailable observations. It retains
the last confirmation separately and does not rewrite publication receipts,
enqueue delivery, or repair a comment. Older progress-record formats retain their
saved preview and report current readback as unavailable without migrating them.

## Recovery and permission boundaries

The console calls the existing typed native API. The Server remains authoritative
for repository grants, execution permission, eligible states, source identity,
current versions, and idempotency. A disabled or rejected action is not converted
into a simulated success.

- Stopping requires `task:cancel`. Running cancellation is asynchronous: a
  successful request means the stop was accepted, while the Worker still has to
  stop and clean up. Saved progress remains available when a checkpoint exists;
  unsaved output is not guaranteed to be recoverable.
- Resuming requires `task:create`, an eligible incomplete terminal state, the
  original source revision, and execution permission for execution work. Cleanup
  must finish first. The existing budget is retained; no budget editor is shown.
- Intake retry uses the delivery's current `version`, an idempotency key, and its
  server-provided available action. It requires repository management, task
  creation, and applicable E2E execution permission.
- Shared comment synchronization and receipt checks use the publication's
  current version, idempotency key, and available actions. A receipt check does
  not write to GitHub. Uncertain delivery must not be blindly resent.
- Legacy result publications retain their original operation workflow. They do
  not become eligible for shared progress-comment synchronization merely because
  a newer console displays them.
- Saved-report delivery recovery uses the exact complete final report of an
  eligible completed native root Review. The Server blocks older results when a
  newer root Review or publication owns the same conversation and channel. A
  missing publication can be enrolled with its current version and an idempotency
  key; an existing native publication keeps its `sync`/`reconcile` workflow.
  Uncertain writes must be reconciled before delivery advances. Recovery does
  not rerun the Review, create a Worker attempt, or consume a new model call.

Normal native result publication uses the shared comment publisher, which updates
the same progress comment with its bound completed report. Historical legacy
result records can still be read. A completed Review is not itself proof of a
confirmed GitHub publication, and a progress comment without the completed
report binding is not proof that the conclusion was published.
Exact-report successful delivery receipts preserve earlier publication history
when a later Review reuses the shared comment. Such a record is identified as
previously posted rather than claiming its old body is still the current comment.

## Settings

Event intake supports trusted GitHub Code Review requests and re-requests, the
assignment compatibility path, and the separately enabled PR E2E command path.
The reviewer and trusted actors are numeric GitHub user IDs. Validation rejects
invalid and duplicate IDs and enforces the server's required recipient and actor
settings when intake is enabled. Recent deliveries navigate to their linked
record when one is available.

Optional GitHub profile lookup accepts a login or numeric user ID and displays
the resolved login and avatar while keeping numeric IDs as the saved authority.
Delivery metadata distinguishes assignment, review request, review re-request,
E2E comment command, and E2E revision observation. A re-request label requires the
canonical task's frozen prior-review baseline; aliases preserve their own actor
metadata rather than borrowing the canonical event's attribution.

Intake Settings displays the configured public Webhook URL when
`INVESTIGATION_GITHUB_WEBHOOK_PUBLIC_URL` is supplied. Otherwise it displays a
candidate derived from the public origin. The latest retained signed delivery is
a dated receipt observation. Neither that receipt nor receiver configuration is
a verified connectivity or health claim.

Automatic replies have separate conclusion and progress switches and six
templates: PR result, Issue result, received, started, failed, and completed. The
Stopped selector edits the protocol's `failed` template, which also covers other
failures. The existing validator enforces placeholder identity, count, order,
known names, and the 12,000-byte limit. Restoring a template creates an ordinary
draft. Enabling or renewing publishing authorization requires the current
repository and comment action grants and an explicit configuration confirmation.
Reauthorization renews the application's saved account authorization; it does
not replace a GitHub OAuth token or PAT.

Event intake and automatic replies retain drafts across Settings sections and
show a save/discard bar only when values differ from the saved baseline.
Conflicting server versions require reloading and reviewing current values.
Other supported settings actions take effect after their server acknowledgement.
Navigation and logout use the shared unsaved-change guard.

Native Prompt Settings has separate PR review and Issue investigation catalogs.
Repository managers can read both source-review and snapshot-analysis Markdown,
edit a draft, and publish an immutable version. Publishing does not switch the
active binding; setting a version as current is a separate versioned operation.
New native tasks freeze the selected content, reference, and digest. Later edits
or binding changes do not change existing tasks or resumed work. The Worker uses
that frozen content and verifies its reference and digest. Protocol, execution,
permissions, result rules, and dynamic recipe/baseline constraints remain outside
editable versions. Catalog or binding conflicts require a fresh read, and failed
catalog reads disable writes.

Static concurrency is shared across repositories and ranges from 1 to 16. Only
administrators can change it. E2E capacity remains one exclusive desktop. Worker
E2E controls are administrator-only and use a versioned admission policy. A
Worker must also advertise the required task kind. Disabling E2E can require
current execution to stop and cleanup to be confirmed; it is not an immediate
claim that the desktop is idle. Worker display names fall back to the saved ID.
The Server projects contact freshness separately from activity: active task
ownership and cleanup leases remain visible when contact has expired. The console
uses Online, Busy, Offline, Cleanup pending, or an explicit unconfirmed label,
with the recent recorded task stage when available. These are contact and
ownership observations rather than an independent process-health probe. Failed
Worker reads also disable an already-open admission confirmation.

Accounts use built-in username/password authentication, with no public
registration or third-party sign-in. Usernames contain 3-64 lowercase ASCII
letters, digits, periods, underscores, or hyphens and start with a letter or
digit. New passwords contain 15-128 characters, are case sensitive, and are not
trimmed. Account creation submits explicit repository, permission, capability,
and execution grants. Administrator status alone does not grant repository or
business access. Account updates and password resets preserve versions and
surface conflicts. The current account cannot disable itself. Password changes
and resets revoke the affected sessions.

## Retained limits and deferred decisions

The existing default task limits are real: 120,000 reported tokens, 24 analysis
rounds, and 30 minutes, with a 64 MiB report resource limit. This work does not
change those defaults or add a budget editor. A Review exhausted under its saved
limits can still receive a resume rejection. Reported usage is not a guaranteed
provider total or a hard provider spending limit; future budget policy remains a
separate discussion.

Publishing-account identity and token-scope diagnostics are not added. Historical
legacy result publications are readable but have no new repost operation. Numeric
command exit codes are not added to normalized session output. Optional module
and Issue-label fields remain absent when the native data does not provide them.
The related-activity selector remains in its current form pending a later product
discussion. Repeated Reviews continue to update the same GitHub comment while
preserving every saved report and its delivery history.

See the [current capability decisions and implementation](../../docs/design/2026-10-01-review-console-capabilities.md)
and the [historical gap and design extension record](../../docs/design/2026-10-01-review-console-capability-gaps.md).

## Production transport and local development

`src/investigation/api.ts` and `auth-api.ts` use same-origin authenticated HTTP.
Responses are validated with TypeBox. Requests include cookies, disable caching,
and reject redirects. Errors and malformed responses remain errors; production
does not substitute sample data. The session provider cancels requests, clears
query caches, and remounts protected content when identity or grants change.
Passwords remain in form memory and do not enter URLs or persistent browser
storage. Theme and language preferences use `agentic-review-theme` and
`agentic-review-language` in localStorage; theme is applied before rendering.

| API area | Representative endpoints |
| --- | --- |
| Authentication | `/api/auth/session`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/password` |
| Accounts | `/api/accounts`, `/api/accounts/:id/update`, `/api/accounts/:id/password` |
| Records | `/api/repositories`, `/api/work-items`, `/api/tasks`, `/api/tasks/:id` |
| Output and reports | `/api/tasks/:id/output-events`, `/api/reports/:id`, `/api/reports/:id/findings`, `/api/reports/:id/findings/:findingId/source` |
| Publications | `/api/publications`, `/api/comment-deliveries`, `/api/comments/:id/current`, `/api/comments/:id/sync`, `/api/comments/:id/reconcile`, `/api/tasks/:id/publication-recovery` |
| Source metadata and intake | `/api/work-items/:id/author`, `/api/repositories/:id/github-users/:lookup`, `/api/repositories/:id/intake-details`, `/api/github/webhook-deliveries`, `/api/github/webhook-deliveries/:id/retry` |
| Configuration | `/api/repositories/:id/webhook-settings`, `/api/repositories/:id/auto-reply-settings`, `/api/repositories/:repositoryId/native-prompts`, `/api/repositories/:repositoryId/native-prompts/:kind/versions`, `/api/repositories/:repositoryId/native-prompts/:kind/binding`, `/api/investigation/scheduler` |
| Worker controls | `/api/workers`, `/api/workers/:id/e2e` |

Install the workspace dependencies with the repository's supported Node and pnpm
versions. From the repository root:

```powershell
pnpm --filter @agentic-review/dashboard dev
pnpm --filter @agentic-review/dashboard build
pnpm --filter @agentic-review/dashboard typecheck
pnpm --filter @agentic-review/dashboard test
```

Follow the repository's execution-environment instructions before running builds,
tests, or runtime checks. Design acceptance should use isolated fixtures and
mocked upstream responses unless exact live PR/issue writes have been separately
authorized. This README is a behavior reference, not a test or acceptance receipt.
