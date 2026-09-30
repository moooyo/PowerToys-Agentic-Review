# Investigation server

`src/main.ts` starts the Task / Attempt / LoopCheckpoint / Report application. The active server
uses built-in username and password accounts only. There is no passwordless local login, OIDC
callback, third-party identity provider, or self-service registration. Previous standalone prototype
modules are not part of this runtime.

## Start the application

Build the workspace and dashboard in the authorized verification or deployment environment, then
run `pnpm --filter @agentic-review/server start`. The server serves the dashboard bundle and `/api`
from the same origin. The default dashboard directory is resolved relative to the installed
application, independent of the process working directory. Missing `index.html` stops startup.
`SIGINT` and `SIGTERM` close HTTP admission, active connections, cleanup, and both database handles.

The server reads `INVESTIGATION_*` settings from its process environment; it does not automatically
load a dotenv file. `.env.example` lists the supported settings. Keep both databases in directories
restricted to the service account and administrators, outside the dashboard static directory.
Relative database paths resolve against the process working directory.

Investigation data uses schema identity `investigation-v5`. Startup accepts exact, complete
`investigation-v2`, `investigation-v3`, and `investigation-v4` databases and adds the missing comment
history, scheduler, normalized output, and directory storage in one transaction. Existing entities are preserved. Unrelated, partial, or otherwise incompatible schemas
are rejected without deletion or reset. The separate password-account database retains its own
schema identity and initialization rules.

The authenticated Dashboard read API includes bounded report and publication directories,
`GET /api/workspace/search`, frozen `GET /api/work-items/:id/discussion` snapshots, and uploaded
`GET /api/tasks/:id/artifacts` metadata. Directory cursors are bound to the selected filters and
the operator's exact repository grants. Artifact lists never read stored content bytes. Report
directory headers preserve every sealed report and its original usage snapshot.

Workers append only normalized visible events through `POST /api/worker/tasks/:id/output-events`.
Each batch contains at most 64 events and 256 KiB, preserves one stable batch identity, and continues
the attempt's producer sequence. Model events require an already admitted invocation. The original
Worker, task, attempt, fence, and lease token are checked on every delivery. A terminal attempt can
drain an already established stream for 24 hours; this exception does not permit other stale task
mutations. Identical committed batches remain safe to retry after that drain window.

`GET /api/tasks/:id/output-events?attemptId=...` replays durable normalized events. Pages contain at
most 200 events. `nextCursor` continues a page; after the page is drained, `highWaterCursor` polls for
new output. A cursor from pruned history returns `cursorExpired: true` together with the earliest
retained page. Each attempt retains at most 10,000 events and 8 MiB. Aggregate retained output is
limited to 128 MiB; the oldest retained stream entries are removed when this limit is reached,
with gaps disclosed through the same replay metadata. At most 100,000 immutable batch receipts are
retained; exhaustion rejects a whole batch without advancing its sequence. Output never establishes accepted analysis, token usage, evidence,
or process cleanup. Raw provider envelopes and private reasoning are outside this protocol.

## Initialize the first administrator

A new installation uses a separate `investigation-accounts.sqlite` account database. Configure a
new path instead of an old authentication database: schema identities are checked and older or
unrelated schemas are rejected without migration, conversion, or deletion.

Before the first start, configure `INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME` and either
`INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD` or `INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD_PATH`.
`INVESTIGATION_BOOTSTRAP_ADMIN_DISPLAY_NAME` is optional and defaults to the normalized username.
A protected UTF-8 password file is read verbatim. Its leading spaces, trailing spaces, byte order
mark, and final newline are part of the password; create the file with exactly the intended text.
There is no predefined password. Empty account storage without bootstrap credentials refuses to
start, so a new instance never exposes an unauthenticated account-creation route.

Bootstrap runs only while no accounts exist. Subsequent starts do not replace passwords, account
status, administrator flags, or permissions from bootstrap settings. Remove all bootstrap settings
from the service environment after initialization. The first account is an enabled administrator
with no implicit repository scopes, business permissions, action capabilities, or source-execution
authority. Sign in and use account management to grant the exact required access.

Usernames are trimmed and normalized to lowercase ASCII, with 3 to 64 letters, digits, dots,
underscores, or hyphens, beginning with a letter or digit. Login names are immutable. Passwords
contain 15 to 128 Unicode code points and at least one non-whitespace character; passwords are
otherwise stored and compared exactly as entered. Do not trim or normalize them in a client.

## Accounts, permissions, and sessions

Only enabled administrators manage accounts. `isAdmin` grants account administration; it does not
expand repository or execution authority. Account management supports creating accounts, editing
names and access, disabling accounts, and resetting passwords. Disabling preserves account IDs
referenced by investigation history. Every update carries the current `version`; concurrent changes
return a conflict instead of overwriting another administrator's edits. Transactions protect the
last enabled administrator from being disabled or losing administrator status.

Repository scopes contain exact internal repository IDs, including during repository registration.
The five business permissions are `repository:manage`, `task:create`, `task:cancel`, `action:prepare`,
and `action:execute`. Action capabilities and `allowRepositoryExecution` remain separate explicit
grants. They do not replace current GitHub permissions, target state, revision checks, or confirmed
action intents.

Passwords use asynchronous Node.js scrypt with `N=32768`, `r=8`, `p=3`, a fresh 16-byte random salt,
and a 32-byte derived key. This work factor uses approximately 32 MiB per derivation, with a 64 MiB
allocation ceiling for overhead. Two concurrent derivations and eight queued requests are the
default; bounded settings prevent unbounded KDF work. Verification of missing, disabled, or invalid
accounts performs the same-cost dummy derivation and uses constant-time key comparison. Login,
account creation, administrator password resets, and personal password changes also share bounded
IP and normalized-account rate limits. Behind a loopback reverse proxy the IP limit applies to the
proxy's connection address; forwarded headers are not trusted as authentication or rate-limit keys.

