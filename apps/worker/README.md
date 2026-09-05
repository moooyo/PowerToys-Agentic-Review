# Agentic Review Windows Worker

The Worker is one headless, outbound-only Windows process that can be managed as a service. It
registers with the Server, claims
fenced leases, prepares an isolated Git worktree, runs Codex and approved validation commands, and
submits one inline structured result.

The admitted repositories and revisions are trusted execution inputs. Process and disk limits are
retained as reliability controls rather than hostile-code containment. The Worker receives no
GitHub publication credential and never opens the Server database.

## Runtime

The production entry point is `src/main.ts`, bundled as `dist/worker.mjs`. When execution is
enabled it composes:

- `WorkerService` for registration, claims, heartbeats, lease fencing, drain, and terminal replay;
- `ReviewJobExecutor` for Codex review and validation jobs;
- `StdioProcessHostClient` and the native ProcessHost for Job Object process-tree supervision;
- the ProcessHost global named mutex for one execution Worker per resolved data root;
- `ProductionWorkspaceDiskBudget` for bounded attempt storage and orphan cleanup; and
- `ProductionDisposableJobWorkspaceProvider` for shared repositories and per-attempt worktrees.

The historical Control and Executor role bundles are not production entry points. ADR 0029
replaces their credential-isolation threat model with one trusted-code Worker process.

## Shared repositories and worktrees

Each configured public GitHub repository has one persistent bare repository beneath
`WORKER_GIT_SHARED_ROOT_DIRECTORY`. Before a pull request job starts, the Worker fetches the immutable
envelope `baseSha` and the GitHub pull request head ref with full history, verifies both commit SHAs,
and requires a valid merge base. It supports arbitrary base refs, including `dev`, with no `main`
assumption or fallback. It then creates a detached worktree
for the exact head SHA beneath `WORKER_WORKSPACE_ROOT_DIRECTORY`.

The current Git environment disables credential helpers and uses an anonymous GitHub HTTPS URL, so
private repositories are not supported by this MVP.

Git fetch, worktree metadata mutation, and whole-cache accounting use a cancellable global
shared-cache lock plus per-repository ordering. This prevents another repository's fetch from
changing the cache during a bounded whole-root scan. Prepared worktrees can still execute
concurrently. Task cleanup removes the registered worktree and then removes the complete attempt
directory. The next preparation also prunes stale worktree metadata left by an interrupted process.

The shared object store is not recreated for every attempt, so repeated reviews download only
missing Git objects. Shared repository cleanup and conservative Git garbage collection are
performed by the Worker runtime using the shared-Git policy variables in
`worker-config.template.psd1`. Fetch uses `--no-auto-maintenance` to preserve Worker ownership of
maintenance timing. Manual repository-wide GC procedures are out of scope for this
deployment profile.

Workspace admission, monitoring, and cleanup use bounded disk operations.
`WORKER_EXECUTION_DISK_SCAN_TIMEOUT_MS` defaults to `30000` and accepts `100..300000` milliseconds;
each operation's deadline includes time waiting for the accounting lock and is shared by all
snapshot retries. `WORKER_EXECUTION_DISK_SCAN_ENTRY_LIMIT` defaults to `100000` and accepts
`1..1000000` entries per accounting scan. Larger pnpm trees may need higher limits based on host I/O
performance. Raising them permits longer scans and delays disk-budget failure detection; per-attempt
and total quotas, reserved headroom, and the free-space floor remain enforced. Shared Git accounting
continues to use its separate `WORKER_GIT_SHARED_SCAN_*` settings.

Attempt disk scans cover preparation and active review commands. Fixed Git cleanup and maintenance
commands use cleanup path guards and managed process limits without scanning the attempt being
dismantled: removing a checkout can temporarily leave pnpm store links dangling. Shared-cache
accounting remains enforced, and final attempt deletion does not follow links into their targets.
The Worker passes `core.longpaths=true` to every Git command so Git for Windows can remove deeply
nested dependency paths without relying on the execution account's global configuration.

