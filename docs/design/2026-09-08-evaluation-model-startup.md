# Evaluation app-server startup (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The separate evaluation app-server backend, deployment-policy digest configuration and static provider loader are retired. Model-enabled startup requires WORKER_CLI_ENGINE (codex or copilot) and WORKER_CLI_EXECUTABLE_PATH. WORKER_CLI_HOME, WORKER_CLI_MODEL and WORKER_CLI_SHA256 are optional. ProcessHost detects the actual CLI version with a bounded --version invocation; no configured CLI version is required.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
