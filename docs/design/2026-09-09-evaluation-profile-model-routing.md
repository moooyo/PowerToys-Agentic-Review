# Evaluation envelope and CLI model routing

The current model path is
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md). Ordinary reviews,
evaluation reviews and summaries use the configured Codex or Copilot CLI. There is no separate
evaluation app-server backend, provider registry, HTTP relay or provider call ledger.

## Frozen input and model requirements

The Worker validates the complete frozen evaluation source, repository, work item, revision,
Profile, Prompt and Job/lease identity. Evaluation authorization remains distinct from ordinary
Issue source authorization. A model configuration cannot change execution purpose or authorize
an upstream PR/Issue mutation.

| Context | Model step | Recorded model facts |
| --- | --- | --- |
| Ordinary PR static/build or Issue triage | Required review | CLI configuration, exit and structured output |
| Ordinary PR UI or Issue validation | Optional summary, subject to configuration | CLI configuration, exit and structured output when requested |
| Profile-only evaluation | No model step | Explicit absence of a requested model |
| Required-model static/build or triage evaluation | Required review | CLI configuration, exit and structured output |
| Required-model UI or Issue validation evaluation | Required summary | CLI configuration, exit and structured summary output |

Profile-only evaluation invokes no model executor. A required model cannot become
`not_requested` because the CLI is unavailable or output validation fails. Such failures retain
their typed outcome alongside the original runner facts. A required evaluation summary does not
enable ordinary optional summaries. Cancellation and lease loss propagate through the current
attempt's process supervision.

## Result and acceptance boundary

The Server checks the task's model requirement, structured output and current completion
ownership. Model output remains separate from deterministic checks, evidence and source state.
The configured model name and observed CLI version are diagnostic/reproducibility facts, not
independent verification of a provider's remote model.

Synthetic routing and result tests do not establish actual CLI login, model execution or the
intended Windows VM deployment. Retain source, cancellation, process draining and workspace
cleanup evidence for real acceptance. Existing data and archived historical artifacts remain
unchanged.
