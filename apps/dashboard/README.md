# Agentic Review Dashboard

The dashboard is the React 19 and Material UI 9 interface for structured PR and
Issue investigations. Vite builds the application, React Router provides static
page registration, and TanStack Query manages server data. The Material shell
provides repository selection, light and dark themes, and session controls.

The current application follows `WorkItem -> Task -> Attempt / LoopCheckpoint ->
Report`. Its entry point uses the implementation in `src/investigation/` and the
new investigation contracts. Retired Job-based Workers, Jobs, configuration,
notification, and evaluation pages are not registered in the current shell.
The current `/workers` page provides investigation Worker task controls, while
`/webhooks` provides current intake history and retry. Neither reactivates the
retired pages or provides a compatibility API or migration path.

## Pages and navigation

| Route | Current behavior |
| --- | --- |
| `/pull-requests` | Lists registered pull requests; `workItemId` opens the item, its tasks, and available actions. |
| `/issues` | Lists registered issues and opens their investigations, including Bug and Feature assessments. |
| `/tasks` | Lists tasks; `taskId` opens attempts, the saved checkpoint, the latest report, and linked tasks. |
| `/comments` | Lists scoped publications with search and exact source/Task filters; `commentId` opens its retained body, delivery attempts, and available recovery actions. |
| `/webhooks` | Lists scoped assignment/E2E intake events; `deliveryId` opens its attempts, linked Task, and available intake retry. |
| `/workers` | Administrator-only investigation Worker controls, effective task types, contact, and cleanup state. |
| `/reports` | Searches the server-paginated report directory; `reportId` opens an immutable report, also reachable from its source or Task. |
| `/repositories` | Lists accessible repositories and opens Overview, Event intake, Replies, and workspace-wide Scheduling settings. |
| `/account` | Lets the signed-in user change their own password. |
| `/accounts` | Lets administrators list, create, update, disable, and reset workspace accounts. |

`/` and `/work-items` redirect to `/pull-requests`. PRs, Issues, Tasks, Reports,
Comments, and Webhooks share the selected `repositoryId` when navigating between
those destinations. Changing repository clears record-specific IDs, pagination
position, and detail-view parameters. Workers and Accounts remain workspace-wide pages;
repository access still comes from the authenticated account's grants.

**Copy view link** copies only the page's allowed public view parameters: scope,
record IDs, filters, pagination, sections, selected finding or attempt, and
operational view choices. It excludes private feedback, publication payloads,
passwords, and account/settings drafts. A report link can specify
`section=validation`, `section=evidence`, or `section=changes` to open its evidence
section. Account search/status, repository search, and the selected reply template
can be restored without putting form content in the URL. Retired and unknown
routes show an unavailable page.

Opening a PR, Issue, Task, or Report from a result list captures a session-local
review queue. Previous/Next follows that snapshot, and returning to the origin
restores its list location and opener focus. Related Source, Task, and Report
links retain the origin using their real repository/work-item associations,
not interchangeable IDs. **A Reports queue contains only the currently fetched
directory page**, not all server-side matches. Queues do not reorder or execute
Tasks, are not included in copied view URLs, and are invalidated when their
identity or repository scope is no longer applicable. Direct links have a normal
directory fallback.

Source, Task, Report, Comment, and Webhook details offer a GitHub source link when
their recorded repository, source kind, and number are valid. It opens the current
GitHub page; saved evidence remains bound to the report's original snapshot or
revision.

PR and Issue details can create a full investigation task. A static Issue
investigation uses its imported snapshot; source-based Issue investigation
requires an explicitly chosen commit SHA. Repository execution is prepared from
a saved follow-up plan, rather than inferred from an Issue's text or a default
branch.

Queued or running tasks can be cancelled when the account permits it. Stopped
tasks can resume from their checkpoint. The resume dialog shows saved limits and
consumption, allows explicit budget increases, and preserves the frozen source,
scope, profile, and prompt. The server rejects budget reductions, exhausted
unchanged limits, or increases beyond its resource limits.

## Worker task controls

Only workspace administrators can open **Workers** or change its **Allow E2E**
switch. The Server separately enforces this permission; a direct URL does not
bypass it. Each registered Worker starts with the single persisted setting off,
so new Tasks are limited to static PR review and Issue analysis. Enabling it
permits execution only when the Worker also advertises the required task type;
local role and supported-kind settings can narrow its capability.

