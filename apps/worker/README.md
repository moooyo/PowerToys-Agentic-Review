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
`WORKER_GIT_SHARED_ROOT_DIRECTORY`. Before a pull request job starts, the Worker fetches the current
`main` ref and the GitHub pull request head ref into that shared object store, verifies the
envelope's base and head SHAs, and requires a valid merge base. It then creates a detached worktree
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
`worker-config.template.psd1`. Manual repository-wide GC procedures are out of scope for this
deployment profile.

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

For manual acceptance on Windows, follow `deploy/worker/worker-e2e-runbook.md` and capture evidence
with `deploy/worker/invoke-worker-e2e.ps1`. That script is an evidence collector and does not run
an automated end-to-end workflow.

Production Server connections use HTTPS. Package signing is a deployment concern only when Worker
bundles are distributed automatically; it is not required for a manual trusted deployment.
