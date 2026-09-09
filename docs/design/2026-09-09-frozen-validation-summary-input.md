# Frozen validation summary inputs

Summary advice is generated from the original published Prompt plus the actual runner report,
execution observations, and evidence context. An original Prompt digest alone cannot identify
that model input. This change records the complete context before opening the summary invocation
and binds the composed Prompt through an explicit ScopeV2, without changing historical V1 bytes.

## Input ownership

`createValidationSummaryContext` and `composeSummaryPrompt` now live in `@agentic-review/codex`.
The Worker uses these shared functions directly and retains their previous serialized bytes.
The context excludes workspace objects and lease credentials. It preserves all supplied runner
facts, failed checks, evidence manifests, typed scenario observations, and reproduction/probe
observations; it never silently truncates context to fit a model budget.

The new authenticated Worker operation `freezeValidationSummaryInput` uses
`POST /api/v1/worker/model-summary-inputs`. Its body contains the lease, a retained input ID, and
the complete `ValidationSummaryContextV1`. Context is bounded to 256 KiB; the request and stored
document allow an additional 32 KiB of metadata. Opening, seal, and receipt-control limits remain
unchanged. Duplicate decoded JSON keys, invalid UTF-8, extra fields, and mismatched input scope
are rejected before use.

The database owner resolves the exact frozen evaluation/cell, original Prompt, model registration,
profile, current Worker credentials and active attempt. Only required-model `pr_ui` and
`issue_validation` evaluations can create this record. A profile-only evaluation cannot acquire
model authority by submitting a context. Existing mapped evaluation reproduction restrictions
remain unchanged; this operation does not substitute ordinary Issue authorization.

The owner verifies registered checks, original report facts and referenced evidence. File-backed
evidence uses the existing bounded verification worker and a final synchronized authority check.
Typed scenario JSON must match the actual verified steps asset's canonical content, including
partial/failed observations. A metadata digest supplied by the Worker is insufficient.

Migration 0032 adds immutable `model_summary_inputs`. There is at most one input per attempt.
No input can be added after an invocation has opened. Exact replay returns the original receipt;
changed content, identities, or input IDs conflict. Recovery permits only the existing exact replay
under its normal authority rules. Retained documents include the full context and Server-derived
identity; stored hashes and column bindings are rechecked when read.

## Versioned invocation binding

`ModelInvocationScopeV2` retains the original `promptSha256` and adds
`purpose: "validation_summary"` plus a `ValidationSummaryInputReferenceV1`. That reference binds
the input ID, complete document digest, context digest, original Prompt digest, composed Prompt
digest, and output-schema digest. V2 has corresponding OpeningV2 and ReceiptSetV2 containers;
mixed container/scope versions are invalid. V1 definitions and historical serialization are retained.

The new summary factory snapshots the envelope and context before asynchronous work, freezes one
input, rebuilds the expected document against the frozen envelope, and compares the entire receipt.
It retains the same preparation promise after failure or response uncertainty instead of generating
another input. Same-attempt changes to context, lease identity, or owner signal cannot acquire a
second invocation. The input API cannot mutate the parent's expected snapshot through its request.

Input freezing is included in the optional summary timeout and uses a bounded child signal.
The model workspace and process are prepared only after the reference is verified. ScopeV2 can
only use the summary read-only launch policy; wrong policy fails before opening an invocation.
Both the original Prompt identity and the exact composed Prompt/context identities are required
at Worker handoffs. The parent relay and output guards retain their existing credential protections.

Server opening and history reads independently rebuild the V2 scope from the immutable input and
original cell. New summary openings require the reference. Ordinary reviews reject summary refs
and retain V1. Seal and submission records bind the resulting scope digest; no successful API
response or matched ledger is treated as OS confinement or execution acceptance.

Final V2 summary result binding also compares the retained runner report, source state, cleanup
facts, original non-model lifecycle arrays, probe results, and reproduction observations against
the input. Only additional `model_review` lifecycle entries are permitted. Model advice remains
separate from runner facts. Current evidence availability and permissions still use the existing
completion/read checks; historical input reconstruction does not require an active lease.

## Startup and remaining acceptance

`WORKER_EVALUATION_MODEL_SUMMARY_POLICY_SHA256` optionally pins the independent observed summary
policy. It requires the same explicit app-server composition and parent input-freezing API.
Ordinary optional summaries retain their previous backend. Configured composition still does not
advertise evaluation capability or remove the execution-boundary guard.

Verification must include shared contract/hash compatibility, Worker composition and cancellation,
strict HTTP/owner/SQLite handling, V1-to-V2 history and migration preservation, real file evidence
rejection, and final-result tamper rejection. Synthetic collector receipts and fake process output
prove those integration properties only. Actual model execution, Windows application scenarios,
the per-home sandbox credential lifecycle and intended production deployment remain separate
acceptance requirements. No repository PR/Issue write is authorized by this operation.
