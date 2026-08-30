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

List endpoints accept `page`, `pageSize`, and `search`. Filters use their
contract field names and repeat the query key for OR semantics. Requests use
`credentials: include`, reject redirects, and have a 15-second absolute
deadline. Response bodies are streamed through a 2 MiB limit before JSON is
parsed. Every successful response is structurally validated and explicitly
mapped from the shared Server contract into the page-facing model.

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
