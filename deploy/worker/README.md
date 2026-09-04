# Windows Worker Deployment

The pre-release Worker is deployed manually to one trusted Windows machine. The repository does not
ship a Worker package, installer, native service wrapper, upgrade protocol, or release-signature
flow.

## Required payload

Install the following trusted, pinned files:

- Node.js 24.20.x;
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
not execute an automated E2E run.

## Distribution and signing

"Distribution" means automatically delivering a Worker release bundle to one or more machines.
That capability is not part of the MVP. Manual deployment from a trusted checkout does not require
an Ed25519 package signature. If automatic distribution is added later, its manifest, signature,
upgrade, rollback, and recovery contracts must be designed as a separate feature.
