# Provider invocation diagnostics (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

Provider identity comparisons and complete HTTP call histories are retired from active model diagnostics. Current task diagnostics describe the selected CLI configuration, detected CLI version, process exit and structured output. A configured model label or a successful process exit is not proof of a particular provider model or a passed validation check.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