Login issues a random opaque session token; only its SHA-256 hash is persisted. Sessions default to
eight hours. Each request reads the account's current enabled state and version. Account updates,
password changes, and password resets revoke every session for the changed account. Personal
password changes require the current password and sign the user out everywhere. Asynchronous KDF
operations recheck account and administrator versions inside their final transactions. A persisted
clock high-water mark prevents expired sessions from reviving after a restart and clock rollback.

## HTTP, HTTPS, and cookies

The default listener and public origin are literal `127.0.0.1`, port `8000`. Unencrypted HTTP is
permitted only for actual loopback requests with matching Host and no forwarding headers. Passwords
remain mandatory. All state-changing browser requests must have the exact configured Origin.
Cookies are HttpOnly and SameSite=Strict; HTTPS uses Secure cookies with the `__Host-` prefix.
Authentication and account routes suppress request logs, and password fields are redacted from
runtime request logging. Responses never include password hashes, salts, or bearer session tokens.

For remote users, configure an HTTPS public origin and either a TLS listener using
`INVESTIGATION_TLS_KEY_PATH`/`INVESTIGATION_TLS_CERT_PATH`, or a private loopback listener behind an
HTTPS reverse proxy that preserves the public Host header. Public HTTP listeners are rejected.
Keep the reverse proxy's HTTP upstream inaccessible to untrusted clients. Forwarded identity
headers never establish an account session.

## Account API

- `GET /api/auth/session` returns a password-mode session. Authenticated responses include
  `expiresAt` and a user with `id`, `username`, `displayName`, `isAdmin`, explicit access fields,
  and `email: null`; signed-out responses contain `user: null`.
- `POST /api/auth/login` accepts `{username, password}` and returns the session with an HttpOnly
  cookie. Invalid credentials use a uniform response. Rate limits return HTTP `429`.
- `POST /api/auth/logout` revokes the current session, clears its cookie, and returns HTTP `204`.
- `POST /api/auth/password` accepts `{currentPassword, newPassword}`, revokes all of the caller's
  sessions, clears the cookie, and returns HTTP `204`.
- `GET /api/accounts` returns `{items: Account[]}` to administrators.
- `POST /api/accounts` creates an account using its username, password, display name, administrator
  flag, and explicit access fields.
- `POST /api/accounts/:id/update` accepts `version`, `displayName`, `enabled`, `isAdmin`, and all
  explicit access fields. Usernames cannot change.
- `POST /api/accounts/:id/password` accepts `{version, newPassword}`, increments the target version,
  and revokes the target's sessions.

Account DTOs include `id`, `username`, `displayName`, `isAdmin`, `enabled`, `version`, `createdAt`,
`updatedAt`, `repositoryIds`, `permissions`, `actionCapabilities`, and `allowRepositoryExecution`.
All request and response structures are defined in the shared investigation authentication contract.

## Recover a lost administrator password

Stop the service and run the recovery command as an operating-system administrator or the trusted
service account. Prepare a protected UTF-8 file containing the new password, then run:

```powershell
pnpm --filter @agentic-review/server run accounts:reset-admin --database "D:\ServiceData\investigation-accounts.sqlite" --username "your-admin-name" --password-path "D:\Secrets\replacement-password.txt"
```

The command first checks the existing database identity with a read-only connection. It refuses an
empty file, a different schema, a missing account, a disabled account, or a non-administrator. It
changes only the existing administrator's password and version and revokes that account's sessions;
it does not create accounts, promote users, or change repository permissions. Password values are
not accepted on the command line or printed. Restart the service, sign in with the new password,
and remove the temporary secret file using the environment's normal secret-handling procedure.

## Worker and GitHub credentials

Worker authentication remains separate from browser accounts. `INVESTIGATION_WORKERS_JSON` or
`INVESTIGATION_WORKERS_JSON_PATH` supplies `{id, token, repositoryIds}` entries. Generate each unique
token from at least 32 cryptographically random bytes encoded as base64url. Workers send
`Authorization: Bearer <token>`; the server resolves ID and exact repository scopes from trusted
configuration, ignoring identity claims in request bodies. Worker tokens cannot administer accounts,
and browser cookies cannot claim worker tasks. No configured workers means no worker admission.

### Worker execution permission

Each configured Worker has one Server-persisted `e2eEnabled` setting, initially `false`. The
administrator's **Workers** page shows the setting, advertised and effective task kinds, last
authenticated contact, and outstanding execution/cleanup identities. Existing Worker role and
supported-kind settings can narrow eligibility; they cannot grant E2E permission. There is no
additional local E2E enable flag.

| Endpoint | Authentication and request | Result |
| --- | --- | --- |
| `GET /api/workers` | Administrator browser session | Registered Worker controls and current state; bearer Worker credentials cannot read the management view. |
| `POST /api/workers/:id/e2e` | Administrator session; `{ "version": 1, "e2eEnabled": true }` | Persists the next version and an audit record. A stale version returns HTTP `409`; reload before making a new decision. |
| `POST /api/worker/policy` | Scoped Worker bearer token; `{ "supportedKinds": ["pr-review", "pr-e2e"] }` | Returns `workerId`, `version`, `e2eEnabled`, and `effectiveKinds`. The request advertises capability and cannot enable execution. |

The Worker polls policy before claims; the Server independently checks admission. `pr-review` and
`issue-investigate` are static kinds and cannot carry `executionPolicy.mode: "execute"`. Creation,
claim, and Worker execution reject that combination, including malformed retained tasks. Other
task kinds require an E2E-enabled Worker and retain their normal task-level execution prerequisites.

