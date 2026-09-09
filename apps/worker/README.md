# Agentic Review Windows Worker

The Worker is one outbound-only Windows process. It registers with the Server, claims fenced
leases, prepares isolated Git worktrees, and executes configured validation profiles and reviews
through Codex CLI or GitHub Copilot CLI. It submits a structured result and uploads bounded, scoped
evidence assets when required.
Headless deployments can run as a service. Windows desktop UI validation requires a dedicated
active, unlocked interactive session and an exclusive session lease.

The admitted repositories and revisions are trusted execution inputs. Process and disk limits are
retained as reliability controls rather than hostile-code containment. The Worker receives no
GitHub publication credential and never opens the Server database.

## Runtime

The production entry point is `src/main.ts`, bundled as `dist/worker.mjs`. When execution is
enabled it composes:

- `WorkerService` for registration, claims, heartbeats, lease fencing, drain, and terminal replay;
- `ProfileJobExecutor` for frozen profile jobs, with `ReviewJobExecutor` retaining legacy and
  isolated model review execution;
- `HeadlessValidationCheckRunner` and `UiProfileRunner` for typed checks and Windows/Web scenarios;
- `EvidenceUploader` for finalized screenshots, steps, and browser traces;
- `StdioProcessHostClient` and the native ProcessHost for Job Object process-tree supervision;
- the ProcessHost global named mutex for one execution Worker per resolved data root;
- `ProductionWorkspaceDiskBudget` for bounded attempt storage and orphan cleanup; and
- `ProductionDisposableJobWorkspaceProvider` for shared repositories and per-attempt worktrees.

