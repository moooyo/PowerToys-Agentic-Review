# Evaluation model invocation diagnostics

## Operator workflow

Every evaluation matrix cell has a model-call history action independent of its final result.
An operator can inspect an opening, a closure awaiting its ledger, a matched collection or a failed
collection even when the Job has not produced a validation result. An opening does not imply that
a process is still running. Collection consistency does not establish execution isolation, final
result binding or approval eligibility.

The drawer shows the frozen expected model and the recorded provider model, typed call outcome
counts, collection reasons, server receipt times and cleanup observations. Invalid collections do
not expose an identity as verified. Digests and detailed identifiers are available on demand;
they are not substitutes for a validation report. Profile-only cells explicitly identify model
execution as not requested. Sample mode requires a connected Server and creates no model records.

## Scoped read protocol

`GET /api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId/cells/:cellId/model-invocations`
returns `EvaluationCellInvocationListV1`. The page size defaults to ten and is limited to ten;
the entire response is bounded by 2 MiB. Items are ordered by opening time and invocation ID,
both descending, and each retains opening, optional seal/submission, optional observed identity,
and optional outcome counts. Counts come from the exact stored ledger only after submission.
Raw call ledgers, request bodies, response bodies, tokens and provider headers are not returned.

The operator request envelope and owner transaction enforce current repository read permission.
Historical reads do not require an active old Worker credential or lease. The owner resolves the
exact frozen evaluation cell and reuses complete opening/seal/submission integrity checks,
recomputes stored intent/content digests, and verifies every scope and reference. Each retained
ledger remains limited to 1 MiB. The route and browser adapter independently validate response
scope, pagination, registration/scope/observed-identity digests and paired state.

The drawer is read only and refreshes explicitly. It does not poll full ledgers. Its query is keyed
by authenticated session and the complete selected cell binding. Unreadable, inactive or changed
repository scope unmounts the content. Refresh and error states hide prior data, while confirmed
permission loss triggers the page's existing access invalidation. A newly visible Job may appear
after the matrix snapshot; an already known Job and its frozen Run/request cannot be replaced by
another identity in the history response.

## Production collector prerequisites

Trusted-binary verification now retains the SHA256 actually calculated, byte count, stable file
identity and verification time for each binary, alongside its existing path. These are file
measurements. They do not identify an actual loaded process image or supply a measured CLI version;
the configured `WORKER_CODEX_VERSION` remains a declaration.

The separate `loadCodexRelayProviderProfile` loader handles an explicit HTTPS custom provider with
static headers. Header values remain inside a parent-only authorization callback. Its public output
is a declaration and retains `effectivePolicy: "unverified"`; it contains no CLI header environment
or authentication command. Implicit providers, login-backed authentication and unverified command
helpers are unsupported. The existing direct-provider loader's behavior is unchanged.

The requested configuration cannot establish the complete effective policy. The official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
describes provider settings, while
[managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration#locations-and-precedence)
describes additional machine and enterprise requirement layers. Actual behavior must be checked
for the deployed CLI version and environment; a launcher descriptor digest is not a replacement.

These prerequisites are not yet composed into the production model executor. Required-model
claim/completion gates and withheld evaluation capability remain unchanged. Final model output
needs its own exact binding to independently accepted execution evidence before it can participate
in trusted result projection and scoring. Any actual repository PR/Issue mutation still requires
explicit approval of its target, operation and content.
