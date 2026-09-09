# Provider-ledger result binding (superseded)

Status: superseded on 2026-09-10 by
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md).

The former model-result reference to an independent provider opening, closure seal and complete
HTTP ledger is retired from active execution. Current model records contain CLI configuration,
process exit and validated structured output associated with the existing task and lease. There
is no global provider registry or independently verified remote-model identity requirement.

The original model result remains distinct from Worker-observed validation checks, execution
diagnostics, source state and evidence. The Worker and Server continue to validate result shape,
task scope and terminal ownership. Missing, invalid or oversized model output cannot become a
completed model result, and a successful deterministic check cannot replace required model output.

The product remains unreleased. This document does not request a database reset, conversion,
compatibility layer or migration. Existing data and historical result/acceptance artifacts are
untouched. Historical provider-ledger tests establish only their original implementation scope;
actual CLI/model execution and the intended VM deployment require separate acceptance.
