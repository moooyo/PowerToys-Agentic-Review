# Agentic Review Dashboard

This application is the React 19 and Ant Design Pro operations console for
Agentic Review. Umi Max owns routing and application composition, while the
layout plugin provides the shared navigation shell.

The standalone `typecheck` and `build` scripts first build the shared contracts
package. The dashboard consumes its package-exported declarations instead of
redirecting the TypeScript project reference to source files; this preserves
TypeBox's ESM symbol identity across the package boundary.
Development excludes the workspace contracts package from MFSU dependency
prebundling so new exported schemas are not hidden by an unchanged package version.

## Interface design

The interface follows the [Ant Design specification](https://ant.design/docs/spec/introduce-cn).
Use the default Ant Design theme and native components for controls, status,
tabs, cards, and structured data. Product CSS handles layout and content
wrapping without redefining each component's visual system.

The [layout](https://ant.design/docs/spec/layout-cn) uses an 8px spacing grid,
24px desktop page gutters, and 16px mobile gutters. The
[type system](https://ant.design/docs/spec/font-cn) uses system fonts and
14px body text with 22px line height. The light navigation and white content
surfaces use neutral grays; standard blue identifies actions and selections.
Functional colors retain their standard status meanings.

New primary pages use `components/PageHeader` and the `--app-*` aliases in
`src/global.css`. Following the [data-list guidance](https://ant.design/docs/spec/data-list-cn),
pull requests and issues have separate lists, while Jobs and Workers use
tables for comparison. Detail drawers group results, validation, and execution
using native tabs and descriptions. Result counts come from adapter responses,
never inferred from the current page of records.

## Data boundary

Operational pages use `ReviewControlAdapter` in
`src/services/review-control/adapter.ts`. Repository management and versioned
configuration use the separate `RepositoryAdapter` and `ConfigurationAdapter`
interfaces. Development builds select their sample adapters explicitly;
production builds always select the HTTP implementations and never fall back
to sample data. Configuration adapters validate the shared contract DTOs,
including distinct summary and full-content responses.

The HTTP adapter reads these same-origin endpoints:

- `GET /api/v1/dashboard/work-items`
- `GET /api/v1/dashboard/jobs`
- `GET /api/v1/dashboard/jobs/:jobId`
- `GET /api/v1/dashboard/workers`
- `GET /api/v1/dashboard/system`
- `GET /api/v1/operator/worker-nodes`

The Workers page also manages the per-worker bearer credential lifecycle through
three narrowly allowlisted same-origin mutations:

- `POST /api/v1/operator/worker-nodes`
- `POST /api/v1/operator/worker-nodes/:workerNodeId/token/rotate`
- `POST /api/v1/operator/worker-nodes/:workerNodeId/revoke`

Dashboard list endpoints accept `page`, `pageSize`, and `search`. Filters use
their contract field names and repeat the query key for OR semantics. The
operator worker-node roster and runtime Worker inventory are each read in
strict 200-record pages and aggregated up to 10,000 records. Aggregation fails
closed if the reported total changes, a worker repeats, or pagination stops
making progress. Both aggregations request immutable identity ordering so
heartbeats and credential lifecycle updates cannot reorder records across
offset pages. The
authenticated credential scope allows 300 requests per
minute so a maximum-size roster can be loaded and refreshed without exhausting
the route budget. Requests use
`credentials: include`, reject redirects, and have a 15-second absolute
deadline. Response bodies are streamed through a 2 MiB limit before JSON is
parsed. Every successful response is structurally validated and explicitly
mapped from the shared Server contract into the page-facing model.

The Job detail response exposes only the structured persisted result projection. It does not repeat
the canonical raw result JSON, so the detail endpoint remains inside the same bounded response
channel. Review-run evidence is read through a separate attempt-scoped manifest and content API.

The Workers table paginates the cached merged snapshot locally with 50 rows by
default and a hard maximum of 200 rows. Page and filter changes do not repeat
the full network aggregation. Explicit refreshes and successful credential
mutations invalidate the snapshot; failed loads are not retained.

Created and rotated worker tokens are held only in component memory and shown
in a one-time credential panel that prevents accidental dismissal. The
dashboard never writes a token to logs, URLs, or browser storage. Explicitly
closing the panel clears the token from application state; it cannot be
recovered from the dashboard afterward.

Token rotation sends the roster record's `updatedAt` value as a compare-and-set
precondition. A stale dashboard therefore cannot replace a token created by a
newer concurrent rotation.

Approval, publication, legacy work-item requeue, legacy job cancellation, and worker drain APIs are not
part of the current Server milestone. The legacy production adapter rejects those
operations with `ReviewControlUnsupportedOperationError`; it never reports a
fixture mutation as successful.

## Workspaces and routes

- `/pull-requests` tracks code reviews and the revision under review.
- `/issues` tracks issue triage, suggested labels, and missing information.
- `/jobs` monitors execution, retries, and failures across both workflows.
- `/repositories` manages repository identity, authorization, and connection checks.
- `/prompts` manages prompt drafts, immutable published versions, and workflow bindings.
- `/validation-profiles` manages versioned validation configuration for one repository.
- `/workers` manages the worker inventory and credential lifecycle.
- `/system` shows component health, processing activity, and runtime details.

Pull requests and issues have separate navigation entries and request their
own server-filtered, paginated lists. Opening an item shows its latest job by
identity. Results appear first; Validation separates model-reported checks
from worker-captured evidence, and Execution contains attempts, failure
details, and diagnostics. Items without a job explain how to request work on
GitHub. Older revision results are explicitly marked as superseded.

The root route and legacy `/work-items` route redirect to `/pull-requests`.
The `repositoryId` query parameter preserves repository selection across navigation.
Pull requests, issues, and jobs apply it to server-side queries and counts; changing
the selection resets pagination. Invalid or unknown selections display an error
instead of silently opening an all-repository view.
The `/approvals` and `/publications` prototype routes remain available for
development but are hidden from primary navigation; their mutations remain
unsupported in production. Development previews are labeled as sample data.
No Ant Design Pro demo dashboard, mock server, account center, or analytics
sample is included.

## Versioned configuration

Configuration pages use the authenticated same-origin `/api/v1/operator` routes
for prompts, prompt bindings, and repository validation profiles. The HTTP client
allowlists each method and path, rejects redirected requests, bounds request and
response bodies to 2 MiB, and validates repository, workflow, template, and version
identity in responses. Prompt content has an additional 256 KiB UTF-8 limit.

Prompt drafts are editable. Saving and publishing use the template's `version`
as a compare-and-set precondition. Published content is read-only: a rollback
changes the selected binding to an older published version. Global prompt
bindings use an explicit null repository scope; repository bindings take
precedence, while an absent repository binding inherits the global binding.
Binding updates use their own version precondition. A conflict requires loading
current state and reviewing the operator's intended change again.

Validation profiles require a concrete repository selection. Editing an existing
profile publishes a new immutable version without changing its workflow or
execution target. Each stage contains structured executable, argument, directory,
environment, timeout, and requirement settings. The JSON editor changes configuration
only; it does not execute commands. Static issue triage must have no setup, build,
test, launch, or cleanup commands. UI and issue-validation workflows require a
matching execution driver. Publishing or enabling a profile is not evidence that
tests have run or passed.

Prompt preview is a server-rendered operation and can fail independently of draft
saving. It includes the template workflow and optionally one exact work-item ID.
The preview digest hashes the rendered content; a published version's digest hashes
its stored prompt body. If the server does not provide rendering, the page reports
the service error instead of presenting sample output as a production preview.

## Review runs and validation reports

Each pull request and issue offers `View runs`; its detail view and run history
offer `Run validation`. Run creation sends the current 64-character revision key,
not a Git head SHA, and a client-generated activation ID. Retrying an unchanged
creation intent reuses that ID. Enabled profile bindings resolve to their published
versions before selection; required profiles cannot be removed. The server still
rechecks authorization, required profiles, and current configuration atomically.

An issue-validation request requires an exact source commit and explicit operator
acknowledgement that code at that commit may execute. Static issue triage does not
infer a source commit. A missing GitHub authorization epoch or unavailable profile
configuration prevents submission and explains the next action. Creation can return
a blocked plan; it is not a claim that validation ran or passed.

The `ReviewRunAdapter` uses `/api/v1/operator/repositories/:repositoryId/review-runs`
for paginated history and run details. Creation uses
`/api/v1/operator/repositories/:repositoryId/work-items/:workItemId/review-runs`.
Request job history and one selected saved result use nested
`/:reviewRunId/requests/:requestId/jobs` and `/:jobId/result` paths. Every response
is validated against its repository, run, request, and job scope. A run detail
contains only bounded result previews; full reports load when a job is selected.

The report separates execution state, required check outcomes, expected and actual
behavior, model recommendations, and policy eligibility. Missing results do not
imply success. Issue policy eligibility is not applicable. Frozen source commits,
profile and prompt versions, superseded revisions, lifecycle blockers, and job
history remain inspectable.

Each request offers `Rerun profile` after its current job finishes, and `Cancel execution`
while its latest job can still be stopped. Both use repository/run/request-scoped POST
routes; cancellation also binds the exact job ID. The rerun confirmation retains its
activation ID after a failed response, so retries reuse the same server-side intent.
Successful actions refresh the run and its history. The server remains authoritative
for current revision, authorization, and execution readiness.

Evidence files use `/api/v1/operator/repositories/:repositoryId/review-runs/:runId/jobs/:jobId/attempts/:runAttemptId/evidence`.
Manifest identity is checked against the request, profile, revision, and plan as well as
the URL scope. Referenced but absent files are marked missing; retired files cannot be opened.
Before opening content, the client refreshes its manifest, requires the exact media type
and byte count, and verifies SHA-256. Downloads have a 60-second absolute content deadline
and remain bounded by the manifest's 64 MiB asset ceiling (16 MiB for PNG screenshots).
Only PNG content is previewed inline through a temporary object URL; every other format is
downloaded. Preview URLs are released when the view closes or changes scope.

Sample mode presents reference IDs without uploaded content and disables rerun/cancel controls.
It never sends these execution actions or evidence content requests to the real API.

Evidence verification can finish after a report is read. A response with
`evidenceVerificationPending: true` retains the original runner checks while showing
`Evidence verification pending`; its current `evidenceComplete` must be false.
Required pending evidence withholds policy eligibility. Optional pending evidence remains
visible without blocking otherwise complete required validation. Verification and availability
are mutable read metadata and are excluded from immutable report-preview comparisons.
Visible run and selected-result views refresh pending verification with 5, 10, 20, then
30-second delays, stopping after six refreshes or a read error. Hidden pages and inactive
verification views do not poll. Explicit refresh starts a new bounded window; completed
execution discovered by the existing run polling loads its saved report automatically.

The validation profile JSON editor accepts typed `ui` scenarios and validates their
target against the profile's execution target. Web navigation and Windows ownership
constraints remain part of the shared schema and semantic validation.
