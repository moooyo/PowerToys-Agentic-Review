# Model runtime registry (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The platform-wide provider/runtime registration catalog, immutable provider identity selections and registry-derived model requirements are retired. Model selection belongs to the CLI configuration used for the task; the application does not require a provider registration before a Worker can run a model task.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
