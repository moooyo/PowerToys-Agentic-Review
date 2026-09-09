# Provider metadata policy (retired)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](../design/2026-09-10-cli-owned-model-execution.md).

The Worker no longer reads provider profiles, HTTP header values or a provider metadata classification file. No such file is required or consumed by CLI-owned model execution. Operators use the selected CLI's own login and configuration; the application does not inspect or copy those authentication/provider files.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