Disabling E2E prevents new execution claims and requests cancellation of active execution through
the existing heartbeat response. Accepted terminal checkpoints can still deliver their report;
usage, process termination, workspace/desktop cleanup, and cleanup acknowledgements remain available.
The setting changing to false is not proof that an application has exited. `disabling` means an
online Worker still owns an unreleased E2E lease; `awaiting_confirmation` covers unresolved ownership
while offline, or an enabled Worker whose capabilities/contact have not been confirmed. Only
confirmed cleanup releases the execution slot. `static_only` also applies when local capability
settings advertise no execution kinds despite the Server permission being enabled.

This setting controls application task assignment and execution. It does not remove general model
shell access, prohibit local screenshots, or add an operating-system sandbox. Static investigation
images and videos are excluded from the GitHub media publication path.

### Independent task resource pools

Static review and investigation share a configurable global capacity. The initial
`INVESTIGATION_STATIC_CONCURRENCY` defaults to 1 and accepts 1-16; the first Server persists it.
Administrators can update `staticConcurrency` with `PUT /api/investigation/scheduler`. The same
endpoint supports authenticated `GET` for capacities, occupancy, and repository-scoped leases.
Changing the limit affects future admission without interrupting already-running tasks.

All execution kinds, including `pr-e2e` and legacy saved-plan tasks, share one global E2E slot.
The claim transaction acquires the resource and creates its Attempt atomically. A blocked E2E
queue head does not prevent a static task from starting. Static and E2E work can run together.
E2E cancellation, lease expiry, crashes, and normal report finalization retain `needs_cleanup`
until the original Worker authenticates the exact task, attempt, fence, and lease token and
confirms owned processes stopped and the desktop was restored. There is no time-based release.

GitHub transport remains optional. Configure `INVESTIGATION_GITHUB_TOKEN` or its `_PATH` variant
alongside `INVESTIGATION_GITHUB_USER_ID`. Without credentials, read-only source imports can
access explicitly public repositories using anonymous GitHub GET requests. Private source reads
and external write operations require configured credentials. Configured credentials are always
checked against the expected user ID; a failed identity check never falls back to anonymous access.
External writes also require `INVESTIGATION_ENABLE_EXTERNAL_WRITES=true` and the normal confirmed
action-intent workflow. Account administration or test execution does not authorize writes to any
actual repository PR or issue.

## Automatically reply with investigation results

The repository workspace includes **Automatic investigation replies**. Saving an enabled policy
authorizes the Server to comment on future complete `pr-review` and `issue-investigate` reports
in that repository, without a per-report preview or confirmation step. The automatic action is
an ordinary conversation comment. Other review, merge, closure, and implementation operations
retain their existing explicit action workflows.

Enabling the policy requires the exact repository scope, `repository:manage`, `action:prepare`,
`action:execute`, and the `comment` action capability. A scoped repository manager can disable
the policy. The Server re-reads the authorizing account, repository identity, and policy version
before preparation, confirmation, and the final outbound request. Disabled accounts, revoked
grants, or a stale upstream target prevent new publication. Repository identity
changes atomically disable the policy and advance its version, including when a previous name
is later restored.

Configure the ordinary GitHub transport credential and `INVESTIGATION_ENABLE_EXTERNAL_WRITES=true`
in the deployment before publication. The application can save repository settings while the
publisher is unavailable; its UI shows that state. The default is disabled. Enabling does not
backfill old reports, and changing templates does not rewrite an already prepared comment.
The settings edit version is separate from the authorization epoch: ordinary wording changes do
not revoke publication authority. Disabling, changing the publication grant, or explicitly
reauthorizing it changes that epoch.

Version 4 English templates contain exactly one of each supported placeholder, in this order:

- PR: `{{identity}}`, `{{conclusion}}`, `{{summary}}`, `{{findings}}`, and `{{details}}`.
- Issue: `{{identity}}`, `{{conclusion}}`, `{{next_steps}}`, and `{{details}}`.

Identity must be the first nonempty content and Details must be last. Unknown, missing, repeated,
reordered, or wrong-kind placeholders and executable expressions are rejected. Templates are
limited to 12,000 UTF-8 bytes. Older template policies, including versions 2 and 3, do not authorize new
replies; save the current templates again to enable publication. This does not rewrite an existing
frozen comment body or backfill earlier reports.

The disclosure starts with the recorded model name, states that the automation acts on behalf
of the verified publishing GitHub account, and notes that the content is AI-generated and may
contain errors. Model attribution comes from trusted Worker records for every accepted analysis
round, using `INVESTIGATION_WORKER_CLI_MODEL` as the explicit CLI selection. Resumed tasks retain
earlier model selections. Missing records or a CLI default without an explicit selection are
disclosed as unavailable model identity; the Server never guesses a model from generated text.
This records the CLI selection rather than proving a provider's internal model routing.

PR replies keep Conclusion, Summary, and Findings visible. Issue replies instead show Triage
result and Next steps. The Issue conclusion incorporates a short summary in two or three
sentences rather than adding a separate Summary section. A bug triage disclosure says it is
conducting automated bug triage; feature and other Issue reports use the broader issue-triage
wording. Bug conclusions distinguish confirmed bugs, missing information, needed verification,
upstream fixes, duplicates, and expected behavior. A separate Runtime reproduction field shows
Not attempted, Reproduced, Not reproduced, or Blocked. Feature and other Issue reports omit this
field. Failure to reproduce does not establish expected behavior, and a confirmed static finding
does not imply runtime reproduction.

Issue next steps expose the recorded information requests, unconfirmed hypotheses and proposed
verification plan, suggested fixes, upstream fix or duplicate reference, or expected-behavior
guidance as appropriate. Feature requests keep their own requirements, decisions, usage guidance,
and alternatives. Other classifications remain visible without an invented bug result. These
sections recommend follow-up; they do not claim that a fix, label change, closure, or other
repository action has occurred.