If Git cannot remove a checkout, only a completed nonzero exit permits recovery: the active disk
reservation removes its fixed `checkout` child, preserves the other attempt directories, and
confirms deletion before Git prunes and lists registrations. Recovery succeeds only after the
checkout registration is absent and shared-cache checks pass; its warning retains bounded,
redacted Git stderr. The default trusted deployment uses the disk-budget layer's Node deletion
backend. An explicitly supplied native security adapter must implement checkout quarantine with
its handle-bound guarantees; missing support fails closed instead of falling back to Node.

## Worker authentication

Every Worker API request uses the node-specific Token loaded from:

```text
C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json
```

The file contains exactly one compact JSON object:

```json
{"profileId":"agentic-review-worker-auth-v1","token":"arw1_<43-base64url-characters>","workerNodeId":"<entity-id>"}
```

The parent Worker process owns this Token. Git, Codex, ProcessHost children, repository commands,
and validation commands receive replacement environments that do not contain it.

## Codex profile and execution configuration

`WORKER_EXECUTION_PROFILE_DIRECTORY` is a dedicated persistent `CODEX_HOME`, separate from all task
workspaces, temporary roots, shared Git state, and trusted binaries. Before starting ProcessHost or
sweeping orphan workspaces, the Worker checks directory identities with `lstat` and `realpath`,
rejecting links, aliases, overlap, and observed changes. Per-attempt `USERPROFILE`, temporary files,
and control files remain disposable.

Provision `config.toml` and supported authentication under the actual Worker Windows identity in
that home. File/keyring authentication and supported provider authentication commands are allowed.
The Worker does not overwrite the profile or copy its authentication files into a task. A login in
another default Codex profile is not sufficient. Native compatibility checks currently pin Codex
0.145.0.

The loader selects only allowed model/provider/auth settings. `--ignore-user-config` and fixed CLI
overrides suppress other user configuration, MCP, plugins, hooks, notifications, and inherited
extra writable roots. Project trust is `untrusted` to suppress repository config; admitted code
remains trusted, and `AGENTS.md` is still loaded. Approval uses `--config approval_policy="never"`.

Selected provider HTTP headers become `CODEX_PROVIDER_HEADER_<n>` variables passed only to native
Codex, never credential values in argv. Build/test shells receive exactly `COMSPEC`, `PATH`,
`PATHEXT`, `SYSTEMROOT`, `TEMP`, `TMP`, and `USERPROFILE`; their environment contains neither the
Codex home nor provider, Worker, or GitHub credentials. Extra write access is limited to the current
task temporary directory.

## Development launch

From an elevated PowerShell session at the repository root, provision the authentication profile.
The Token prompt is masked, and the script removes inherited ACLs before granting access only to the
Worker identity, `SYSTEM`, and local administrators:

```powershell
.\deploy\worker\provision-worker-auth.ps1 `
  -WorkerNodeId 'worker:<uuid>' `
  -WorkerIdentity "$env:USERDOMAIN\$env:USERNAME"
```

Then configure the execution tools and launch the Worker:

```powershell
Copy-Item .\deploy\worker\worker-config.template.psd1 .\deploy\worker\worker-config.psd1
# Fill in pinned executable paths, SHA-256 digests, and URL-specific values.
.\deploy\worker\start-worker.ps1 -ConfigPath .\deploy\worker\worker-config.psd1
```

`worker-config.template.psd1` includes all supported `WORKER_*` environment values for
`loadWorkerConfig()` and `loadExecutionConfig()`, including the Worker-side execution budgets and
Worker-side shared Git cache and conservative GC controls. Process-level values such as `NODE_ENV`
remain service-manager configuration.

The launch script resolves Node.js and normalizes `PATH`. Do not add `WORKER_RECIPE_IDS`; Codex runs
repository build/test commands directly. If initialization fails after ProcessHost starts, the
Worker waits for ProcessHost closure before reporting the original error.

For manual acceptance on Windows, follow `deploy/worker/worker-e2e-runbook.md` and capture evidence
with `deploy/worker/invoke-worker-e2e.ps1`. That script is an evidence collector and does not run
an automated end-to-end workflow.
The current local Windows exercise is explicitly authorized and uses an approved PR targeting
`dev`; real E2E acceptance is still in progress. Other local verification continues to require
task-specific authorization.

Production Server connections use HTTPS. Package signing is a deployment concern only when Worker
bundles are distributed automatically; it is not required for a manual trusted deployment.
