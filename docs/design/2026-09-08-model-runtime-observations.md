# Model runtime observation foundation

## Purpose and current boundary

Prompt evaluation must distinguish the requested model configuration from the provider metadata
actually observed during an invocation. A successful final JSON file alone does not identify the
runtime, account for previous failed calls, or establish that the execution stayed within its
authorized boundary.

This increment introduces strict metadata contracts, a Responses observer, a per-invocation
loopback relay, an ordered receipt recorder, and a pure domain consistency verifier. It does not
enable evaluation execution, configure a real provider, or grant repository write authority.
The production evaluation refusal and withheld Worker capability remain in place.

## Stable identity and dynamic scope

`ModelRuntimeIdentityV1` records a provider identifier, the digest of its complete endpoint,
the provider-reported model identifier, the CLI version and executable digest, a launch-policy
digest, and the relay implementation and policy digests. Launch policy includes the effective
reasoning, tool and configuration settings; dynamic paths and credentials are not stable identity.
An identical executable and model name with a different launch policy is a different identity.

`ModelInvocationScopeV1` separately binds the repository, evaluation, cell, run, request, job,
attempt, invocation, authorization, execution manifest, rendered prompt, output schema, requested
model, expected identity, Worker instance and lease generation. Reusing a matching model receipt
from another attempt does not satisfy this scope.

The provider-reported `response.model` is an observation from that endpoint. It is not an
attestation of underlying hardware, weights, or a provider's internal routing. The expected
identity must come from a separately managed, frozen registry; it must not be inferred from the
very response being evaluated.

## Bounded observation and transport

The observer consumes raw UTF-8 JSON or SSE bytes with bounded body, event, sequence and output
budgets. It rejects duplicate decoded JSON keys, invalid Unicode, ambiguous metadata, invalid
terminal events and incomplete transport. SSE event sequences start at zero and remain contiguous.
Final output binding uses canonical JSON from the last completed assistant message in the terminal
response. Text deltas, earlier messages, tool calls and non-JSON prose do not substitute for it.

The relay listens only on an ephemeral IPv4 loopback port. A random 256-bit bearer capability
authorizes one invocation; it is not the provider credential. Its sole operation is a JSON POST
to `/v1/responses`, forwarded to one fixed HTTPS endpoint without redirects or client header
forwarding. Authorization is supplied by a trusted callback and snapshotted before transport.
Known authentication values are protected even if the callback omits them from its protected list.

Requests cannot select a different model, start background execution, invoke hosted tools, or
refer to an unobserved previous response. Remote image/file references, stored conversation
references and unsupported operations are rejected. These request restrictions do not confine
local custom tools or prove that a model process has no independent network route.

One invocation permits only sequential upstream calls and has aggregate request, response,
event and call budgets, an absolute deadline and bounded shutdown. Response chunks are copied
before both observation and forwarding so mutable transport buffers cannot change the recorded
bytes. Cancellation, rejected authenticated requests, protocol faults and unconfirmed cleanup
cannot produce a successful closed result. Unauthorized requests do not enter the call ledger.

## Complete call ledger and output binding

Each admitted model call records raw request and response digests, byte counts, HTTP status,
timestamps and its typed outcome. Receipts form a contiguous ordered hash chain, including failed,
partial and retried calls. A later successful response does not erase an earlier failure.

The recorder snapshots immutable scope and runtime values. It permits only one active call,
rejects contradictory completion metadata and freezes its closed record. A non-null final output
digest must match the last completed call's observed JSON output. Mixed or missing model identity
remains unknown; it is never filled from requested configuration.

Before admitting another call, the recorder reserves space for its worst-case metadata and the
final identity and closure fields within the aggregate 1 MiB contract. Reaching that budget rejects
the next dispatch while preserving every admitted call. Protocol timestamps allow at most three
fractional digits so comparisons do not silently discard accepted sub-millisecond precision.

The domain verifier recomputes scope, receipt, identity and closure hashes, checks call ordering,
compares the complete frozen scope, and distinguishes `matched`, `mismatched`, `unavailable` and
`invalid`. `matched` describes consistency with supplied trusted expectations, not independent
authentication or execution acceptance.

The expected closure digest must come from an independently authenticated and attempt-fenced
closure record. An unkeyed hash chain alone is insufficient: a caller can remove a failed prefix
and rehash the surviving records. Computing the expected seal directly from the submitted blob
would defeat the completeness check.

## Integration still required

1. Immutable platform runtime registrations and evaluation selection/freezing are now implemented;
   see the [registry design](./2026-09-08-model-runtime-registry.md). Historical unknown identity stays
   unknown. This does not establish observed execution or an accepted collector.
2. Measure the actual CLI binary and effective launch policy, connect a trusted authorization
   helper, and keep provider credentials outside model workspaces and model-visible configuration.
3. Establish and accept the actual command/model execution boundary. The earlier controlled model
   probe allowed a loopback connection, so network isolation is currently unaccepted.
4. Authenticated, attempt-bound opening/seal/ledger transport and owner consistency checks are now
   implemented; see [invocation control](./2026-09-08-model-invocation-control.md). The collector
   session still needs production runner composition, and final completion must independently
   bind the validated model output and accepted execution boundary before accepting model results.
5. Scoped operator invocation diagnostics are now implemented and verified independently of final
   results; see [the diagnostic design](./2026-09-08-evaluation-model-invocation-diagnostics.md).
   Versioned result/output binding and trusted evaluation scoring remain open. Do not silently
   upgrade legacy results or turn missing identity into pass.
6. Exercise real accepted providers and both Windows and Web evaluation workflows in their intended
   isolated environments, including cancellation, retries, evidence and restoration.

All current relay acceptance uses synthetic upstream transport. General local or test-env testing
permission does not authorize any actual PR or Issue mutation.