The renderer supplies an initially collapsed section for both templates, using a `<details>`
element without an `open` attribute. The PR toggle is `<summary>Details</summary>`; the Issue
toggle is `<summary>Investigation details</summary>`. It retains scope, limitations, full findings,
assessment rationale, actual validation, complete plans, and supporting evidence. Issue findings
are available here rather than presented as the PR's priority-based list. Rendering does not make
another model call.
Investigation prompts require English narrative content while preserving source identifiers and
necessary original-language quotations. Confirmed findings, hypotheses, and validation status stay
distinct. No finding is silently dropped. The renderer excludes private execution diagnostics,
escapes model Markdown and mentions, and only constructs validated GitHub source links. The
default templates are documented under
[`docs/templates`](../../docs/templates/auto-reply-pr.md).

Report sealing and outbox registration share the same SQLite transaction. A pending entry freezes
the report reference, template text, and policy/template version. After that transaction, the
dispatcher reads GitHub `/user` and verifies its numeric ID against `INVESTIGATION_GITHUB_USER_ID`.
It then rechecks authorization and its lease before saving the verified login, exact body, source
revision, and deterministic ActionIntent request together. Retries preserve that frozen body and
identity. Transport preflight rejects a changed publisher instead of silently changing attribution.
No model output or console display name supplies the GitHub identity.

A durable dispatcher recovers existing entries on startup; it does not scan reports to create
retroactive work. Each report has one native ActionIntent. Repeated finalization, concurrent
dispatchers, and restart cannot create another comment for that report. The configured transport
appends its existing correlation marker for exact readback.

The dispatcher automatically confirms the prepared intent. If delivery becomes unknown or was
interrupted in `executing`, recovery performs read-only reconciliation of that same intent. It
never resends an uncertain comment. Preparation/reconciliation retries are bounded, and the
repository UI displays pending, prepared, sending, sent, blocked, failed, or unknown delivery.
A report that is incomplete, failed, cancelled, or part of a verification/implementation follow-up
is not automatically published. A rendered comment exceeding 59,000 UTF-8 bytes is blocked with
a visible explanation instead of truncating the conclusion or findings; this reserves space for
the native marker within the transport's 60,000-byte limit.

`GET` and `PUT /api/repositories/:id/auto-reply-settings` expose the versioned policy. Updates
contain `version`, `enabled`, `pullRequestTemplate`, and `issueTemplate`; stale updates return
HTTP `409`. `GET /api/repositories/:id/auto-replies` returns the latest 20 scoped delivery records,
including the frozen comment, source report, delivery status, and returned GitHub comment ID.
These are observation controls, not a required human approval step.

Software verification must use isolated state and mocked transports. Enabling product automation
does not authorize an acceptance harness to write arbitrary real repository comments; the exact
live-test scope still follows [AGENTS.md](../../AGENTS.md).

### Track assignment tasks in one progress comment

Enable **Publish assignment task progress** in the repository's automatic reply settings
to queue an acknowledgement when an authorized assignment is durably accepted, before source import
and Task creation. The acknowledgement
identifies who assigned the PR or Issue and who received the assignment. When a Worker claims the
Task, the Server edits that comment to show that work has started. Failed, blocked, interrupted,
and cancelled Tasks update it with a public status explanation. A complete result replaces the
same comment with the configured PR or Issue conclusion, including its full collapsed details.
Assignment Tasks enrolled in this workflow do not create an additional conclusion comment.
Manually created Tasks continue to use the existing conclusion-only workflow.

Four English narrative templates are editable independently. Each listed placeholder is required
once, in order. An optional `{{status}}` may appear once before `{{trigger}}`:

| Stage | Placeholders | Default template |
| --- | --- | --- |
| Received | `{{trigger}}`, `{{updated_at}}` | [Received](../../docs/templates/progress-reply-received.md) |
| Started | `{{trigger}}`, `{{updated_at}}` | [Started](../../docs/templates/progress-reply-started.md) |
| Failed or stopped | `{{trigger}}`, `{{updated_at}}`, `{{failure}}` | [Failed](../../docs/templates/progress-reply-failed.md) |
| Completed | `{{trigger}}`, `{{updated_at}}`, `{{result}}` | [Completed](../../docs/templates/progress-reply-completed.md) |

Every stage starts with a server-owned AI identity statement naming the verified publishing GitHub
account. Recorded model names appear only when trusted execution records establish them. Editable
templates cannot remove this identity, status, scope, or next-action information. Completed replies
reuse the report identity once. `{{result}}` embeds the existing PR or Issue result. `{{failure}}`
uses a fixed public explanation instead of exposing Worker diagnostics, paths, or credentials.
`{{updated_at}}` is the UTC time of the state transition. Every template is limited to 12,000 UTF-8
bytes. If the full result cannot fit within the comment budget, the Server publishes an explicitly
labeled safe conclusion summary and retains the complete report in the Dashboard. It does not
silently truncate findings or include a private Dashboard address.

The settings API additionally accepts optional `progressEnabled` and `progressTemplates` fields.
`progressTemplates` contains `received`, `started`, `failed`, and `completed` strings. Existing
saved policies and clients that omit these fields retain conclusion-only behavior. Progress
requires the main automatic reply policy to be enabled and uses the same publishing permissions.
Saving or enabling it does not enroll historical Tasks. Each new logical update, including one
for a running Task, takes the latest saved template. Saving alone sends nothing. Prepared attempts,
retries, and prior history keep their original body. The authorizing account and authorization
epoch are independent of template editing; revocation still stops subsequent writes. An optional
`reauthorize: true` explicitly creates a fresh authorization epoch when an authorized account saves
enabled settings. The settings response includes `authorizationEpoch` and `updatedById`.

