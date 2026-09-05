# Windows Worker Deployment

The pre-release Worker is deployed manually to one trusted Windows machine. The repository does not
ship a Worker package, installer, native service wrapper, upgrade protocol, or release-signature
flow.

## Required payload

Install the following trusted, pinned files:

- Node.js 24.20.x;
- PowerShell 7 or newer (`pwsh`) for the Windows E2E evidence collector;
- Git for Windows;
- Codex CLI;
- `apps/worker/dist/worker.mjs` and its source map/metadata;
- `native/process-host/AgenticReview.ProcessHost.exe`; and
- the fixed Worker authentication profile described in `apps/worker/README.md`.

Create that profile from an elevated PowerShell session with
`deploy/worker/provision-worker-auth.ps1`. The script masks Token input and applies the private file
and directory ACLs required by ADR 0025.

Configure absolute executable paths, expected versions, and SHA-256 digests through the Worker
environment. Store mutable data, shared repositories, attempt workspaces, temporary files, and the
Codex profile in separate configured directories.

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
instance is not already running as a convenience preflight. The hard execution-mode guarantee is
the Windows global named mutex held by ProcessHost for the resolved Worker data root.

Use an external Windows service manager or scheduled-task policy if automatic restart is required.
It must preserve graceful process shutdown. The current repository does not prescribe a specific
service manager and still does not provide an auto-distribution installer.

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
- Manual repository-wide GC procedures are not part of this trusted deployment flow.

For release acceptance, use `deploy/worker/worker-e2e-runbook.md` and
`deploy/worker/invoke-worker-e2e.ps1` to collect evidence for registration, a real `public/main`
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

Codex uses a fresh per-attempt `CODEX_HOME` and `USERPROFILE`, a replacement environment without an
API key, and `cli_auth_credentials_store = "keyring"`. The Worker does not import `auth.json` from
`WORKER_EXECUTION_PROFILE_DIRECTORY`. Establish authentication for the pinned CLI under that exact
Windows account and environment before claiming real execution; default-profile login alone is
not proof. The Worker also does not persist Codex command output, so arrange actual build/test and
process-lifecycle evidence capture before the disposable workspace is removed.

Missing deployment inputs or evidence keep release acceptance blocked. Linux `test-env` checks
and CI results do not replace the operator-driven Windows exercise. See the
[Windows E2E runbook](./worker-e2e-runbook.md) for the required evidence and decision criteria.

## Distribution and signing

"Distribution" means automatically delivering a Worker release bundle to one or more machines.
That capability is not part of the MVP. Manual deployment from a trusted checkout does not require
an Ed25519 package signature. If automatic distribution is added later, its manifest, signature,
upgrade, rollback, and recovery contracts must be designed as a separate feature.
