# Evaluation model startup composition

The production Worker can now compose the parent-owned app-server review backend from its existing
HTTP API, verified Codex executable, static relay provider profile, and the actual deployed Worker
implementation. This closes the startup dependency wiring gap. It does not enable evaluation
execution or certify Windows sandbox enforcement. The evaluation capability remains absent and
the existing execution boundary rejects evaluation jobs before workspace preparation or commands.

## Configuration and deployment

Composition is absent by default. Explicit configuration requires execution to be enabled, the
pinned Codex version `0.145.0`, and all of these environment variables:

| Variable | Meaning |
| --- | --- |
| `WORKER_EVALUATION_MODEL_BACKEND` | Exactly `app_server`. |
| `WORKER_EVALUATION_MODEL_WORKER_BUNDLE_SHA256` | Reviewed SHA-256 of the deployed `worker.mjs`. |
| `WORKER_EVALUATION_MODEL_NODE_SHA256` | Reviewed SHA-256 of the running Node executable. |
| `WORKER_EVALUATION_MODEL_REVIEW_POLICY_SHA256` | Expected observed review-session configuration projection. This is not an execution-acceptance flag. |

Pins are lowercase hexadecimal SHA-256 values. Missing pins, unsupported backend/version, unknown
evaluation model configuration fields, and configuration while execution is disabled are rejected.
The optional `WORKER_EVALUATION_MODEL_SUMMARY_POLICY_SHA256` pins the separate summary policy and
requires the parent input-freezing API. Its versioned input protocol is described in the
[frozen summary input design](./2026-09-09-frozen-validation-summary-input.md).

The executing `worker.mjs` and Node executable must both reside inside the existing deployment-owned,
read-only trusted executable root. The module path must match the process entry point; hashing a
separate probe bundle is insufficient. Node 24 supports either no extra interpreter arguments or
the existing start command's single `--enable-source-maps` flag. Other interpreter arguments and
nonempty `NODE_OPTIONS` are rejected. This prevents an unmeasured loader from being treated as the
configured Worker implementation; it does not prove the OS made the trusted root immutable.
The interpreter must also satisfy the Worker's existing Node 24.20.0 minimum.

The same stable-handle verifier used by trusted native tools checks file identity, resolved paths,
regular-file status, bounded byte reads, expected digests, closure, and the root after reading.
The `.mjs` allowance applies only to the fixed Worker entry role. The existing ProcessHost, Codex,
Git, and new Node role still require `.exe`. Both file verifications settle before startup returns
an error. A deployment must keep the root immutable while the Worker runs; hashing after module
loading is not a substitute for deployment ownership.

The relay implementation digest is the canonical digest of this descriptor:

```json
{
  "schemaVersion": "WorkerModelRelayImplementationV1",
  "workerBundleSha256": "<measured worker.mjs SHA-256>",
  "nodeExecutableSha256": "<measured Node executable SHA-256>",
  "nodeVersion": "<running Node version>",
  "nodeExecArguments": ["--enable-source-maps"]
}
```

An invocation without source maps uses an empty argument array, giving a different implementation
digest. The full Worker bundle contains the relay implementation and bundled dependencies; the
separately packaged Playwright runtime is used by UI validation, not by the model relay. The relay
policy digest comes from `describeModelResponseRelayPolicy()` for the actual default limits.
Runtime registration remains a reviewed expectation and must match these identities; registration
alone does not establish confinement, provider execution, or an accepted model result.

## Parent composition and dispatch

`main()` supplies the same `HttpWorkerApi` used by the Worker to the parent invocation factory.
Startup reads the static relay provider profile only when composition is explicitly configured.
Unsupported authentication or profile forms stop configured startup; they never cause a fallback.
Constructing the factory performs no authorization call, opens no listener, and sends no model or
invocation API request. The ProcessHost's interactive stdin support is requested only for this
configured backend, and its existing handshake still checks actual support.

Profile executor factories now receive the frozen envelope and scoped execution context. Ordinary
PR/Issue model reviews and ordinary optional summaries retain the existing exec backend. Required
evaluation model review selects the new backend and parent factory. It receives neither the legacy
upstream provider environment nor its configuration overrides. The frozen task selects the model;
the provider's declared reasoning effort, context window, and automatic compaction threshold are
preserved in the new policy and checked against actual CLI observations.

The static provider exposes its already classified protected values through a parent-only accessor.
These feed the model-output guards, including authentication values echoed inside otherwise valid
JSON results. They are never passed as CLI environment variables or arguments. Public metadata
classification retains its existing exact provider/endpoint/header/value rules. The accessor does
not add credential material to the serializable provider declaration.

## Remaining acceptance boundaries

- ScopeV1 requires an evaluation with a required model and frozen runtime registration. It cannot
  be reused for ordinary jobs or optional profile-only summaries by inventing evaluation fields.
- Evaluation summaries append runner/evidence context to the original Prompt. Their separate factory
  first freezes that complete input, verifies the receipt, and creates ScopeV2. It retains both
  original and composed Prompt identities without rewriting the envelope.
- The real fresh-home metadata preflight reported `updateRequired`. Per-attempt Windows sandbox
  identity and credential lifecycle still need a compatible design and an approved test machine.
  This change performs no sandbox setup and adds no setup method to the production transport.
- Actual model execution, Windows application scenarios, and deployment acceptance remain open.
  Composition tests use synthetic profiles, measurements, and APIs. They are not real execution.
- No real repository PR/Issue writes are authorized by this configuration or its tests.
