# Model output validation and bounded correction

Static investigation output is validated before it becomes an accepted analysis round. A rejected proposal retains the `MODEL_OUTPUT_INVALID` error code and now records a controlled rule identifier and structural JSON paths. Diagnostic messages come from fixed descriptions. They do not retain rejected values, arbitrary exception text, unknown property names, or complete model responses.

## Correction eligibility

The Worker may request one correction per attempt and proposed analysis round for `duplicate_record_id` or `reference_outside_batch` at explicitly allowed record paths. Task or checkpoint binding errors, subject and scope violations, permission failures, and unconfirmed process cleanup are not eligible. Unknown or incomplete token usage also prevents another invocation. E2E and saved-plan execution do not use this correction path.

Every corrected proposal passes the original schema, reference, scope, and checkpoint validation. Correction does not invent missing records, remove validation requirements, or accept any part of the rejected analysis.

## Durable execution boundary

Before another model invocation, the Worker must receive acknowledgement of both the rejected invocation's complete usage receipt and a `rejected_analysis` checkpoint. The Server validates the original lease, current checkpoint reference, invocation identity, eligible diagnostic, and persistent correction quota. Repeated delivery of the same request is idempotent.

The rejection checkpoint preserves the accepted analysis and round number. It records safe rejection metadata, advances the checkpoint version, and updates consumption from the invocation ledger. The ledger counts rejected and accepted invocations independently; the eventual accepted round refers only to its own invocation receipt. An invocation identifier on terminal usage reconciliation prevents a lost rejection acknowledgement from charging the same invocation again.

The corrective invocation uses the newly acknowledged checkpoint and remaining budget. It retains the original deadline, cancellation signal, frozen source scope, and execution permissions. Cancellation, lease loss, exhausted budgets, incomplete accounting, or exhausted correction quota stops further invocation. This mechanism does not resume a stopped task or create another task.

## Response handling

A schema-valid proposal that already passed protected-value checks may be supplied to its immediate corrective invocation as untrusted context. This optional copy remains private in memory, is size bounded, and is never part of the diagnostic or rejection checkpoint. If the copy does not fit, correction receives only the safe rule and paths alongside the current frozen context.

Historical failures whose complete responses were discarded cannot be reconstructed by this change. The new diagnostics identify future rejection causes; they do not establish the exact cause of an earlier failure without retained evidence.
