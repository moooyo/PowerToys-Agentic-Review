# ADR 0017: Stage Artifact HostControl v2 as a Dormant Fixed-Origin Contract

- Status: Accepted
- Date: 2026-09-03

## Context

ADR 0008 assigns result-artifact upload and artifact-backed completion authority to the Control
payload and the native Control ServiceHost. The Server routes and a source-only Control upload
session exist, but production claims still use `inline_result_v1`. The installed split-worker
foundation also has no safe HostControl upgrade signal:

- RuntimeBootstrap and both pipe names are version one;
- the committed RoleConfig is exact schema version two and permits no execution;
- the release manifest requires `serviceHostRpcVersion = 1`;
- the production Node client and Go `localrpc` decoder recognize only RPC 1.0; and
- the current entrypoints are hash-pinned zero-slot supervisors.

Adding artifact operations to the version-one operation union would therefore make them reachable
without a negotiated release boundary. Treating a new operation as a feature probe would also let
an untrusted Node payload choose whether the native credential owner forwards lease-bearing data.

## Decision

Artifact HostControl v2 is staged as an independent, source-only contract. It is not an extension of
the production version-one client or dispatcher. Version one continues to reject version-two frames
and unknown operations.

### Closed operation surface

Protocol `2.0` contains exactly these five calls:

```text
CreateArtifactUpload
PutArtifactChunk
FinalizeArtifactUpload
TerminateArtifactUpload
CompleteArtifactRun
```

Their payloads contain only one opaque bounded JSON body descriptor and the route identities needed
by the fixed operation:

```text
CreateArtifactUpload   -> { body, runAttemptId }
PutArtifactChunk       -> { body, chunkIndex, uploadId }
FinalizeArtifactUpload -> { body, uploadId }
TerminateArtifactUpload-> { body, uploadId }
CompleteArtifactRun    -> { body, runAttemptId }
```

Node cannot supply a URL, HTTP method, header, origin, proxy, redirect policy, certificate selector,
certificate path, filesystem path, or arbitrary operation name. Route identifiers use the closed
entity grammar, and `chunkIndex` is an integer from zero through seven. The TypeScript adapter checks
the request schema and every duplicated route/body identity before dispatch, then checks the strict
public response schema and returned identities.

### Fixed Server transport

The dormant Go capability borrows the already constructed `workertransport.Client`. That client is
created from verified Control configuration and owns the canonical HTTPS origin, TLS 1.3 policy,
root set, non-exportable client signer, server name, no-proxy policy, disabled redirects and
compression, header limits, concurrency gate, and lifecycle. The artifact capability exposes no
configuration and derives only these targets:

```text
POST /api/v1/worker/runs/:runAttemptId/artifacts                    -> 200 or 201
PUT  /api/v1/worker/artifact-uploads/:uploadId/chunks/:chunkIndex  -> 200
POST /api/v1/worker/artifact-uploads/:uploadId/complete            -> 200
POST /api/v1/worker/artifact-uploads/:uploadId/terminate           -> 200
POST /api/v1/worker/runs/:runAttemptId/complete                    -> 200
```

Any other success status is a protocol failure. A redirect is never a success. The control-body,
chunk-body, and response-body limits are respectively 16,384, 365,910, and 16,384 decoded bytes.
The canonical local frame ceilings are 32,768 bytes for control calls, 524,288 bytes for chunk calls,
and 32,768 bytes for responses. Each ceiling applies to the canonical JSON document named by the
four-byte little-endian length prefix; the physical stream record is therefore four bytes larger.
The cross-language create-call golden and all physical ceilings are locked in both implementations.

### Errors and ambiguous outcomes

A strict, operation-specific allowlisted Server status tuple preserves only its stable lowercase
`code` and boolean `retryable`; its message is replaced with reviewed generic text. Malformed status
bodies, strict but unallowlisted tuples, `artifact_service_unavailable`, and unexpected status or
success responses after dispatch are reported as `artifact_outcome_unknown`. The fail-stop
`artifact_service_unavailable` tuple preserves `retryable = false`; other unprovable outcomes are
retryable. Network failure, timeout, cancellation, and response read failure after dispatch follow
the same conservative rule. Neither the native layer nor the Node adapter automatically replays an
unknown outcome. The Control upload session remains the only future owner of exact application
replay.

`ArtifactClientV2` consumes the generic transport `StatusError` only inside `executeArtifact`. It
strictly parses a closed known-code `ErrorDetails`, clears the raw body, and returns a new
`ArtifactServerError` containing private status, code, retryability, and presence fields. It never
wraps or exposes the original status error, body, Server message, or cause. Malformed, duplicated,
null-typed, and unknown-code details return with no retained details and therefore become an unknown
outcome in the dispatcher.

Only validation or cancellation observed before the dispatcher invokes an artifact client method is
classified as pre-dispatch. Once that method is invoked, every returned failure is treated as
post-dispatch. `ArtifactServerError` unwraps to the fixed `ErrUnexpectedStatus` sentinel solely for
legacy transport categorization; that sentinel does not prove that the HTTP mutation was not sent
and never changes the dispatcher outcome rule.

`lease_lost` maps to lease-revoked authority. Other allowlisted Server errors are definitive while
retaining the Server retryability bit. Unknown local exceptions are ambiguous. Public local-RPC
error envelopes and Node mapped errors never retain the raw response body, request body, URL,
certificate data, causal exception, or lease token. Response and error-code reflection of the
private lease token is rejected.

The legacy `WorkerApiError` now honors an explicit retryability value from a strict Server
`ErrorDetails` or decoded HostControl error. Status-based inference remains whenever no trusted
retryability field exists, including a local transport failure or malformed Server error body.

### Dormancy and activation

The version-two TypeScript protocol and API adapter are absent from all barrels and from the legacy,
Control, and Executor production import graphs. The Go codec, dispatcher, and fixed-origin artifact
capability have no production composition consumer. Static guards reject direct, indirect, or
runtime-loader reachability and keep the existing RPC1 operation set, RoleConfig v2, release
compatibility, and zero-slot entrypoints unchanged.

Activation requires a separate reviewed release change that introduces an exact compatibility
version, a bootstrap and RoleConfig schema that explicitly selects RPC2, signed matching Node and Go
artifacts, native Windows transport tests, and the later claim-envelope rollout. Merely compiling
these source modules grants no Claim, lease, slot, execution, or completion-mode authority.

## Consequences

- The fixed-origin artifact path can be reviewed and tested before it receives production authority.
- RPC1 remains intentionally incapable of transporting artifact operations.
- Error retryability no longer silently changes when an HTTP status and Server `retryable` disagree.
- A future activation cannot be represented as a small entrypoint import; it must cross the release,
  bootstrap, RoleConfig, compatibility, and native-evidence gates together.

## Out of Scope

- ARWX 1.0 or result-digest negotiation;
- RoleConfig v3 and production RPC2 negotiation;
- artifact-mode claim selection or any enabled execution slot;
- production wiring between the upload session and this adapter;
- installer, signing, or native Windows evidence for RPC2; and
- automatic replay, artifact retention, or publication behavior.

## References

- [ADR 0007: Isolate Windows Worker Control and Execution Identities][adr-0007]
- [ADR 0008: Store and Complete Result Artifacts through a Fenced Content-Addressed Protocol][adr-0008]

[adr-0007]: 0007-windows-control-executor-isolation.md
[adr-0008]: 0008-result-artifact-storage-and-completion.md
