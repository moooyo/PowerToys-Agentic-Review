# Relay-backed prepared invocation lifecycle (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The relay-backed prepared invocation, ephemeral relay credential and replacement per-attempt CLI authentication home are retired. The Worker launches the selected CLI against the task inputs and schema, supervises its process, validates structured output and performs normal attempt cleanup. CLI-owned login storage is not read or copied into a task.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
