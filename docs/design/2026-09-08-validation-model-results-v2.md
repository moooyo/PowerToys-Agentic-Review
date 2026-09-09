# Validation results with bound original model output

## Versioned result contract

`ValidationJobResultV1` retains its existing definition, stored bytes and interpretation.
`ValidationJobResultV2` keeps the runner report, lifecycle details, probe receipts and reproduction
assessment at the existing top-level locations. Its runner report cannot contain a model summary
or model-authored checks. A completed model branch contains one original model result, a thin
invocation reference and separate Worker execution evidence.

The model result is the exact schema-validated original object: a PR review model result, an
Issue triage model result, or the workflow's validation summary. It cannot contain Worker
`executionEvidence`. The invocation reference contains `invocationId`, `scopeSha256`,
`receiptSetSha256` and `modelOutputSha256`. The last field binds that one original object after
canonical serialization. The completion request's outer `resultDigest` independently binds the
entire versioned validation result. There is no caller-supplied raw/enriched digest pair.

The whole result is bounded to 2 MiB. Unsafe, invalid, unbound or oversized model output cannot
remain completed after redaction or truncation. Model failures retain bounded failure information
and the independently captured runner facts when the complete resulting envelope fits its limits.
Failure invocation details remain available through invocation history.

## Worker production components

The prepared runner already retains original model JSON and its canonical digest. The review
executor captures an immutable internal model-output artifact before the legacy enrichment path.
That artifact retains the parent scope for cross-executor checking, while only the thin reference
enters the public V2 result. Worker command observations and worktree state remain separate from
the original model object. The profile executor assembles the final V2 envelope and recalculates
its outer digest; the completion RPC does not gain an unauthenticated side channel.

Recording requirements come from parent executor configuration and are captured before delegation.
A missing required artifact cannot fall back to a completed legacy V1 model result. The summary
path retains its actual composed-input digest. It cannot use the frozen template digest as proof
of a different prompt containing runner and evidence context.

## Server content binding and reads

The owner recomputes the original object's digest and binds it to the actual repository, Run,
request, Job, attempt, Worker instance, generation and frozen evaluation configuration. It reads
the independent opening, seal and submitted ledger, verifies their references and hashes, and
requires a complete matching collection and exact sealed output digest. Workflow schema and
business identity checks remain separate from generic JSON shape validation.

Stored-result decoding preserves the actual result version, canonical bytes and outer digest.
Ordinary results, evaluation selections, evidence preparation, findings, reproduction projections
and human-decision snapshots use the shared version-aware decoder and model-content selectors.
Selectors never manufacture an enriched result or rewrite historical V1 data. Dashboard response
contracts continue to project runner facts and model advice independently.

Matching content does not authenticate an execution boundary. Invocation receipts retain
`executionAccepted: false`, required-model claim/completion gates remain unavailable, and matching
collection does not supply trusted evaluation scoring identity. Historical V1 identity remains
unknown. Existing assessment snapshots and scores are not recalculated by this result upgrade.

## Storage upgrade

Migration `0031_validation_model_outputs.sql` extends the result table's versioned CHECKs and adds
relational constraints for a completed V2 invocation reference. Its controlled startup rebuild
disables foreign keys only on the unready owner connection, takes `BEGIN IMMEDIATE`, rechecks the
migration ledger, and preserves the current schema dependencies. It restores the exact current
trigger definitions, including the M29 insertion fence, rather than reinstalling the older V1
migration's trigger text.

The rebuild verifies historical TEXT/BLOB bytes, typed values, rowids, child-table rows, foreign
keys, columns and indexes before committing. SQLite byte projections avoid losing differences
through Node string decoding. Schema allowlists identify the complete schema/type/name/table
tuple so a view cannot impersonate an allowed trigger. Failure attempts rollback of the owned
transaction and restoration of foreign-key enforcement; startup fails if either cannot be
confirmed. An existing caller transaction is never taken over.

## Acceptance boundary

This version upgrade does not enable production evaluation execution or compose the startup
runtime measurement/session factory. Actual CLI/effective-policy measurement, command/network
isolation and Windows application/deployment acceptance remain required. Tests use synthetic
execution/provider data and isolated databases; any real repository PR/Issue write still needs
explicit approval of the exact target, operation and content.
