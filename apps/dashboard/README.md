# Agentic Review Dashboard

The dashboard is the React 19 and Material UI 9 interface for structured PR and
Issue investigations. Vite builds the application, React Router provides static
page registration, and TanStack Query manages server data. The Material shell
provides repository selection, light and dark themes, and session controls.

The current application follows `WorkItem -> Task -> Attempt / LoopCheckpoint ->
Report`. Its entry point uses the implementation in `src/investigation/` and the
new investigation contracts. Retired Jobs, Workers, configuration, notification,
and evaluation pages are not registered in the current shell. Their remaining
source files do not provide a compatibility API or a migration path.

## Pages and navigation

| Route | Current behavior |
| --- | --- |
| `/pull-requests` | Lists registered pull requests; `workItemId` opens the item, its tasks, and available actions. |
| `/issues` | Lists registered issues and opens their investigations, including Bug and Feature assessments. |
| `/tasks` | Lists tasks; `taskId` opens attempts, the saved checkpoint, the latest report, and linked tasks. |
| `/reports` | Opens the immutable report identified by `reportId`; reached from an item or task. |
| `/repositories` | Lists repositories shared with the account and offers scoped PR/Issue import when permitted. |

`/` and `/work-items` redirect to `/pull-requests`. The `repositoryId` query
parameter preserves repository selection. A report link can also specify
`section=validation`, `section=evidence`, or `section=changes` to open the evidence
section. Retired and unknown routes show an unavailable page.

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

## Structured reports

The interface distinguishes execution outcome, report completeness, review
conclusion, and actual validation. A completed investigation does not certify
that the code is correct or that required E2E checks passed. A checkpoint or
partial report retains findings, evidence, limitations, and remaining work.

Reports provide:

- PR review conclusions and an independent E2E assessment.
- Bug conclusions, missing information, hypotheses, and separate reproduction status.
- Feature requirements, feasibility, decisions, saved plans, and acceptance criteria.
- Findings with P0-P3 priority, trigger conditions, impact, root cause, evidence,
  final recheck information, repair advice, and an editable independent feedback draft.
- Coverage units, all retained candidates, loop progress, and pending rechecks.
- Exact original PR, Issue snapshot, source commit, local patch, and remote branch subjects.
- Actual validation checks, evidence provenance, artifact availability, and diagnostics.

Findings use cursor pagination with 25 items per page. The displayed total comes
from the complete server collection, not the visible page. Header, page, and
export responses are checked against report identity, version, digest, and
collection totals. The complete JSON export also supplies evidence and saved
plans and can be downloaded from the report. Registered available artifacts use
the authenticated content endpoint; missing sample artifacts have no fake
download destination.

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

Valid suggestions are selected by default using the server's complete selection
context. Selection survives pagination and preserves explicit deselection.
Preparing feedback includes only selected findings and independent drafts,
including any edits. Mixed text and code suggestions can be combined. Clearing
selection restores the recommendation's default operation only when the user
has not explicitly selected an operation. A code suggestion does not implicitly
choose Request changes. A P0 outside the loaded page cannot be bypassed by
clearing or changing the selection.

Follow-up operations come from persisted, validated `nextActions` and exact saved
plans. `canPrepare` allows reviewing and completing a preparation form;
`readyToExecute` and the returned guards describe execution prerequisites.
Issue follow-up work can require an explicit source commit. Selecting a plan or
entering a SHA does not assert that other prerequisites have been satisfied.

Preparation saves an `ActionIntent` and opens its exact payload, target, expected
SHA/revision, and guards. Execution requires a separate confirmation bound to the
intent version and payload digest. The server performs fresh checks before
dispatch. An `executing` or `unknown` submission can be reconciled without
resubmitting the operation. Read-only next actions navigate to the existing
report or evidence. Creating a PR requires an existing verified remote branch;
the dashboard does not implicitly commit or push changes.

## Production API and session boundary

The production bundle uses the same-origin typed HTTP client in
`src/investigation/api.ts`. Successful responses are validated against TypeBox
contracts. Requests include the session cookie, disable caching, and reject
redirects. Failed or malformed responses surface errors; they never fall back to
sample data or fabricated success.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/session` | Read the authenticated identity, repository grants, permissions, and action capabilities. |
| `POST /api/auth/login` | Start loopback or OIDC sign-in. |
| `POST /api/auth/logout` | End the session. |
| `GET /api/auth/callback` | Complete the server's OIDC callback. |
| `GET /api/repositories` | List accessible repositories. |
| `POST /api/repositories/:id/import-work-item` | Import a PR or Issue snapshot and complete comment history through read-only upstream requests. |
| `GET /api/work-items` and `GET /api/work-items/:id` | Read registered items. |
| `GET /api/tasks` and `GET /api/tasks/:id` | Read tasks, attempts, checkpoints, and linked work. |
| `POST /api/tasks` | Create an investigation with server-frozen inputs. |
| `POST /api/tasks/:id/resume` and `POST /api/tasks/:id/cancel` | Resume with an idempotency key and optional increased budget, or cancel execution. |
| `GET /api/reports/:id` | Read a report header. |
| `GET /api/reports/:id/findings` | Read a cursor-based findings page. |
| `GET /api/reports/:id/export` | Read the complete structured result. |
| `GET /api/artifacts/:id/content` | Download authorized registered artifact bytes. |
| `GET /api/work-items/:id/action-context` | Obtain current recommendations, selection defaults, and operation guards. |
| `POST /api/action-intents` | Prepare an exact operation preview. |
| `GET /api/action-intents/:id` | Read an operation's recorded status. |
| `POST /api/action-intents/:id/confirm` | Confirm the reviewed version and payload digest. |
| `POST /api/action-intents/:id/reconcile` | Resolve an executing or unknown submission from its existing receipt. |

Repository and operation authorization comes from the authenticated server
session. Logout immediately removes protected views and suspends outstanding and
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

Only `NODE_ENV=development` selects `createSampleInvestigationApi()`. The sample
factory uses the pure shared `createInvestigationPreview` helper and owns isolated
in-memory state. Production pages and the API selector use static imports; sample
initialization remains inside the removable development branch. Do not add
dynamic loaders, eagerly instantiate sample state at module scope, or import
test-only bridges from production modules.

The repository selector contains `moooyo/PowerToys` as `repo-powertoys-fork`.
Open `/pull-requests?repositoryId=repo-powertoys-fork` to inspect these five
synthetic investigations:

| Sample | Behavior to inspect |
| --- | --- |
| PR #2101 | A P1 with required, unrun E2E checks; mixed suggestion and text feedback; manual Approve remains available. |
| PR #2102 | 26 findings with the P0 on page two; Approve is blocked before that page loads while Merge retains its independent guards. |
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

Use the authorized execution environment for the commands below. Tests, type
checks, builds used for verification, browser smoke tests, and runtime probes
must run on `test-env` unless the user explicitly authorizes local verification
for the current task. Connect with:

```powershell
ssh test-env
```

From the repository checkout on that host, prepare and start the development
preview with:

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
report pagination, preparation versus confirmation, logout, and narrow layouts.
If `test-env` is unavailable, report verification as blocked; do not fall back to
local testing.

Automated verification must use mocked upstream responses, isolated synthetic
data, or read-only live checks. Access to `test-env` is not authorization to
create or mutate a repository's actual PRs or Issues. Live writes require the
user's explicit approval of the exact targets, operations, content, and execution
scope.

The product contract and loop design are documented in
[Structured investigation results and loop](../../docs/design/2026-09-15-structured-investigation-results-and-loop.md).
