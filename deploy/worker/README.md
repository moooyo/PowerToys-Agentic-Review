# Windows Worker Deployment

The pre-release Worker is deployed manually to one trusted Windows machine. The repository does not
ship a Worker package, installer, native service wrapper, upgrade protocol, or release-signature
flow.

## Required payload

Install the following trusted files:

- Node.js 24.20.x;
- PowerShell 7 or newer (`pwsh`) for the Windows E2E evidence collector;
- Git for Windows;
- Codex CLI or GitHub Copilot CLI when model execution is enabled;
- `apps/worker/dist/worker.mjs` and its source map/metadata;
- `native/process-host/AgenticReview.ProcessHost.exe`; and
- the fixed Worker authentication profile described in `apps/worker/README.md`.

Create that profile from an elevated PowerShell session with
`deploy/worker/provision-worker-auth.ps1`. The script masks Token input and applies the private file
and directory ACLs required by ADR 0025.

Configure absolute executable paths and the ProcessHost/Git integrity settings through the Worker
environment. Model execution needs `WORKER_CLI_ENGINE=codex` or `copilot` and
`WORKER_CLI_EXECUTABLE_PATH`. The optional `WORKER_CLI_HOME` selects the persistent CLI home;
`WORKER_CLI_MODEL` selects a model through the CLI. Startup detects the installed CLI version using
a bounded `--version` call through ProcessHost, with a 20-second and 64-KiB limit, retaining the
first stdout line. A hand-maintained CLI version is not accepted. `WORKER_CLI_SHA256` is an optional
binary pin. The CLI path may be outside `WORKER_TRUSTED_EXECUTABLE_ROOT`; Windows WinGet application
links resolve to the installed target. ProcessHost and Git retain their trusted-root and SHA rules.

`WORKER_MODEL_EXECUTION_ENABLED` defaults to `true`. Set it to `false` and omit CLI configuration
when deploying deterministic validation without model execution. Required-model tasks remain
unavailable to that Worker; optional summary execution must stay disabled.

Run the selected CLI's own login flow under the actual Worker Windows identity, with the same home
if one is configured. The CLI owns authentication, provider selection, configuration and HTTP
traffic. The Worker does not read, copy or rewrite auth/provider files. Login in another account
or home is not evidence that the Worker can run model tasks. Keep persistent CLI state separate
from shared repositories, disposable workspaces and temporary directories.

There is no global provider registry, HTTP relay/call ledger or provider metadata policy to
configure. The project records selected CLI configuration, exit status and structured output.
Worker capabilities contain nullable `cliEngine` and `cliVersion`; neither is a claim about the
identity of a remote provider's model. See the
[CLI-owned execution design](../../docs/design/2026-09-10-cli-owned-model-execution.md).

Use `deploy/worker/worker-config.template.psd1` as the deployment baseline. It includes every
supported `WORKER_*` runtime environment variable consumed by `loadWorkerConfig()`,
`loadExecutionConfig()`, and `loadValidationRuntimeConfig()`, plus Worker-side shared Git cache and
conservative GC controls. Process environment values such as `NODE_ENV` remain owned by the service manager.

## Profile validation runtime

Headless profile validation defaults to enabled when execution is enabled. Disable it explicitly with
`WORKER_VALIDATION_HEADLESS_ENABLED=false` if this deployment does not provide that runner.
`WORKER_VALIDATION_CLEANUP_TIMEOUT_MS` defaults to `30000` and accepts `1000..300000` milliseconds.
This independent budget includes final source observation and cleanup. Large dependency trees
may require an explicit increase to finish fresh filesystem verification; all path and disk
checks still apply, and a timeout keeps the source state unknown.
Validation runner settings cannot enable execution when `WORKER_EXECUTION_ENABLED` is false.

Optional UI and Issue validation advice is enabled with `WORKER_VALIDATION_SUMMARY_ENABLED=true`.
It defaults to disabled. The published workflow prompt is frozen in either mode; a disabled summary
is displayed as not requested. `WORKER_VALIDATION_SUMMARY_TIMEOUT_MS` defaults to `60000` and accepts
`10000..300000` milliseconds. The remaining job and no-progress budgets may allow less time or skip
the summary. Advice uses a separate read-only model workspace and the already observed structured
checks/evidence; it cannot replace runner outcomes or imply that the model inspected screenshots.
Ordinary summary failures remain visible without retrying successful deterministic checks.