Assignment admission and its publication record share one transaction. The Task attaches to that
same publication when preparation completes. Repeated active assignments reuse the canonical
admission; their Task idempotency does not depend on our own comment changing the source snapshot.
Original discussion text remains complete, with verified application-owned comments annotated as
progress metadata. Later Task and meaningful checkpoint transitions durably update the publication.
Delayed first delivery uses the latest actual state, rather than replaying obsolete preparation
text. Resuming the same Task keeps its comment identity. A server timer reaps expired Worker leases
even when nobody is viewing the Dashboard. Before an edit, the transport verifies the comment ID,
author, target conversation, stable marker, and previously published body. An externally edited
or deleted comment is not silently overwritten or replaced. An uncertain write is reconciled with
read-only requests; it is never blindly sent again.

Each actual create/update attempt records its timestamp, exact body, status, and safe failure
reason. Reconciliation adds observations to that attempt instead of inventing another write.
An update superseded before dispatch is recorded as `cancelled` and displayed as **Cancelled**,
without error styling. Known historical superseded attempts receive the same read-only display
and filter classification; their original receipts remain unchanged. Preparation errors and
rejected requests remain **Failed**, while uncertain writes remain **Unconfirmed**.
Definitely unsent or rejected transient requests can retry within a bounded policy; ambiguous writes
only use readback. Exhaustion remains visible and does not discard the latest investigation outcome.

The Task list displays comment status and the latest attempt time. Task details and the Comments
workspace show ordinary delivery history with expandable bodies; they do not require a target versus
confirmed-body comparison. Comment refresh continues independently after a Task completes.

- `GET /api/comment-deliveries` filters by repository, Task, comment, target number, mode, or state,
  with `limit` and an opaque `cursor` for pagination.
- `GET /api/comments?taskIds=...` or `?commentIds=...` returns up to 100 scoped summaries in one request.
- `GET /api/comments/:id` returns status and available recovery actions;
  `GET /api/comments/:id/attempts` returns that comment's delivery history.
- `POST /api/comments/:id/reconcile` schedules read-only progress-comment recovery.
- `POST /api/comments/:id/sync` schedules a permitted progress-comment retry or latest update. Both
  commands require the returned `version`, an `idempotencyKey`, and current action permissions.

Historical conclusion-only comments retain their native ActionIntent recovery path. Existing
repository reply endpoints remain compatibility views. Old delivery snapshots are labeled as
historical; migration does not fabricate lost attempts, precise transmission times, or new comments.

## Listen for trusted assignments

The native runtime accepts GitHub Webhooks at `POST /api/github/webhook`. Configure
`INVESTIGATION_GITHUB_WEBHOOK_SECRET` or its `_PATH` variant with a random secret of at least
32 UTF-8 bytes, together with the ordinary GitHub read credentials. Set the GitHub Webhook URL
to the HTTPS public origin followed by `/api/github/webhook`, choose `application/json`, and
subscribe to **Issues** and **Pull requests**. The receiver validates the raw payload's SHA-256
HMAC. Browser cookies and Origin headers do not authenticate this endpoint.

In the Dashboard's repository settings, select which registered repositories listen for
assignments, the recipient's numeric GitHub user ID, and the trusted assigning user IDs.
Only a trusted `User` assigning an open PR or Issue to that recipient starts an investigation.
User IDs remain stable across login renames. Repository management permission and exact repository
scope are required to change these settings; administrator status alone grants neither. Settings
are versioned, persisted, and rechecked during preparation. They can be saved before the receiver
secret is configured. Disabling a repository stops new intake and pending preparation; existing
Tasks retain their ordinary lifecycle and can be cancelled separately.

`GET` and `PUT /api/repositories/:id/webhook-settings` expose these settings. Updates contain
`version`, `enabled`, `reviewerUserId`, and `allowedActorUserIds`; conflicting versions return
HTTP `409`. An enabled configuration needs a recipient and a nonempty trusted-user list.
Optional deployment defaults use `INVESTIGATION_GITHUB_WEBHOOK_BINDINGS_JSON` or its `_PATH`
variant, with entries such as
`{"repositoryId":"repo-example","reviewerUserId":12345678,"allowedActorUserIds":[23456789]}`.
Saved repository settings override those defaults. No repository is watched by default.