The historical Control and Executor role bundles are not production entry points. ADR 0029
replaces their credential-isolation threat model with one trusted-code Worker process.
ADR 0031 adds profile execution and bounded evidence without restoring the split-worker design.
Runtime capability labels are generated from prepared components and interactive-session readiness;
deployment labels cannot enable an unavailable driver. See the
[profile runtime settings](../../deploy/worker/README.md#profile-validation-runtime).

## Shared repositories and worktrees

Each configured public GitHub repository has one persistent bare repository beneath
`WORKER_GIT_SHARED_ROOT_DIRECTORY`. Before a pull request job starts, the Worker fetches the immutable
envelope `baseSha` and the GitHub pull request head ref with full history, verifies both commit SHAs,
and requires a valid merge base. It supports arbitrary base refs, including `dev`, with no `main`
assumption or fallback. It then creates a detached worktree
for the exact head SHA beneath `WORKER_WORKSPACE_ROOT_DIRECTORY`.
Issue validation fetches only the exact commit authorized by its operator and frozen plan.
Issue triage uses a non-repository snapshot workspace. Profile checks and model review have separate
workspace directories under the same real lease, so model edits cannot certify a changed PR.

Use a short workspace root when validating Windows projects with nested package lifecycle scripts.
Filesystem long-path support does not guarantee that every tool can launch children from those
directories. M24 reproduced `cmd.exe` child startup failures at long working-directory lengths with
Node 24.20.0; pnpm 9.14.4 surfaced an unreadable-stream error. A fresh shorter workspace allowed the
same pinned source and dependency installation to complete. See the
[actual execution ledger](../../docs/design/2026-09-07-production-validation-acceptance.md).

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
the accounting queue and the operation each have this deadline, and snapshot retries share the
operation's deadline. A single Worker-wide monitoring timer shares each in-flight workspace scan
across active reservations, while checking every reservation's own quota and identity. Final
checks start a fresh scan after the command finishes. `WORKER_EXECUTION_DISK_SCAN_ENTRY_LIMIT`
defaults to `100000` and accepts
`1..1000000` entries per accounting scan. Larger pnpm trees may need higher limits based on host I/O
performance. Raising them permits longer scans and delays disk-budget failure detection; per-attempt
and total quotas, reserved headroom, and the free-space floor remain enforced. Shared Git accounting
continues to use its separate `WORKER_GIT_SHARED_SCAN_*` settings.

Profile step deadlines include preparation and post-process verification, not only the command's
wall time. Size build/test budgets using the full lifecycle on the intended dependency tree and
host. A command can exit zero while the step remains inconclusive because its fresh verification
exceeded the deadline. Publish a new profile version when changing these budgets; retained Run
plans and results keep their original settings. Source observation and cleanup also require their
own configured budget; increasing a scan timeout alone does not increase those deadlines.
`WORKER_VALIDATION_CLEANUP_TIMEOUT_MS` defaults to `30000` and accepts `1000..300000`
milliseconds. This independent budget covers final source observation and cleanup for headless
and UI validation. Configure it for the complete final verification lifecycle, including any
in-flight disk scan, fresh scans, Git observation, and configured cleanup commands. Increasing it
can delay final lease settlement and desktop release after cancellation; individual command,
process, disk, and source-integrity checks remain enforced.

After ProcessHost acquires the data-root singleton, startup removes all unreserved attempt
directories in bounded batches before claiming work, including attempts from a recent crash.
Recovery retains the path and directory-identity checks used by ordinary cleanup. Temporary
capacity shortages pause lease claims with zero available slots; the Worker checks again every
five seconds and resumes when capacity returns. Unsafe paths and failed accounting still drain
the Worker.

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

The parent Worker process owns this Token. Git, model CLI, ProcessHost children, repository commands,
and validation commands receive replacement environments that do not contain it.

## CLI-owned model execution

Configure `WORKER_CLI_ENGINE` as `codex` or `copilot` and set
`WORKER_CLI_EXECUTABLE_PATH` to the installed CLI application. Optionally set `WORKER_CLI_HOME`
for that CLI's persistent home and `WORKER_CLI_MODEL` for an explicit model choice. The Worker
detects the installed version through a bounded `--version` invocation; it does not require a
manually declared CLI version. `WORKER_CLI_SHA256` is an optional installed-binary pin. CLI paths
may be outside `WORKER_TRUSTED_EXECUTABLE_ROOT`; Windows WinGet application links resolve to their
installed targets. Version detection uses ProcessHost with a 20-second and 64-KiB limit and records
the first stdout line. Runtime capabilities expose `cliEngine` and `cliVersion`
as nullable values. `WORKER_MODEL_EXECUTION_ENABLED` defaults to `true`; set it to `false` and omit
CLI configuration for a model-free Worker with neither an engine nor an observed CLI version.

Use the CLI's own login command under the Windows identity that runs the Worker, with the same
optional home. The CLI manages its provider, authentication and network traffic. The Worker does
not read, copy or rewrite CLI auth/provider configuration, and it does not create task-specific
copies of login storage. Login in a different account or CLI home does not establish readiness.
Keep persistent CLI state outside disposable workspaces and task temporary directories.

The project owns the task prompt, output schema, selected CLI configuration, managed process exit
and structured result. It has no global provider registry, provider metadata classification file,
HTTP relay or provider call ledger. A configured model name and reported CLI version do not prove
which remote model a provider used. See the
[CLI-owned execution design](../../docs/design/2026-09-10-cli-owned-model-execution.md).

`WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS`, `WORKER_MODEL_MAX_PROCESSES`,
`WORKER_MODEL_MAX_MEMORY_BYTES` and `WORKER_MODEL_MAX_OUTPUT_BYTES` bound model execution through
ProcessHost. These limits and replacement child environments preserve operational control and
exclude the Worker Bearer Token; they do not establish hostile-code or network isolation inside
the VM. Deterministic validation retains its own readiness, evidence and cleanup checks.

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
# Fill in the Server URL, runtime paths, CLI selection, and ProcessHost/Git integrity settings.
.\deploy\worker\start-worker.ps1 -ConfigPath .\deploy\worker\worker-config.psd1
```

`worker-config.template.psd1` includes all supported `WORKER_*` environment values for
`loadWorkerConfig()` and `loadExecutionConfig()`, including the Worker-side execution budgets and
Worker-side shared Git cache and conservative GC controls. Process-level values such as `NODE_ENV`
remain service-manager configuration.

The launch script resolves Node.js and normalizes `PATH`. Do not add `WORKER_RECIPE_IDS`; the CLI runs
repository build/test commands directly. If initialization fails after ProcessHost starts, the
Worker waits for ProcessHost closure before reporting the original error.

For manual acceptance on Windows, follow `deploy/worker/worker-e2e-runbook.md` and capture evidence
with `deploy/worker/invoke-worker-e2e.ps1`. That script is an evidence collector and does not run
an automated end-to-end workflow.
The authorized local Windows exercise on the approved PR targeting `dev` passed runtime acceptance.
Its tested configuration, evidence, and environment closeout are recorded in the
[live validation handoff](../../docs/handoff/2026-09-05-windows-e2e-live-validation.md).
Other local verification continues to require task-specific authorization.

Production Server connections use HTTPS. Package signing is a deployment concern only when Worker
bundles are distributed automatically; it is not required for a manual trusted deployment.