Summary execution uses the selected CLI, and production model acceptance is pending. Keep the
opt-in disabled for the baseline deployment. The historical M24 model probe denied controlled file
writes but connected to its owned loopback listener. The Worker does not claim network isolation;
the intended VM deployment owns that boundary. See the
[summary execution contract](../../docs/design/2026-09-07-optional-validation-summary.md) and
[production acceptance ledger](../../docs/design/2026-09-07-production-validation-acceptance.md)
for the independent runner/model conclusions and remaining scope.

Web validation requires `WORKER_VALIDATION_WEB_ENABLED=true` and an installed browser at the exact
absolute `.exe` path in `WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH`. Deploy `web-driver.mjs`
and the build-produced `node_modules/playwright-core` directory next to `worker.mjs`; do not replace
that private runtime with a dependency link into an unrelated checkout. Preparation checks the
driver, browser, and packaged runtime files. It never downloads a browser or searches `PATH`.
Web validation also requires the bundled `windows-driver-entry.ps1` and the trusted Windows
PowerShell executable for TCP listener ownership checks, even when desktop UI validation is disabled.

Windows validation requires `WORKER_VALIDATION_WINDOWS_ENABLED=true`, `WORKER_MAX_SLOTS=1`,
the deployed `windows-driver-entry.ps1` beside `worker.mjs`, and an explicit
`WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY`. Provision one canonical, private lock directory shared
by every Worker node and server using the same Windows account and desktop session. Grant that
account the access needed to create and retain lease/quarantine records. Do not use per-node or
per-workspace lock directories. The interactive-session readiness probe is separate from file
preparation; enabling a setting alone is not evidence that a desktop is usable.

Startup supplies the trusted `git`, `node`, `powershell`, and `cmd` aliases. Additional installed
tools use `WORKER_VALIDATION_COMMANDS_JSON`, a bounded array of `{name,path,sha256?}` entries:

```powershell
@{
    WORKER_VALIDATION_COMMANDS_JSON = '[{"name":"dotnet","path":"C:\\Program Files\\dotnet\\dotnet.exe"}]'
    WORKER_VALIDATION_SECRET_FILES_JSON = '{"test-access-token":"D:\\AgenticReview\\Secrets\\test-token.txt"}'
}
```

Aliases are case-insensitive, unique, and cannot replace the supplied system tools. Optional SHA-256
pins must match the installed file. Profile executable fields accept registered aliases or explicit
`./build/app.exe` paths into the current checkout. Bare filenames, arbitrary absolute paths, other
relative paths, links, and redirected checkout ancestors are rejected. The executable resolver
never allows a repository's same-named binary to replace a registered tool.

Secret mappings contain only operator-provisioned absolute file paths. Keep secret bytes out of
configuration JSON, prompts, command arguments, and diagnostics. Protect the files and their parent
directories with Windows ACLs, outside workspaces, temporary roots, and shared Git state. Trusted
tool and driver directories must also be protected against replacement by executed repository
code. The runtime verifies file identities and rejects links, but does not infer Windows ACL
protection from Unix mode bits. System executables may use normal Windows servicing hard links;
custom tools, generated executables, and secret files must have one link.

Secret reads use a bounded stable handle and strict UTF-8: at most 64 KiB and 32767 characters,
non-empty, without BOM or NUL. Content is exact, including any trailing newline. Unknown references,
file changes, and invalid content fail without logging bytes. Driver and browser paths are deployment
inputs; capability labels are generated only after runtime preparation and applicable readiness
checks succeed.

## Launch

Build the TypeScript Worker and Windows ProcessHost from a trusted release checkout. Copy the
resulting files to the Worker machine, create the authentication profile, copy the config template
to `worker-config.psd1`, fill in runtime paths, CLI selection and ProcessHost/Git integrity settings,
complete CLI login under the Worker account, and launch:

```powershell
.\deploy\worker\start-worker.ps1 -ConfigPath .\deploy\worker\worker-config.psd1
```

`start-worker.ps1` enforces a fixed authentication-profile path, verifies required settings for the
selected mode, refuses to print environment values, and checks that a duplicate `worker.mjs`
instance is not already running as a convenience preflight. It resolves Node.js to an absolute
executable path, puts that directory first in `PATH`, and removes empty and duplicate PATH entries.
The runtime still rejects unsafe path entries. The hard execution-mode guarantee is
the Windows global named mutex held by ProcessHost for the resolved Worker data root.
Initialization failures after ProcessHost creation await its closure before reporting the original
error. Do not configure the removed `WORKER_RECIPE_IDS` setting; the CLI executes repository commands.

