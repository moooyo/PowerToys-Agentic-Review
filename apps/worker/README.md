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

Git fetch and worktree metadata operations are serialized per repository. Different repositories
can prepare concurrently, and prepared worktrees can execute concurrently. Task cleanup removes
the registered worktree and then removes the complete attempt directory. The next preparation also
prunes stale worktree metadata left by an interrupted process.

The shared object store is not recreated for every attempt, so repeated reviews download only
missing Git objects. Do not run Git garbage collection while attempts for that repository are
active.

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
$env:WORKER_SERVER_URL = 'http://127.0.0.1:3000'
$env:WORKER_ALLOW_INSECURE_HTTP = 'true'
$env:WORKER_EXECUTION_ENABLED = 'true'
$env:WORKER_DATA_DIR = 'D:\AgenticReview\Data'
$env:WORKER_GIT_SHARED_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Repositories'
$env:WORKER_WORKSPACE_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Workspaces'
$env:WORKER_EXECUTION_TEMP_DIRECTORY = 'D:\AgenticReview\Data\Temp'
$env:WORKER_EXECUTION_PROFILE_DIRECTORY = 'D:\AgenticReview\Data\Profile'
# Configure the trusted executable paths, versions, digests, and resource limits here.
node --enable-source-maps .\dist\worker.mjs
```

Production Server connections use HTTPS. Package signing is a deployment concern only when Worker
bundles are distributed automatically; it is not required for a manual trusted deployment.
