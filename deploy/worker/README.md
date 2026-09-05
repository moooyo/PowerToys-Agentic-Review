# Windows Worker Deployment

The pre-release Worker is deployed manually to one trusted Windows machine. The repository does not
ship a Worker package, installer, native service wrapper, upgrade protocol, or release-signature
flow.

## Required payload

Install the following trusted, pinned files:

- Node.js 24.20.x;
- PowerShell 7 or newer (`pwsh`) for the Windows E2E evidence collector;
- Git for Windows;
- Codex CLI, pinned to the deployment version (current native compatibility checks use 0.145.0);
- `apps/worker/dist/worker.mjs` and its source map/metadata;
- `native/process-host/AgenticReview.ProcessHost.exe`; and
- the fixed Worker authentication profile described in `apps/worker/README.md`.

Create that profile from an elevated PowerShell session with
`deploy/worker/provision-worker-auth.ps1`. The script masks Token input and applies the private file
and directory ACLs required by ADR 0025.

Configure absolute executable paths, expected versions, and SHA-256 digests through the Worker
environment. Store mutable data, shared repositories, attempt workspaces, temporary files, and the
Codex profile in separate configured directories.

`WORKER_EXECUTION_PROFILE_DIRECTORY` is the dedicated persistent `CODEX_HOME`. Provision its
`config.toml` and supported authentication under the Worker Windows identity. Use file/keyring
authentication or supported provider `auth.command`/`auth.args`. Ambient API keys are not forwarded;
provider `env_key` and directly supplied `env_http_headers` are rejected. Configuration is loaded at
Worker startup, so changes require a restart. The config file must be a regular UTF-8 file no larger
than 64 KiB.

The Worker checks canonical directory identities and separation from workspaces, temporary roots,
shared Git, and binaries before orphan cleanup. It does not overwrite the profile or copy its
authentication cache into a task.

Use `deploy/worker/worker-config.template.psd1` as the deployment baseline. It includes every
supported `WORKER_*` runtime environment variable consumed by `loadWorkerConfig()` and
`loadExecutionConfig()`, plus Worker-side shared Git cache and conservative GC controls. Process
environment values such as `NODE_ENV` remain owned by the service manager.

## Launch

Build the TypeScript Worker and Windows ProcessHost from a trusted release checkout. Copy the
resulting files to the Worker machine, create the authentication profile, copy the config template
to `worker-config.psd1`, fill in pinned paths and digests, and launch:

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
error. Do not configure the removed `WORKER_RECIPE_IDS` setting; Codex executes repository commands.

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
PR, Codex validation, inline completion, lease cancellation handling, ProcessHost cleanup,
workspace cleanup, and shared-Git policy configuration. The script collects evidence only; it does
not execute an automated E2E run or declare acceptance. Its timestamped observations must be
correlated with actual job and run-attempt identities, active worktrees and descendants, retained
build/test output, and the Server's accepted result records. Use distinct output paths for each
baseline, active, completed, and cancelled capture.

The exercise requires an explicitly authorized Windows verification host, configured Worker and
Codex authentication, a reachable Server with operator/read-only evidence access, and permission
to change assignment or user review requests on the selected public PR. The configured GitHub
reviewer or an allowlisted actor opens work through those GitHub actions. Removing the final active
assignment/review request triggers lease cancellation after ingestion; the Dashboard has no job
creation, cancellation, or requeue action. The runbook explains how to open a fresh authorization
epoch for the second attempt and prove shared-cache reuse.

PR preparation fetches the immutable `baseSha` and PR head with full history. It supports arbitrary
base branches, with no `main` assumption or fallback. The current user-authorized local exercise
uses a PR targeting `dev`; its real E2E result is still in progress and is not established here.

Codex uses the persistent home and fresh per-attempt `USERPROFILE`, temporary, and control
directories. The loader passes only allowed model/provider/auth settings before fixed execution
overrides. `--ignore-user-config` and project trust `untrusted` suppress other user/project config;
the repository remains a trusted execution input and `AGENTS.md` remains available. MCP, plugins,
hooks, notifications, and inherited extra write roots are disabled. Approval is supplied as
`--config approval_policy="never"`, compatible with the pinned 0.145.0 CLI.

Provider HTTP headers are transformed into `CODEX_PROVIDER_HEADER_<n>` variables for native Codex
only. The build/test shell environment contains exactly `COMSPEC`, `PATH`, `PATHEXT`, `SYSTEMROOT`,
`TEMP`, `TMP`, and `USERPROFILE`, excluding authentication paths and credentials. Establish login
readiness for the dedicated profile; a default-profile login is not proof. Arrange actual
build/test and process-lifecycle evidence capture before disposable workspaces are removed, and do
not capture process environments or authentication contents.

Missing deployment inputs or evidence keep release acceptance blocked. Linux `test-env` checks
and CI results do not replace the operator-driven Windows exercise. See the
[Windows E2E runbook](./worker-e2e-runbook.md) for the required evidence and decision criteria.
Local verification was explicitly authorized for the current exercise; the default verification
policy for other tasks remains `test-env` unless separately authorized.

## Distribution and signing

"Distribution" means automatically delivering a Worker release bundle to one or more machines.
That capability is not part of the MVP. Manual deployment from a trusted checkout does not require
an Ed25519 package signature. If automatic distribution is added later, its manifest, signature,
upgrade, rollback, and recovery contracts must be designed as a separate feature.
