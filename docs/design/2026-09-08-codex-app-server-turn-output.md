# Codex app-server turn output (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The application-owned app-server turn protocol is no longer the model execution interface. Codex CLI and GitHub Copilot CLI run through the current direct CLI adapter. The Worker validates bounded structured output against the task schema and retains process exit separately; provider HTTP responses and notifications do not form an application call ledger.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