The page shows advertised and effective task types, last contact, active E2E
Tasks, and attempts awaiting cleanup. Disabling prevents new execution claims
and requests cancellation of running execution. **Disabling E2E** or **Awaiting
cleanup confirmation** remains visible until owned cleanup is confirmed. A saved
setting and an offline Worker do not prove that an application exited. Accepted
terminal results can still finish report delivery and cleanup. A version conflict
requires refreshing and reviewing the current setting before another change.

The setting controls product task types. Local screenshots remain allowed, and
it does not remove general model shell access or add an operating-system sandbox.
Static investigation images and videos are not uploaded to GitHub. Authorized
E2E publication still requires exact task, report, revision, and producer evidence.
See [Server Worker controls](../server/README.md#worker-execution-permission).

## Webhook event history and retry

**Webhook events** is available to signed-in repository readers. Results remain
limited to their repository grants, including when the selector shows all
repositories. Filter by target type/number, intake state, or static/E2E mode and
open an event to inspect its processing attempts, failure reason, canonical
delivery, and linked Task. History remains readable when new intake is disabled.
**Processed** means intake handling finished; Task execution and GitHub comment
delivery have separate outcomes.

**Retry event handling** appears only when the Server returns it as an available
action for a failed canonical receipt. It requires repository scope,
`repository:manage`, and `task:create`; E2E retry also requires repository-execution
permission. The request retains a version and idempotency key. A conflict blocks
another attempt until **Refresh status** obtains the current state. Retry first
reattaches an already committed Task and does not rerun it, retry a comment
delivery, or request GitHub redelivery. Use the separate Task and Comments views
for their respective outcomes and recovery actions. See
[webhook recovery](../server/README.md#inspect-and-retry-webhook-intake).

Comments and Webhooks keep status refresh, reconciliation, replay, and new
requests distinct. A GET refresh retains the last readable snapshot and does not
confirm an unknown command: these endpoints have no separate acknowledgement
lookup by idempotency key. An unconfirmed request keeps its original operation,
version, and key for **Retry same request** or **Resend saved request**; it blocks
a new operation. Comment **Check delivery** is a separate versioned reconciliation
command that records an observation without sending a GitHub comment. Publication
sync can create or update a comment. Accepted requests and completed delivery are
separate states; server availability and the required grants still apply. A later
read failure preserves the source and retained history but disables starting a new
operation until refresh succeeds.

## Structured reports

The interface distinguishes execution outcome, report completeness, review
conclusion, and actual validation. A completed investigation does not certify
that the code is correct or that required E2E checks passed. A checkpoint or
partial report retains findings, evidence, limitations, and remaining work.
The shared outcome presentation uses the saved assessment before evidence and
current next-step controls. `changes-requested` is displayed as **Changes needed**;
it does not mean a GitHub review was submitted. Checkpoints and partial results
show **No final conclusion** with their saved assessment. Task execution and
cleanup remain separate from that assessment, and saved recommendations do not
grant permission to execute an action.

Reports provide:

- PR review conclusions and an independent E2E assessment.
- Bug conclusions, missing information, hypotheses, and separate reproduction status.
- Feature requirements, feasibility, decisions, saved plans, and acceptance criteria.
- Findings with P0-P3 priority, trigger conditions, impact, root cause, evidence,
  final recheck information, repair advice, and an editable independent feedback draft.
- Coverage units, all retained candidates, loop progress, and pending rechecks.
- Exact original PR, Issue snapshot, source commit, local patch, and remote branch subjects.
- Actual validation checks, evidence provenance, artifact availability, and diagnostics.

The report reader loads the **complete JSON export**, checks its report identity,
version, digest, and collection totals against the header, and filters that full
collection locally. Text search, priority, and assessment filters cover all
findings; pagination then displays 25 matching findings per page. The complete
count, matching count, selection, and current finding are distinct. A finding
deep link locates its actual ID, including when it is outside the current filter.
The server's cursor-based findings endpoint still exists, but it is not the
reader's current filtering boundary. The export also supplies evidence and saved
plans and remains downloadable. Registered available artifacts use the
authenticated content endpoint; missing sample artifacts have no fake download
destination.

**Review selected** includes the complete report selection, including findings
hidden by a filter or another page. Removing an item from that selection retains
its private feedback text. **Save draft & next** saves only the current finding's
text and moves within the filtered collection; **Save all report drafts** is a
separate operation. Private drafts and selection stay in session memory and do
not modify the immutable report or publish anything.

The investigation workflow must cover the declared scope and recheck candidates
before final delivery. Pagination is presentation only; it is not a top-k limit
on analysis or the retained findings collection.

## Decisions, preparation, and confirmation

The server's `ActionContextV1` separates recommendations from fixed operation
availability. PR operations include Comment, Approve, code suggestion comments,
Request changes, Close, Merge, and Trigger CI. Issue Comment and Close remain
independent of classification-specific suggestions.

Only a confirmed, unresolved P0 on the current original PR revision creates the
specified content prohibition on Approve. P1 findings, incomplete analysis, or
missing required E2E evidence can change the recommendation without creating
that prohibition. Merge uses its own permissions and target conditions. Actual
account permissions, source identity, target state, installed handlers, and
unresolved submissions still apply to every operation.

Report review selection and action publication selection are separate. The
report can initially select valid suggestions marked `selectedByDefault` by the
server's complete selection context; it preserves explicit changes across pages.
An action is chosen explicitly and keeps its own findings, text, delivery modes,
and saved draft. A fresh action starts empty unless the user imports report
selection or explicitly chooses a saved proposal carrying a draft reference.
**Publish selected findings** and **Use report selection** are explicit imports,
not continuous synchronization. Switching actions preserves each action's edits;
later report changes require an explicit choice to import them, keep the action's
selection/text, or replace publishing text. A P0 outside the visible page cannot
be bypassed by clearing either selection.

Feedback publication follows **Select findings -> Compose -> Server preview**,
then a separate confirmation. Compose edits each included finding's publishing
text and, for eligible review actions, its exact source-bound code suggestion.
Conversation comments are text-only. Request changes requires at least one
finding; Approve can have no findings or summary. This selection rule does not
replace the server's P0, source, permission, or execution guards. Close, Merge,
Trigger CI, and follow-up operations use their own fields rather than a generic
feedback body. Field-specific errors identify and focus the field to correct.

Follow-up operations come from persisted, validated `nextActions` and exact saved
plans. `canPrepare` allows reviewing and completing a preparation form;
`readyToExecute` and the returned guards describe execution prerequisites.
Issue follow-up work can require an explicit source commit. Selecting a plan or
entering a SHA does not assert that other prerequisites have been satisfied.

Preparation saves an `ActionIntent` and opens its exact payload, target, expected
SHA/revision, and guards. Execution requires a separate confirmation bound to the
intent version and payload digest. The server performs fresh checks before
dispatch. An `executing` or `unknown` submission retains its original intent and
blocks a new submission. Its owner can refresh the saved intent without executing
it; reconciliation requires Execute actions and the operation's capability. Losing
those grants does not turn reconciliation into a read-only operation or permit a
replacement submission. Read-only next actions navigate to the existing report
or evidence.

Closing a preview or discarding local drafts does not cancel, undo, or roll back a
prepared or submitted server operation. Terminal receipts remain available for
their bound actor and source; repeating a successful action with the same payload
requires an explicit **Confirm another**. Unknown outcomes must be checked through the
saved identity, not by resending individual findings, and a review-level receipt
does not independently verify every inline comment. A returned linked Task can
be opened without claiming it has started or completed. Creating a PR requires an
existing verified remote branch; the dashboard does not implicitly commit or push
changes.

## Production API and session boundary

The production bundle uses the same-origin typed HTTP client in
`src/investigation/api.ts`. Successful responses are validated against TypeBox
contracts. Requests include the session cookie, disable caching, and reject
redirects. Failed or malformed responses surface errors; they never fall back to
sample data or fabricated success.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/session` | Read the authenticated identity, repository grants, permissions, and action capabilities. |
| `POST /api/auth/login` | Sign in with a username and password. |
| `POST /api/auth/logout` | End the session. |
| `POST /api/auth/password` | Change the current account's password and revoke its sessions. |
| `GET /api/accounts` and `POST /api/accounts` | List or create accounts as an administrator. |
| `POST /api/accounts/:id/update` | Update an account's enabled state, administrator status, and explicit access grants using its version. |
| `POST /api/accounts/:id/password` | Reset an account password as an administrator using its version. |
| `GET /api/repositories` | List accessible repositories. |
| `GET /api/workers` | List investigation Worker controls as an administrator. |
| `POST /api/workers/:id/e2e` | Save the administrator's versioned `e2eEnabled` setting. |
| `GET /api/github/webhook-deliveries` and `GET /api/github/webhook-deliveries/:deliveryId` | Read scoped intake history and one event's processing attempts. |
| `POST /api/github/webhook-deliveries/:deliveryId/retry` | Request a permitted intake retry using its current version and an idempotency key. |
| `POST /api/repositories/:id/import-work-item` | Import a PR or Issue snapshot and complete comment history through read-only upstream requests. |
| `GET /api/work-items` and `GET /api/work-items/:id` | Read registered items. |
| `GET /api/tasks` and `GET /api/tasks/:id` | Read tasks, attempts, checkpoints, and linked work. |
| `POST /api/tasks` | Create an investigation with server-frozen inputs. |
| `POST /api/tasks/:id/resume` and `POST /api/tasks/:id/cancel` | Resume with an idempotency key and optional increased budget, or cancel execution. |
| `GET /api/reports` | Search and filter the scoped report directory using server pagination. |
| `GET /api/reports/:id` | Read a report header. |
| `GET /api/reports/:id/findings` | Read a cursor-based findings page. |
| `GET /api/reports/:id/export` | Read the complete structured result. |
| `GET /api/artifacts/:id/content` | Download authorized registered artifact bytes. |
| `GET /api/work-items/:id/action-context` | Obtain current recommendations, selection defaults, and operation guards. |
| `POST /api/action-intents` | Prepare an exact operation preview. |
| `GET /api/action-intents/:id` | Read an operation's recorded status. |
| `POST /api/action-intents/:id/confirm` | Confirm the reviewed version and payload digest. |
| `POST /api/action-intents/:id/reconcile` | Resolve an executing or unknown submission from its existing receipt. |

Sign-in uses the workspace's built-in username and password system. There is no
third-party sign-in entry or public registration. Usernames are normalized by
trimming whitespace and converting to lowercase; canonical usernames use 3-64
ASCII letters, digits, periods, underscores, or hyphens and start with a letter
or digit. New passwords require 15-128 characters. Passwords are case-sensitive
and are not trimmed.

`isAdmin` controls the Accounts and Workers navigation entries and pages. The
server separately enforces account and Worker administration. Administrator
status does not implicitly grant repository access, business permissions, or
action capabilities.
Account forms retain an explicit version for updates and resets. A conflict
requires refreshing and reviewing the current account before trying again;
the dashboard does not silently overwrite a concurrent administrator's changes.
Account and repository settings compare current values with their saved baseline.
Restoring the original values clears dirty state, and ordinary no-op saves do not
submit an update. Exact-ID/grant sets are compared without treating ordering or
separator changes as new access. Renewing automatic-publishing authorization is
an independent action and remains available when configuration values are
unchanged. Shared static concurrency applies across all repositories.

Password fields use the appropriate `username`, `current-password`, and
`new-password` autocomplete attributes. They are held only in form memory and
cleared after submission, including failures. The dashboard does not write
passwords to URLs, `localStorage`, `sessionStorage`, query caches, logs, or
account/session response objects.
Changing one's password revokes the account's sessions and returns to sign-in.
Resetting one's own password as an administrator also requires signing in again.
Successful sign-in preserves the current protected page URL.

Repository and operation authorization comes from the authenticated server
session. A protected API's `401` response clears the old identity and cached
workspace and presents sign-in. A rejected login does not start a session-refresh
loop. Sessions are rechecked on window focus and at their recorded expiration.
Logout immediately removes protected views and suspends outstanding and
new investigation requests before clearing the cache. Late session responses
cannot restore a signed-out identity. Changes to repository grants or action
permissions replace the protected workspace and its cached data. If logout
fails, the dashboard checks the session again and reports the failure.

Production serves `apps/dashboard/dist` through the investigation server at the
same origin as these APIs. Configure the public origin, authentication,
repository grants, and upstream access using the [server guide](../server/README.md).
Real external writes require the server's explicit write configuration as well
as the normal prepared and confirmed operation flow. A standalone Vite preview
of the production bundle does not supply these backend endpoints.

## Development preview

Only `NODE_ENV=development` selects the in-memory account and investigation
adapters. Development starts signed out and clearly displays the public sample
credentials: username `demo`, password `Demo-password-2026!`. These credentials
exist only for the synthetic preview; they are not production bootstrap or
deployment credentials. Login, logout, password changes, and administrator
account forms operate on the in-memory example account store. Logging out really
ends the sample session. Reloading resets the store and the demo password.
The sample workspace facade applies each signed-in account's exact repository
grants and business permissions, including ownership of prepared actions. Losing
the sample session removes access to the reports until the user signs in again.

The investigation sample factory uses the pure shared
`createInvestigationPreview` helper and owns isolated in-memory state. Production
pages and the API selector use static imports; sample
initialization remains inside the removable development branch. Do not add
dynamic loaders, eagerly instantiate sample state at module scope, or import
test-only bridges from production modules.

The repository selector contains `moooyo/PowerToys` as `repo-powertoys-fork`.
After signing in with the demo account, open
`/pull-requests?repositoryId=repo-powertoys-fork` to inspect these five
synthetic investigations:

| Sample | Behavior to inspect |
| --- | --- |
| PR #2101 | A P1 with required, unrun E2E checks; mixed suggestion and text feedback; manual Approve remains available. |
| PR #2102 | 26 findings with the P0 on page two; Approve is blocked before that page is viewed while Merge retains its independent guards. |
| PR #2103 | An interrupted, partial investigation with a preserved checkpoint and resume controls. |
| Bug Issue #3101 | `needs_verification`, separate reproduction status, and a saved follow-up plan requiring a chosen source SHA. |
| Feature Issue #3102 | `ready` with an implementation plan and acceptance criteria; readiness does not imply maintainer acceptance. |

Titles are marked `[Sample]`. Repository numeric IDs, item numbers, commits,
findings, reports, and execution records are synthetic, not actual GitHub or
validation results. State resets when the page reloads. Source import is disabled
in sample mode. Confirming an external sample operation records that no GitHub
action was dispatched. Confirming an eligible internal sample plan only queues a
synthetic child task; it does not start a Worker. No real credentials or GitHub
writes are needed to browse the examples.

## Running and verification

The package requires Node.js `>=24.20.0 <25` and pnpm `>=11.24.0 <12`.
Its build and typecheck scripts consume the built shared contracts package,
including the package-exported declarations and TypeBox ESM symbols.

Use the project-designated remote Windows worker for verification, including
Dashboard checks that can run on Windows. Linux-specific work may use `test-env`.
Tests, type checks, builds used for verification, browser smoke tests, and runtime
probes require explicit authorization before running on the local workstation.
For Linux-specific verification, connect with:

```powershell
ssh test-env
```

From the repository checkout in the designated environment, prepare and start
the development preview with:

```powershell
pnpm --filter @agentic-review/contracts build
pnpm --filter @agentic-review/dashboard dev
```

Vite binds to `127.0.0.1:8000` on the host where it runs and uses the development
samples. For a production bundle and dashboard verification, run from the same
approved checkout:

```powershell
pnpm --filter @agentic-review/contracts build
pnpm --filter @agentic-review/dashboard typecheck:only
pnpm --filter @agentic-review/dashboard test:only
pnpm --filter @agentic-review/dashboard build:only
```

Also run the repository's production-source boundary checks when changing
imports, entry points, or preview helpers. Browser verification should cover both
development samples and the production bundle with a real test session, including
password login and failure handling, session expiration, account access changes,
self-service password changes, administrator conflicts and resets, Worker
static-only/enable/disable states, webhook history and stale-retry handling,
report pagination, preparation versus confirmation, logout, and narrow layouts.
If the designated verification environment is unavailable, report verification
as blocked; do not fall back to local testing.

Automated verification must use mocked upstream responses, isolated synthetic
data, or read-only live checks. Access to `test-env` is not authorization to
create or mutate a repository's actual PRs or Issues. Live writes require the
user's explicit approval of the exact targets, operations, content, and execution
scope.

These instructions and registered pages do not establish live UI acceptance.
The [current handoff](../../docs/handoff/2026-09-19-worker-controls-and-webhook-recovery.md)
records software checks and scoped real/synthetic Dashboard observations, including native
HTTP/SQLite intake with GitHub mocked. The later scoped Calculator E2E, fifth-report GitHub media,
cached HTTPS redelivery, and sixth/eighth-Task cleanup have separate evidence. The real-task observers
failed before disable; a separate synthetic-input/real-runtime W4 fixture passed. Phase 1 idle-disable
UI and restoration checks passed independently. Operational closeout is complete; temporary capacity
settings are restored and legacy services/history preserved. Git publication is a separate handoff.

The product contract and loop design are documented in
[Structured investigation results and loop](../../docs/design/2026-09-15-structured-investigation-results-and-loop.md).
