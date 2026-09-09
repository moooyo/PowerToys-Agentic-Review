# Frozen summary invocation protocol (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

Authenticated summary-input freezing and its task-bound reference remain in use. Provider
registration references and the ScopeV2 opening/seal/ledger protocol are retired from the active
model path. Required evaluation summaries and optional production summaries use the selected
CLI configuration; there is no separate evaluation app-server policy or provider metadata file.

The summary still consumes the trusted Prompt and bounded runner/evidence context. Original
runner checks, failed observations, source identity and evidence remain independent of model
advice. A summary cannot invent successful checks, replace missing evidence or authorize an
external PR/Issue write. The Worker validates the returned structured summary against its schema
and retains CLI configuration and process exit with the task result.

The current design does not require the project to inspect provider requests, copy CLI login
storage or verify the provider's remote model identity. Historical input/receipt artifacts remain
unchanged and describe only their original implementation. Their passing tests do not establish
acceptance of the current direct CLI path or the intended VM deployment.
