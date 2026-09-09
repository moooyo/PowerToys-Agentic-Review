# Provider response observation (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The project-owned Responses relay, HTTP observer, ordered provider call ledger and remote-model identity comparison are retired. The project records configured CLI engine/model, the startup-observed CLI version, process exit and validated structured output. These records do not independently identify the remote provider or the model behind a configured name.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