Model process limits use `WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS` (default `3600000`),
`WORKER_MODEL_MAX_PROCESSES` (default `32`), `WORKER_MODEL_MAX_MEMORY_BYTES` (default `8589934592`)
and `WORKER_MODEL_MAX_OUTPUT_BYTES` (default `8388608`). The existing Git, aggregate process and
workspace budgets remain separate.

Use an external Windows service manager or scheduled-task policy if automatic restart is required.
It must preserve graceful process shutdown. The current repository does not prescribe a specific
service manager and still does not provide an auto-distribution installer.

Workspace admission, monitoring, and cleanup use bounded disk operations. Configure
`WORKER_EXECUTION_DISK_SCAN_TIMEOUT_MS` (default `30000`, allowed `100..300000` milliseconds) and
`WORKER_EXECUTION_DISK_SCAN_ENTRY_LIMIT` (default `100000`, allowed `1..1000000` accounting entries)
in `worker-config.psd1`. The timeout includes waiting for the accounting lock, and all snapshot
retries share the same operation deadline. For a large pnpm tree, tune these bounds to measured
host I/O performance; `120000` milliseconds and `500000` entries are an example override, not the
defaults. Higher bounds allow longer scans and delay disk-budget failure detection. Per-attempt
and total quotas, reserved headroom, and minimum free space remain enforced. Shared Git accounting
retains the separate settings below.

## Shared Git capacity and conservative automatic maintenance

Shared bare repositories are intentionally persistent for fetch reuse. Capacity and maintenance are
Worker-managed:

- Configure `WORKER_GIT_SHARED_CACHE_MAX_BYTES`,
  `WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES`,
  `WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT`,
  `WORKER_GIT_SHARED_SCAN_TIMEOUT_MS`,
  `WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES`, and
  `WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS` in `worker-config.psd1`.
- The Worker runtime applies conservative repository scanning and GC according to those values.
- Fetch uses `--no-auto-maintenance`; only Worker-controlled maintenance applies these GC policies.
- Manual repository-wide GC procedures are not part of this trusted deployment flow.

For release acceptance, use `deploy/worker/worker-e2e-runbook.md` and
`deploy/worker/invoke-worker-e2e.ps1` to collect evidence for registration, a real approved public
PR, CLI-backed validation, inline completion, lease cancellation handling, ProcessHost cleanup,
workspace cleanup, and shared-Git policy configuration. The script collects evidence only; it does
not execute an automated E2E run or declare acceptance. Its timestamped observations must be
correlated with actual job and run-attempt identities, active worktrees and descendants, retained
build/test output, and the Server's accepted result records. Use distinct output paths for each
baseline, active, completed, and cancelled capture.

The exercise requires an explicitly authorized Windows verification host, configured Worker and
CLI login, a reachable Server with operator/read-only evidence access, and permission
to change assignment or user review requests on the selected public PR. The configured GitHub
reviewer or an allowlisted actor opens work through those GitHub actions. Removing the final active
assignment/review request triggers lease cancellation after ingestion; the Dashboard has no job
creation, cancellation, or requeue action. The runbook explains how to open a fresh authorization
epoch for the second attempt and prove shared-cache reuse.

PR preparation fetches the immutable `baseSha` and PR head with full history. It supports arbitrary
base branches, with no `main` assumption or fallback. The authorized Windows exercise on a PR
targeting `dev` passed runtime acceptance. Its tested configuration, evidence, and environment
closeout are recorded in the
[live validation handoff](../../docs/handoff/2026-09-05-windows-e2e-live-validation.md).

CLI authentication remains in CLI-owned storage and is not copied into disposable tasks. The
Worker supplies task inputs, collects bounded structured output and supervises the CLI process;
it does not capture provider requests or read authentication contents. Arrange actual build/test
and process-lifecycle evidence before disposable workspaces are removed. Record selected engine,
observed CLI version, configured model, process exit and output validation, without capturing
process environments, login storage or provider credentials.

Missing deployment inputs or evidence keep release acceptance blocked. Linux `test-env` checks
and CI results do not replace the operator-driven Windows exercise. See the
[Windows E2E runbook](./worker-e2e-runbook.md) for the required evidence and decision criteria.
Historical local verification authorization does not authorize a new exercise. The default
verification policy remains `test-env` unless local verification is explicitly authorized.

## Distribution and signing

"Distribution" means automatically delivering a Worker release bundle to one or more machines.
That capability is not part of the MVP. Manual deployment from a trusted checkout does not require
an Ed25519 package signature. If automatic distribution is added later, its manifest, signature,
upgrade, rollback, and recovery contracts must be designed as a separate feature.
