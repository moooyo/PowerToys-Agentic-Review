# Investigation Windows Worker

The active Worker consumes the native Task/Attempt protocol. `src/main.ts` starts
`createInvestigationExecutionRuntime`, bundled as `dist/worker.mjs`. It does not translate Tasks
into legacy Job envelopes. Legacy `WORKER_*` deployment examples are not configuration for this
entry point.

The Worker uses ProcessHost for process lifetime, scoped attempt directories for source and model
inputs, durable checkpoints for continuation, and bounded report parts and evidence uploads.
Static model turns return structured analysis. Implementation steps return structured edits that
the Worker applies only after checking each allowed path and expected original-content digest.
No task implicitly commits, pushes, or publishes a GitHub action.

## Deployment configuration

Use Node.js 24.20.x and the compiled Windows ProcessHost. Configure the following variables in
the dedicated Worker account. Paths must be canonical local Windows paths. Mutable data must be
separate from trusted tools and the CLI account configuration.

| Variable | Meaning |
| --- | --- |
| `INVESTIGATION_WORKER_SERVER_URL` | Server origin, normally HTTPS, without a path or credentials. |
| `INVESTIGATION_WORKER_TOKEN` | The 43-256 character base64url bearer credential registered in Server `INVESTIGATION_WORKERS_JSON`. |
| `INVESTIGATION_WORKER_ALLOW_INSECURE_HTTP` | Defaults to false; must explicitly be true for an intended HTTP environment. |
| `INVESTIGATION_WORKER_DATA_DIRECTORY` | Owned mutable data root; attempts are created under its `attempts` directory. |
| `INVESTIGATION_WORKER_TRUSTED_EXECUTABLE_ROOT` | Separate trusted directory containing ProcessHost and Git. |
| `INVESTIGATION_WORKER_PROCESS_HOST_PATH`, `INVESTIGATION_WORKER_PROCESS_HOST_SHA256` | Exact ProcessHost executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_GIT_PATH`, `INVESTIGATION_WORKER_GIT_SHA256` | Exact Git executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_CLI_PATH`, `INVESTIGATION_WORKER_CLI_SHA256` | Exact configured CLI executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_CLI_ENGINE` | `codex` or `copilot`; defaults to `codex`. |
| `INVESTIGATION_WORKER_CLI_MODEL` | Optional model identifier passed to the CLI. |
| `INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON` | Exact public repository names allowed for source checkout, such as `["moooyo/PowerToys"]`. |
| `INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON` | Explicit non-secret account paths, including `USERPROFILE` and `CODEX_HOME` or `COPILOT_HOME`. |
| `INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED` | Set true only after configuring the deployment-owned static CLI policy and unmanaged-tool exclusions. |
| `INVESTIGATION_WORKER_DISABLED_MCP_SERVERS_JSON` | MCP server names explicitly disabled for model turns. |
| `INVESTIGATION_WORKER_PATH` | Optional explicit trusted executable search path. |
| `INVESTIGATION_WORKER_EXECUTABLES_JSON` | Maps trusted command IDs to `{ "path", "sha256" }`. |
| `INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON` | Explicit non-secret environment values for registered execution steps. |
| `INVESTIGATION_WORKER_UI_ADAPTERS_JSON` | Registered Windows/Web UI adapters with pinned drivers, application bindings, and frozen scenarios. |

The CLI owns its account login. The Worker does not copy authentication files. Its service
credential is never placed in child process environments or model input. Git source acquisition
uses an explicit public repository allowlist and disables inherited credentials, hooks, and
submodule execution.

## Task execution

Supported task kinds are `pr-review`, `issue-investigate`, `pr-verify`, `issue-verify`,
`reproduction-setup`, `issue-fix`, and `feature-implement`. `INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON`
can restrict the claimed kinds. Snapshot-only investigation does not checkout or execute source.
Source-aware Issue work requires an explicitly selected commit; the Worker does not guess a branch.

PR source preparation verifies exact base/head and merge-base identities. Investigation maintains
complete coverage and candidate/recheck records; a final report is not a top-k selection. Partial
outcomes retain known findings and the remaining work. Resume uses the accepted checkpoint and
frozen source/configuration, not an assumed surviving CLI session.

Executable plans require the Server's trusted execution binding as well as Worker executable or
UI registrations. A natural-language plan alone cannot run commands. Command, UI, and model-edit
steps write start records before execution and retain actual outcomes, source identity, and
artifacts afterward. An uncertain in-flight mutation is not automatically replayed.

UI adapter configuration is validated by `src/investigation/ui-plan-adapter.ts`. Web scenarios
use pinned browser/driver files and an owned application origin. Windows desktop scenarios need
an active, unlocked dedicated session and an exclusive desktop lock. Missing readiness or evidence
is reported as a blocker; a model summary cannot fabricate a successful UI result.

## Limits and shutdown

`INVESTIGATION_WORKER_MAX_CONCURRENT_TASKS` defaults to 1. Configure bounded process duration,
process count, memory, and output through `PROCESS_TIMEOUT_MS`, `MAX_PROCESS_COUNT`,
`MAX_MEMORY_BYTES`, and `MAX_OUTPUT_BYTES`, each prefixed with `INVESTIGATION_WORKER_`.
`GIT_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `CLAIM_POLL_MS`, and `SHUTDOWN_TIMEOUT_MS` use the same prefix.
Task budgets are independently frozen by the Server and enforced across loop and plan receipts.

SIGINT/SIGTERM shutdown stops new claims, cancels owned work, drains managed processes, and closes
ProcessHost. Unconfirmed cleanup produces a node fault and retains the affected workspace rather
than claiming a successful release. A new Worker must not reuse an uncertain attempt directory.

## Verification

Run project verification on `ssh test-env` unless the user explicitly authorizes local validation
for the current task. Tests use isolated state and injected model, filesystem, process, and GitHub
transports. Linux verification does not establish real Windows desktop or real-model acceptance.

Build with `pnpm --filter @agentic-review/worker build` in the authorized environment, then start
the configured Worker with `pnpm --filter @agentic-review/worker start`. Actual PR/Issue writes are
handled by the Server's separate confirmed action-intent path and require their own explicit scope.
