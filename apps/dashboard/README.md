# Agentic Review Dashboard

This application is the React 19 and Ant Design Pro operations console for
Agentic Review. Umi Max owns routing and application composition, while the
layout plugin renders the standard ProLayout shell.

## Data boundary

Pages depend only on the `ReviewControlAdapter` interface in
`src/services/review-control/adapter.ts`. Development builds use
`MockReviewControlAdapter`; production builds use `HttpReviewControlAdapter`.
Pages, tables, and domain-facing components do not import wire DTOs or mock
fixtures directly.

The HTTP adapter reads these same-origin endpoints:

- `GET /api/v1/dashboard/work-items`
- `GET /api/v1/dashboard/jobs`
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

Approval, publication, requeue, cancellation, and worker drain APIs are not
part of the current Server milestone. The production adapter rejects those
operations with `ReviewControlUnsupportedOperationError`; it never reports a
fixture mutation as successful.

## Routes

- `/work-items`
- `/jobs`
- `/workers`
- `/approvals`
- `/publications`
- `/system`

The root route redirects to `/work-items`. No Ant Design Pro demo dashboard,
mock server, account center, or analytics sample is included.
