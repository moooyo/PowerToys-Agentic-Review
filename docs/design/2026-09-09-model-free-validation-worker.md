# Model-free validation Worker

The active execution contract is
[CLI-owned model execution](./2026-09-10-cli-owned-model-execution.md). One VM runs one long-lived
Worker with the existing ProcessHost, Job lease, workspace and validation lifecycle.

## Configuration and startup

`WORKER_MODEL_EXECUTION_ENABLED` defaults to `true`. Set it to `false` and omit model CLI
settings to run deterministic validation without Codex CLI or GitHub Copilot CLI. ProcessHost,
Git, trusted infrastructure binaries, workspaces and validation target settings remain required
when execution is enabled. Optional model summaries must stay disabled in model-free mode.

The disabled path does not prepare a model CLI, run its version probe or create a model executor.
It does not read CLI login/provider files. The active model-enabled path requires only
`WORKER_CLI_ENGINE` (`codex` or `copilot`) and `WORKER_CLI_EXECUTABLE_PATH`;
`WORKER_CLI_HOME`, `WORKER_CLI_MODEL` and `WORKER_CLI_SHA256` are optional. The CLI owns its
login, configuration and HTTP requests. There is no provider registry or relay to configure.

Resource settings use `WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS`, `WORKER_MODEL_MAX_PROCESSES`,
`WORKER_MODEL_MAX_MEMORY_BYTES` and `WORKER_MODEL_MAX_OUTPUT_BYTES`. Git, total process,
workspace, headless, Web and Windows UI budgets retain their separate settings.

## Capabilities and scheduling

Worker capabilities expose nullable `cliEngine` and `cliVersion`. Both are null for a
model-free Worker; no placeholder version is advertised. Runtime-derived capability labels
cannot be replaced by deployment labels. Model-enabled startup detects the actual installed
CLI version through a bounded `--version` call.

The shared model-requirement classifier keeps a model-free Worker from claiming required-model
work. Ordinary PR static review, Issue triage and required-model evaluations need an available
CLI. Profile-only evaluation and eligible deterministic UI/Issue validation do not. Disabling
model execution cannot silently turn a required model step into an optional one.

The Worker independently rejects required-model input before model preparation. Full envelope,
source, authorization, lease and target-readiness checks remain separate. A browser or desktop
setting does not make an unavailable target ready.

## Acceptance boundary

Verify the model-free configuration without CLI installation or login files, null CLI
capabilities, mixed-fleet scheduling and early required-model rejection. Separately verify real
target execution, cancellation, evidence delivery and cleanup on the intended VM.

Historical model-free acceptance reports remain in the artifact ledger and apply to their
recorded source only. They do not prove the new direct CLI path, remote model identity or VM
isolation. Verification uses `test-env` unless local verification is explicitly authorized;
real repository PR/Issue writes always require explicit approval of their exact scope.
