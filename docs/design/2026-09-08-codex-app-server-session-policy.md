# Codex app-server session policy (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

Merged-provider policy measurement, parent relay composition and app-server review/summary policy pins are retired from active startup. The selected CLI owns its own configuration, provider access and login. The Worker manages task input, structured output and process lifetime; the deployment owns VM filesystem and network isolation.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