Assignment intake handles `issues.assigned` and `pull_request.assigned`; review requests, pushes,
and edits do not start assignment Tasks. Independently enabled [trusted PR E2E commands](#trusted-pr-e2e-commands)
use new `issue_comment` events to create separate execution Tasks. There is no periodic GitHub
discovery or polling. Reads occur to prepare a received event, retry that event, or serve an
explicit import. The configurable payload limit defaults to 2 MiB through
`INVESTIGATION_GITHUB_WEBHOOK_MAXIMUM_BYTES`.

After checking the exact repository and assignment grant, the Server durably records the event
and returns HTTP `202`. Background processing imports complete input and atomically creates an
ordinary `pr-review` (`source_read`) or `issue-investigate` (`snapshot_only`) Task. It verifies that
the same upstream item is still open and assigned, and that a PR still has the signed event's
base/head SHAs. Assignment intake never grants repository execution or a GitHub write capability.

Delivery ID plus payload digest prevent replay conflicts; equivalent assignment events and
the same actor/recipient's identical frozen input also share the original Task. The exact imported
snapshot and Task request are saved before Task creation, so service restart cannot substitute a
later comment snapshot or create a second Task after an uncertain local commit. Processing uses
durable leases and renewals. The inbox admits at most 1,000 pending events and returns HTTP `503`
when full. Transient processing failures retry the received event up to three attempts; a failed
canonical record can be retried through the scoped controls below or by explicitly redelivering
the same GitHub delivery. Unsupported or
unauthorized events return `ignored` without importing source or creating a Task.

An HTTP `202` response with `accepted` or `duplicate` identifies committed intake or its existing
receipt, not Task creation, execution, or completed investigation. An `ignored` response can come
from a filtered event without creating an inbox record; HTTP status alone does not prove persistence.
Receiver subscriptions and public hosting are deployment configuration; starting the application
does not create or edit GitHub Webhooks. Comments require a separately authorized publication policy
or confirmed ActionIntent. Reviews, closure, and merging retain the confirmed ActionIntent path.
All publication remains behind the external-write switch.

### Inspect and retry webhook intake

The **Webhooks** page combines assignment and E2E delivery receipts. It keeps intake state separate
from Task outcome and comment-delivery state. Authenticated readers see only their repository scope;
history remains readable when intake is disabled or no receiver is configured.

- `GET /api/github/webhook-deliveries` accepts `repositoryId`, `kind`, `number`, `state`, `mode`,
  `cursor`, and `limit`. `mode` is `static` or `e2e`; `limit` defaults to 20 and is at most 50.
  Pagination cursors are bound to the filters and current repository scope.
- `GET /api/github/webhook-deliveries/:deliveryId` returns preparation state, opaque `version`,
  failure reason, source reference, canonical delivery identity, linked Task, next attempt time,
  available actions, and processing attempt history.
- `POST /api/github/webhook-deliveries/:deliveryId/retry` accepts the current `version` and a new
  `idempotencyKey`. It requires repository scope, `repository:manage`, and `task:create`; E2E retry
  also requires repository-execution permission. Browser mutation requests retain the normal Origin
  and current-account checks.

Only a failed canonical intake can be requeued. `completed`, `ignored`, still-processing, and alias
receipts do not offer this operation. A retry starts another bounded intake cycle while preserving
prior attempts and the known cumulative count. Automatic transient retries default to three attempts
per cycle with exponential delay starting at one second. The original history is not replaced, and
older aggregate-only records do not acquire invented timestamps or attempt details.

An exact repeated retry command observes its current result without requeueing. Reusing its key for
another payload returns `webhook_retry_conflict`; a stale version returns `webhook_delivery_stale`.
Both are HTTP `409`. An ineligible receipt returns `webhook_retry_unavailable`. Insufficient grants
return HTTP `403`; an unconfigured intake returns HTTP `503` with `webhook_intake_unavailable`.

Assignment and E2E intake first recover an already committed Task. This only restores the receipt's
association, including after the repository binding was revoked; it does not rerun model or desktop
work or replace a newer active request. If no committed Task exists, current repository authority,
source identity, and applicable assignment/comment checks are required again. Another delivery of
the same E2E command still deduplicates by comment identity. Recovering a failed Task result or
requesting another execution uses the separate explicit Task workflow.

### Durable relay delivery

`src/investigation/webhook-relay-spool.ts` provides a separate SQLite spool for a relay companion.
It is not a Server-started relay or an automatic GitHub redelivery client. The companion authenticates
its event source, calls `enqueue` before forwarding, and calls `runNext` for due work. The supplied
transport posts only to a loopback `/api/github/webhook` endpoint and does not follow redirects.

The spool retains exact signed payload bytes and approved headers in a private database. Identical
delivery identity is deduplicated; changed bytes or headers under the same identity are rejected.
Only HTTP `202` with the matching delivery ID and `accepted`, `duplicate`, or `ignored` status counts
as delivered. That confirms the receiver's intake decision, not a successful Task or, for `ignored`,
an inbox record. Network errors, request timeouts, HTTP
`429`, and `5xx` receive bounded retry. Permanent rejection and malformed acknowledgements fail
visibly. Expired in-flight attempts survive restart as interrupted history and consume the same
bounded attempt allowance.

Defaults are 1,000 retained deliveries, 2 MiB per payload, a 64 MiB logical admission budget including
reserved history, and a 128 MiB SQLite page limit. The page limit excludes journal/filesystem overhead.
Each delivery initially allows six attempts, with a 20-second request timeout and exponential retry
from one second up to 30 seconds. A valid receiver `Retry-After` is respected for up to one day; a longer wait
fails visibly instead of retrying early. Capacity exhaustion rejects new events without evicting
retained receipts. The module has no automatic pruning or background timer.

The companion can explicitly call `retryFailed({deliveryId, expectedVersion, requestId, reason,
additionalAttempts?})` after addressing a failure. This module method queues work; it makes no HTTP
request. It accepts only `failed` records at the inspected numeric version. `reason` is one of
`receiver_available`, `configuration_corrected`, or `manual_recovery`. The same `requestId` and
payload replay returns the current delivery and original retry receipt without requeueing; changed
payload under that ID fails with `idempotency_conflict`. Request IDs are unique across the spool.
A stale version returns `version_conflict`; ordinary claim/result transitions also advance version.

An explicit batch defaults to six additional attempts and permits 1-100, subject to the configured
lifetime ceiling of 100 attempts by default. Cumulative attempt numbers are never reset. The
transaction preserves earlier attempts and retry receipts, reserves capacity for the added history,
and queues the batch together; insufficient capacity or remaining attempt allowance rejects the
whole change. `enqueue` of an existing delivery only returns its current record. A new retry command
rejects a delivered record. Replaying an earlier accepted retry still returns `duplicate` and its
original receipt after delivery, without queuing another attempt.

The independent spool database uses schema version 2 and additively upgrades its version 1 records
to retain retry/version metadata. This migration does not change the application's
`investigation-v5` database. Relay retry receipts and intake retry receipts are separate records and
use separate command contracts.

Relay retry only covers events already received and persisted by that relay. A failure before receipt
requires external delivery diagnosis and an explicitly requested GitHub redelivery. Socket reconnect
cannot reconstruct missing events. Keep signed payloads, signatures, and private relay state out of
logs and public reports.

## Import complete upstream inputs

After registering an exact repository ID, an operator with `repository:manage` can call
`POST /api/repositories/:id/import-work-item` with `{ "kind": "issue", "number": 7 }` or
`{ "kind": "pull_request", "number": 7 }`. This endpoint only performs GitHub GET requests. It
checks the configured account when credentials are present, plus the upstream numeric repository
ID, work item kind, and final revision. Anonymous imports require an explicitly public repository
and remain subject to GitHub's anonymous API rate limit.
It reads every conversation page, including inline review comments and review summaries for PRs.
It returns `workItem`, `snapshotRef`, and `commentsCount` after atomically saving a complete snapshot.
The source snapshots preserve immutable content archives; a current pointer selects the snapshot
copied into each newly created task. Existing tasks retain their own frozen input.

`INVESTIGATION_SOURCE_IMPORT_MAXIMUM_BYTES` defaults to 16 MiB across upstream response bodies;
`INVESTIGATION_SOURCE_IMPORT_MAXIMUM_PAGES` defaults to 1000 comment pages. Exceeding either budget,
a changed upstream target, or incomplete pagination fails the import without saving partial data.
Increase an appropriate deployment budget and retry the complete import when necessary. Inputs are
never shortened to fit these limits. Production task preparation requires an imported snapshot and
retains its entire title, body, and comment list.

PR source acquisition runs on the Worker using the exact frozen base and head SHAs. The imported
input does not claim that inline files constitute complete source coverage. For an Issue task in a
source-aware mode, explicitly provide `sourceCommit` as a full Git SHA when creating the task.
The Server verifies `GET /repos/{owner}/{repo}/commits/{sha}` returns that same SHA and adds a
`source_commit` subject while retaining the original Issue snapshot. No branch name or latest
commit is inferred.

## Bind saved plans to trusted executable steps

Saved Issue reproduction and verification plans can run without a deployment registry entry.
For `reproduction-setup` and `issue-verify`, the Server automatically binds each saved step to an
`agent-verify` operation when the Task has an explicitly selected `source_commit` or retained
`local_patch`, the plan has no outstanding prerequisites, every step has distinct validation
check IDs, and no step contains a recipe. The Worker uses the existing controlled build, test,
application, and desktop tools to execute the saved requirements against a fresh task workspace.
This path supports any module that those tools can exercise; it does not require a module recipe.
Unsupported runtime requirements remain blocked with their actual observations.

An Issue snapshot plan still requires the operator to choose its full source commit SHA before
execution. Patch verification uses the verification plan saved for that exact patch by its
producing report. It retains the original patch digest, artifact, and base revision instead of
rebinding an older plan to another subject. If an Issue assessment names a saved reproduction or
verification plan but omits an action, the action context derives a preparation entry from that
saved reference. A fix report also exposes its own saved verification plans for an available
patch produced by that report, while its primary assessment remains bound to the original source.
The original report remains unchanged. Repository execution permission and
the normal action preview and confirmation still apply.

`INVESTIGATION_EXECUTION_BINDINGS_PATH` references a deployment-owned JSON array. Each entry binds
an exact repository and saved `planRef`, or a complete `profileRef` plus `planKind`, to fixed
operations. Explicit matching entries take precedence over automatic Issue and PR recipe bindings;
multiple matching entries remain an error. A reference includes `id`, `version`, and `digest`.
For example:

```json
[
  {
    "repositoryId": "repo-powertoys-fork",
    "planRef": { "id": "saved-plan-1", "version": 1, "digest": "<actual 64-character digest>" },
    "planKind": "verification",
    "satisfiedPrerequisiteRefs": ["environment-ready"],
    "steps": [
      {
        "stepId": "verify-settings",
        "operation": {
          "kind": "command",
          "executableId": "dotnet",
          "arguments": ["test", "tests/Settings.Tests.csproj", "--no-restore"],
          "workingDirectory": ".",
          "expectedExitCode": 0
        }
      }
    ]
  }
]
```

Replace example IDs and digests with the actual saved plan data. Every plan step must have exactly
one operation in the same order, and globally distinct validation check IDs. Verification and
reproduction plans need at least one actual check; setup steps can have none. Model-edit steps do
not establish validation success, and an implementation-only plan can produce a patch without
claiming tests passed. All prerequisites require
explicit matching acknowledgements. The Server computes each operation digest and binds the
result to the exact plan, source revision, execution policy, and authorizing operator. It never
substitutes model text into command arguments. Missing or ambiguous bindings fail task creation
with a specific missing-prerequisite response; they do not produce a successful validation.

Worker executable IDs resolve through `INVESTIGATION_WORKER_EXECUTABLES_JSON`, whose entries contain
trusted absolute paths and SHA-256 pins. A UI operation uses
`{ "kind": "ui", "adapterId": "...", "scenarioId": "..." }` and still requires a configured
Worker adapter. An unavailable adapter reports a blocked result. Implementation and issue-fix
plans require at least one `{ "kind": "model-edit", "allowedPaths": ["src/example.ts"] }`
operation. Allowed edit paths are explicit repository-relative files, without globs or traversal;
validation tasks cannot contain model-edit steps. Registry changes take effect after server restart,
and already-created tasks preserve their frozen execution binding.

An inherited `local_patch` subject keeps its original artifact metadata in `Task.sourceArtifacts`.
The sealed child report copies that lineage to `context.sourceArtifacts`, preserving the producing
task and attempt IDs. It is not an artifact or execution observation newly produced by the child.
Admission and Worker reads verify the exact saved parent report, patch subject, digest, and current
content availability. A required patch that has expired or gone missing cannot be replaced with a
different branch or artifact under the same task identity.

## Deployment Task budget defaults

New Tasks without an explicit budget use the deployment defaults below. This includes signed
assignment intake and trusted E2E comment intake. These settings are read at startup; GitHub
comments cannot change them. Existing Tasks, idempotent creation retries, and resumed Tasks retain
their recorded budgets. An authorized explicit Task budget continues to take precedence.

| Setting | Default | Allowed values |
| --- | --- | --- |
| `INVESTIGATION_DEFAULT_TASK_MAX_TOKENS` | `120000` | Positive safe integers |
| `INVESTIGATION_DEFAULT_TASK_MAX_ROUNDS` | `24` | Positive safe integers |
| `INVESTIGATION_DEFAULT_TASK_MAX_DURATION_MS` | `1800000` | Positive integers up to `2147483647` |

The duration maximum matches the process timer limit. The Server's report-size limit continues
to supply `maxReportBytes`. These are per-Task limits, not a shared deployment spending allowance;
an acceptance run with an aggregate token allowance must monitor usage across its Tasks.

## Trusted PR E2E commands

Repository webhook settings support an optional `e2eEnabled` flag, disabled by default. It uses
the existing `reviewerUserId` and `allowedActorUserIds`; assignment intake and E2E intake can be
enabled independently. Subscribe the signed webhook receiver to `issue_comment` as well as
`pull_request` events. A trusted user starts a standalone `pr-e2e` Task with this plain command
on its own line in a new PR conversation comment:

```text
@configured-account e2e
```

The account name is resolved to the configured numeric reviewer ID. Quoted, fenced, indented,
hidden, edited, bot-authored, or previously published automation comments do not authorize
execution. The sender must match the comment's author and belong to the trusted numeric ID list.
The receiver re-reads the comment, repository, and open PR before committing a Task. A trusted
human may mention the same account they use; automation detection uses recorded comment IDs,
not a blanket prohibition on self-mentions.

Each command is durable and idempotent by repository/comment ID. An active E2E Task for the same
base/head revision is reused; a new command after a terminal result can request another run.
`pull_request.synchronize` re-reads the current PR and cancels obsolete work without starting a
new revision automatically. Cancellation retains desktop ownership until normal Worker cleanup
is confirmed. Source preparation is serialized per PR across intake instances to prevent stale
reads from superseding newer work.

E2E Tasks have no required parent static report or saved plan. They are explicitly authorized to
execute repository code, use their own prompt, and own a separate progress publication and exact
GitHub comment ID. Static review comments cannot be selected as E2E update targets.

Repository `e2eEnabled` authorizes intake; the separate per-Worker setting authorizes execution
admission. An accepted request can remain queued until a permitted, capable Worker is available.
Disabling a Worker does not change repository trust or publication settings.

Image/video publication accepts only the exact Server-authorized `pr-e2e` Task, sealed report,
pinned subject, and Server-assigned producer attempts with trusted E2E tool observations. Static
report media and forged producer metadata cannot enter that pipeline. This publication boundary
does not prohibit a model from taking a local screenshot.

## Evidence retention and capacity

The investigation database stores artifact content, mutable metadata, retention pins, and aggregate
usage separately. Immutable reports and artifact identities retain their original content digests
and provenance when stored content later expires. Configure these process environment settings
before starting the Server; the [configuration template](./.env.example) contains the defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `INVESTIGATION_EVIDENCE_MAXIMUM_BYTES` | `1073741824` (1 GiB) | Maximum resident original artifact-content bytes. |
| `INVESTIGATION_EVIDENCE_MAXIMUM_COUNT` | `10000` | Maximum number of resident artifact contents. |
| `INVESTIGATION_EVIDENCE_RETENTION_SECONDS` | `2592000` (30 days) | Minimum age before unprotected content becomes eligible for cleanup. |
| `INVESTIGATION_EVIDENCE_CLEANUP_INTERVAL_SECONDS` | `60` | Interval between bounded cleanup passes. |
| `INVESTIGATION_EVIDENCE_CLEANUP_BATCH_SIZE` | `100` | Maximum metadata records scanned in one pass. |

All values must be positive integers. Cleanup runs one bounded pass during startup and then on the
configured interval. It scans metadata without loading artifact content and continues from a saved
cursor; the defaults do not promise that every eligible artifact expires within one minute. The
retention age begins at the later of upload time and the producing task's latest update.

Queued/running task content is protected. Accepted checkpoint artifacts remain protected when an
unfinished task may need recovery, including completed analysis awaiting final report delivery.
Parent tasks and required inherited patch producers are pinned until the dependent task reaches
`completed`. A cancelled or interrupted follow-up may therefore continue retaining its source.
Protected content is not evicted to make room for another upload.

Upload validation and quota accounting share the lease-checked write transaction. Exceeding either
resident quota returns HTTP `409` with `evidence_quota_exceeded`; no new content is accepted. Allow
eligible retention cleanup to release capacity or increase the appropriate configured quota and
restart the Server. A capacity increase cannot recover content that has already expired. Earlier
reports and retained metadata remain available even after content cleanup.

Use the authenticated, repository-scoped artifact APIs to distinguish frozen report declarations
from current storage availability:

- `GET /api/artifacts/:id` returns `{artifact, storedAt, expiredAt, retentionProtected}`. The returned
  artifact's `availability` is the current `available`, `expired`, or `missing` state.
- `GET /api/artifacts/:id/content` returns the original content when available. Expired content
  returns HTTP `410` with `artifact_expired`; missing content returns HTTP `410` with
  `artifact_missing`. These responses do not alter the immutable report or logical content digest.

The byte quota counts decoded original content. It excludes Base64 expansion, retained metadata,
reports, SQLite indexes and pages, and WAL overhead. Cleanup releases logical artifact quota but
does not guarantee that SQLite or WAL files shrink on disk. Size the deployment for physical
database growth separately; resident evidence limits are not a bound on total database size or a
workload-capacity acceptance result.

## Verification and deployment acceptance

Run project verification on the project-designated remote Windows worker. Linux-specific checks
may use `test-env`; local verification requires explicit authorization for the current task.
Tests use isolated databases and mocked or read-only upstream transports. No ordinary test run
authorizes actual PR or Issue writes.

The [investigation acceptance instructions](../../deploy/investigation-acceptance/README.md) provide
an opt-in synthetic lifecycle harness and a separate real CLI companion. They run prebuilt
production entry points with isolated state and document source manifests, prerequisites, and
scope exclusions. Their availability is not a claim that an acceptance run has completed; record
actual results and remaining deployment boundaries in [Implementation Status](../../docs/IMPLEMENTATION_STATUS.md).
