# CLI-owned model execution

Decision: 2026-09-10. Worker runs the already configured Codex or Copilot CLI on its dedicated VM.
The CLI owns model-service connectivity, login, credentials and user settings. The project does
not operate an HTTP model relay, read authentication/provider files, register provider identities,
or require a second model-service configuration for Evaluation.

## Deployment and ownership

Each VM hosts one long-lived Worker. Existing task leases, concurrency limits, cancellation,
ProcessHost resource limits, workspace cleanup and terminal reporting remain. The deployment owns
VM isolation. CLI tasks use the host's configured user/profile environment and an optional explicit
CLI home. Worker never copies or resets that home. Source/build commands retain their separate
minimal environment; project control credentials must not be inherited by model child processes.

Worker model configuration has two required values: `WORKER_CLI_ENGINE` (`codex` or `copilot`) and
`WORKER_CLI_EXECUTABLE_PATH`. `WORKER_CLI_HOME`, `WORKER_CLI_MODEL` and an optional executable hash pin
can be supplied by deployment. CLI version is detected with a bounded `--version` process and
reported in `cliEngine`/`cliVersion`; a model-disabled Worker reports both as null. No provider URL,
API key, relay policy hash or manually supplied CLI version is required by this project.

## Execution

Ordinary model reviews and Evaluation use the same CLI runner. It accepts the prepared workspace,
task prompt, authoritative output schema, cancellation signal and resource limits. CLI adapters
only translate those inputs into documented noninteractive arguments and collect the final result.
They do not implement model authentication or an alternative model transport.

Codex uses stdin plus its native schema/result-file options. Copilot reads stdin and emits bounded
JSONL events. The runner selects the last complete main-agent assistant message before the CLI's
single successful terminal result, then validates that message against the output schema. Progress,
reasoning, tool output and subagent messages cannot become the final answer. New main-agent turns
or cancellation invalidate an earlier answer until a new complete message arrives.
The terminal marker freezes that answer. Later informational events cannot replace it; duplicate
terminal markers or a new main-agent response, turn or cancellation remain invalid.
Parser failures log a bounded reason, event index and known event type without event bodies.
The adapter supplies JSON-format/schema instructions. These mechanical formatting instructions
are adapter behavior, not a second application prompt or a claim about raw provider request bytes.
No provider or tool traffic is intercepted.

Both adapters require process completion, stream draining, bounded output and schema-valid model
JSON. Failures stay failures; partial JSON or a zero exit without valid output cannot become a
completed review. Existing worktree observations remain separate from model content. An adapter
that cannot enumerate CLI tool commands reports that limitation instead of manufacturing complete
command evidence. Summary checks and result validation retain their business meaning without
claiming OS-level read-only confinement.

## Result records

Completed `ValidationJobResultV2.modelReview` contains the original `result`, `executionEvidence`
and an `execution` record. `CliModelExecutionV1` carries:

- The owning `jobId` and `runAttemptId`.
- `cli`: `kind`, detected `version`, and nullable `requestedModel`.
- The task `promptSha256`, authoritative `outputSchemaSha256`, canonical `outputSha256` and exit 0.
- An optional `summaryInputRef` for the existing frozen summary-input workflow.

The common runner's task prompt is the application input boundary. For summaries it is the frozen
composed prompt, including runner/evidence context. CLI-specific JSON instructions can surround
that input. Output hashes describe data consistency; the record is supplied by the authenticated
Worker and does not attest a model service or independently prove every internal CLI operation.

Server receives model results through ordinary task completion. It checks the current lease,
attempt, frozen source/Profile/Prompt, output schema and canonical output digest. Summary-input
freezing retains ordinary authenticated task ownership; it has no dependency on invocation-opening,
sealing, receipt-ledger or provider-registry APIs. There is no separate model-call persistence flow.

## Evaluation and UI

Model requirements contain only `required`. Evaluation does not require a pre-registered provider
identity or model runtime. CLI configuration is recorded with completed results and displayed in
the existing result details. A null requested model means `CLI default`; it is not an independently
observed underlying provider model name.

Each valid result can contribute its own model-quality score. Different CLI selections do not
invalidate otherwise valid results. Users can inspect CLI/version/model metadata when comparing
Prompt/Profile results, and should account for those differences when interpreting a comparison.
The Dashboard has no provider-registration page, runtime selector or HTTP invocation-ledger drawer.

## Removed scope and verification

Provider profile parsing, request/response relay and observation chains, app-server-specific model
composition, runtime registration and invocation opening/sealing/submission are removed rather
than retained as dormant compatibility paths. The product is unreleased: maintain the current
schema and initialization definitions directly, without old-data conversion or upgrade projects.
Historical artifacts are retained as history and do not define current requirements.

Verification covers shared contracts, both CLI adapters, Worker execution and cleanup, Server
completion/scoring, Dashboard rendering and deployment scripts. Controlled CLI fixtures distinguish
process/protocol integration from real model-quality testing. Existing repository rules still
require explicit scoped authorization for actual PR/Issue writes; a CLI login does not grant that
authorization to automated tests.
