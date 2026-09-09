# Provider invocation control (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

Separate provider-call openings, relay closure commitments and HTTP ledger submissions are no longer the model execution path. The existing Worker credential, frozen task inputs, Job lease, process supervision and structured-result completion retain their task ownership roles. The CLI owns its provider calls and authentication.

The current architecture has no global provider registry, project-owned model HTTP relay or
provider request/response ledger. Model-required work still requires an available CLI, valid
structured output and the current task lease. Missing model output cannot be replaced by
successful deterministic validation.

Historical milestone reports and captured artifacts remain evidence for their original source
and scope only. They do not establish acceptance of the direct CLI path, a real configured model,
or the intended VM deployment. Existing data and archived artifacts are unchanged.
