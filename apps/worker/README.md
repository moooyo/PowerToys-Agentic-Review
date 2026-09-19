# Investigation Windows Worker

The active Worker consumes the native Task/Attempt protocol. `src/main.ts` starts
`createInvestigationExecutionRuntime`, bundled as `dist/worker.mjs`. It does not translate Tasks
into legacy Job envelopes. Legacy `WORKER_*` deployment examples are not configuration for this
entry point.

The Worker uses ProcessHost for process lifetime, scoped attempt directories for source and model
inputs, durable checkpoints for continuation, and bounded report parts and evidence uploads.
Static model turns return structured analysis. Implementation steps return structured edits that
the Worker applies only after checking each allowed path and expected original-content digest.
No task implicitly commits, pushes, or publishes a GitHub action.

## Deployment configuration

Use Node.js 24.20.x and the compiled Windows ProcessHost. Configure the following variables in
the dedicated Worker account. Paths must be canonical local Windows paths. Mutable data must be
separate from trusted tools and the CLI account configuration.

| Variable | Meaning |
| --- | --- |
| `INVESTIGATION_WORKER_SERVER_URL` | Server origin, normally HTTPS, without a path or credentials. |
| `INVESTIGATION_WORKER_TOKEN` | The 43-256 character base64url bearer credential registered in Server `INVESTIGATION_WORKERS_JSON`. |
| `INVESTIGATION_WORKER_ALLOW_INSECURE_HTTP` | Defaults to false; must explicitly be true for an intended HTTP environment. |
| `INVESTIGATION_WORKER_DATA_DIRECTORY` | Owned mutable data root; attempts are created under its `attempts` directory. |
| `INVESTIGATION_WORKER_TRUSTED_EXECUTABLE_ROOT` | Separate trusted directory containing ProcessHost and Git. |
| `INVESTIGATION_WORKER_PROCESS_HOST_PATH`, `INVESTIGATION_WORKER_PROCESS_HOST_SHA256` | Exact ProcessHost executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_GIT_PATH`, `INVESTIGATION_WORKER_GIT_SHA256` | Exact Git executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_CLI_PATH`, `INVESTIGATION_WORKER_CLI_SHA256` | Exact configured CLI executable and lowercase SHA-256. |
| `INVESTIGATION_WORKER_CLI_ENGINE` | `codex` or `copilot`; defaults to `codex`. |
| `INVESTIGATION_WORKER_CLI_MODEL` | Optional model identifier passed to the CLI. |
| `INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON` | Exact public repository names allowed for source checkout, such as `["moooyo/PowerToys"]`. |
| `INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON` | Explicit non-secret account paths, including `USERPROFILE` and `CODEX_HOME` or `COPILOT_HOME`. |
| `INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED` | Set true only after configuring the deployment-owned static CLI policy and unmanaged-tool exclusions. |
| `INVESTIGATION_WORKER_DISABLED_MCP_SERVERS_JSON` | MCP server names explicitly disabled for model turns. |
| `INVESTIGATION_WORKER_PATH` | Optional explicit trusted executable search path. |
| `INVESTIGATION_WORKER_EXECUTABLES_JSON` | Maps trusted command IDs to `{ "path", "sha256" }`. |
| `INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON` | Explicit non-secret environment values for registered execution steps and controlled E2E builds. |
| `INVESTIGATION_WORKER_UI_ADAPTERS_JSON` | Registered Windows/Web UI adapters with pinned drivers, application bindings, and frozen scenarios. |

The CLI owns its account login. The Worker does not copy authentication files. Its service
credential is never placed in child process environments or model input. Git source acquisition
uses an explicit public repository allowlist and disables inherited credentials, hooks, and
submodule execution.

Windows builds also need the execution account's required system and writable cache paths.
Configure these explicitly in the plan environment; setting SDK variables alone is insufficient.
Visual Studio and vcpkg can require `PROGRAMDATA`, `PROGRAMFILES`, `PROGRAMFILES(X86)`,
`PROCESSOR_ARCHITECTURE`, `SYSTEMDRIVE`, and `LOCALAPPDATA` or `APPDATA`.
`PROGRAMFILES` and `PROGRAMFILES(X86)` must retain their distinct actual system paths.
Use the actual system values and prepared
execution-owned cache directories as described in the [Windows toolchain environment notes](../../deploy/worker/README.md).
Keep CLI account configuration and authentication separate from the execution environment.
Set `VCPKG_MAX_CONCURRENCY` explicitly when vcpkg builds must fit a constrained process-memory
budget. MSBuild's single-node setting does not constrain port build parallelism; vcpkg otherwise
[defaults to the logical processor count plus one](https://learn.microsoft.com/en-us/vcpkg/users/config-environment#vcpkg_max_concurrency).

## Task execution

Supported task kinds are `pr-review`, `issue-investigate`, `pr-e2e`, `pr-verify`, `issue-verify`,
`reproduction-setup`, `issue-fix`, and `feature-implement`. `INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON`
can restrict the claimed kinds. Snapshot-only investigation does not checkout or execute source.
Source-aware Issue work requires an explicitly selected commit; the Worker does not guess a branch.

`pr-e2e` is a root execution task and does not require a static parent report or saved plan.
Its independent agent prompt permits builds, tests, application launch, UI interaction and
media capture. A per-attempt loopback tool service executes these actions through ProcessHost,
records assertion receipts and imports actual PNG or finalized H.264 MP4 evidence. The agent
can discover and adapt scenarios from the pinned diff; registered scenarios remain available
to legacy saved-plan tasks. Repository source is never changed to make a check pass.

Run the E2E role in an unlocked interactive Windows session. The bundle includes
`e2e-desktop-driver.ps1`, which uses Windows UI Automation and verified process identities.
PowerShell defaults to the operating system installation; the `powershell` executable ID may
override it with a pinned path. Configure the optional `ffmpeg` executable ID in
`INVESTIGATION_WORKER_EXECUTABLES_JSON` to enable video recording. FFmpeg must support gdigrab
and libx264. Screenshots remain available without FFmpeg. Video clips are limited to 120 seconds
and a bounded bitrate/file size suitable for GitHub attachments. Build toolchains and dependency
paths belong in the explicit non-secret plan environment and trusted PATH.

Configure pinned `msbuild` and/or `dotnet` executable IDs for controlled E2E builds. The Worker
owns compiler arguments and creates a fresh output directory. It records the pinned project,
revision, actual compiler command and output hashes; application launch only accepts unchanged
outputs from that build receipt. An arbitrary successful shell command or copied binary cannot
provide build provenance. Generic commands remain available for diagnostics and preparation.

For solutions with a repository-specific package layout, `repositoryOutputDirectory` selects
a bounded relative output directory that must be absent after checkout cleanup. The Worker
preserves project output settings, then moves this newly built tree into its private sealed
output directory, retaining plugin subdirectories and complete dependency hashes. An optional
`solutionProject` selects an actual project entry in the pinned `.slnx`; the Worker derives its
solution-folder target and appends the fixed `Rebuild` operation. It does not accept arbitrary
MSBuild targets. [MSBuild documents this solution target syntax](https://learn.microsoft.com/en-us/visualstudio/msbuild/how-to-build-specific-targets-in-solutions-by-using-msbuild-exe).
MSBuild invocations enable `RestorePackagesConfig=true`, limit project nodes with
`maxCpuCount=1`, and set `CL_MPCount=1` for native compiler parallelism. These are
[separate layers of C++ build parallelism](https://devblogs.microsoft.com/cppblog/cpp-build-throughput-investigation-and-tune-up/).
An explicit final console summary keeps normal-exit compiler errors visible in the bounded
output tail. Build failures retain the exit code and bounded compiler stdout/stderr in their
normal tool receipt and evidence log.

The agent registers each feature's scenario and exact assertion specifications before testing.
User-visible features require UI assertions against named controls. Every assertion and media
receipt binds to one registered feature and verified build; screenshots retain the matching UI
state, while video requires an active owned window, actual interaction and assertions during the
recording. One feature's receipts cannot establish another feature's success. Worker records
supply report expectations and build identity; the agent's blocked or unexecuted disposition
is never upgraded to passed.

The Server durably records an E2E start before the first side effect and persists observations
as they arrive. If execution is interrupted before a complete result, resuming the Task does
not repeat desktop actions; an explicit new Task is required to rerun. Complete accepted E2E
results can resume report delivery without another model call or execution.

Every passed feature requires actual assertion receipts and screenshot or video evidence.
The report binds each artifact to the task, producing attempt and pinned revision. Missing
prerequisites, uncovered paths or missing media cannot produce a completed E2E result. The
Worker stops all attempt-owned process trees and confirms desktop cleanup before acknowledging
release of the exclusive slot. A cleanup uncertainty keeps the desktop quarantined. Only the
Server publishes GitHub comments or uploads media.

PR source preparation verifies exact base/head and merge-base identities. Investigation maintains
complete coverage and candidate/recheck records; a final report is not a top-k selection. Partial
outcomes retain known findings and the remaining work. Resume uses the accepted checkpoint and
frozen source/configuration, not an assumed surviving CLI session.

For a saved patch, `Task.sourceArtifacts` retains the original producing task and attempt metadata;
the child report preserves it in `context.sourceArtifacts`. The Worker fetches the exact inherited
artifact through its current scoped lease and verifies its patch digest and subject before source
materialization. Inherited source is not relabeled as new child-task execution evidence, and a
missing or expired required patch blocks execution rather than selecting different source.

Executable plans require the Server's trusted execution binding as well as Worker executable or
UI registrations. A natural-language plan alone cannot run commands. Command, UI, and model-edit
steps write start records before execution and retain actual outcomes, source identity, and
artifacts afterward. An uncertain in-flight mutation is not automatically replayed.

UI adapter configuration is validated by `src/investigation/ui-plan-adapter.ts`. Web scenarios
use pinned browser/driver files and an owned application origin. Windows desktop scenarios need
an active, unlocked dedicated session and an exclusive desktop lock. Missing readiness or evidence
is reported as a blocker; a model summary cannot fabricate a successful UI result.

## Limits and shutdown

`INVESTIGATION_WORKER_MAX_CONCURRENT_STATIC_TASKS` defaults to 1 and controls the local static
pool. `INVESTIGATION_WORKER_MAX_CONCURRENT_TASKS` remains its legacy fallback. Execution tasks,
including saved-plan verification, have a separate fixed local capacity of one. The Server also
enforces one global execution slot and a persisted static concurrency setting, so adding Workers
cannot bypass either limit. Claims skip task kinds whose local pool is full.

`INVESTIGATION_WORKER_ROLE` is `all` by default; `static` and `e2e` select independent role
processes. Role processes must use separate data directories. Increasing the Server setting only
admits new work up to the Workers' configured local limits; lowering it does not cancel active work.

Every execution attempt also holds one machine-wide filesystem guard from source preparation
through build, UI work, and confirmed local cleanup. `INVESTIGATION_WORKER_DESKTOP_LOCK_DIRECTORY`
defaults to `%ProgramData%\PowerToysAgenticReview\desktop-locks`; every Worker process on the same
machine must use the same deployment-owned directory even when roles use different data roots.
Do not configure separate lock directories per role, repository, or Worker. Static review and
investigation tasks do not acquire this guard. Scenario-level session locks use a different key.
The original owner releases its guard only after trusted local cleanup, before acknowledging
cleanup to the Server. Crashes, lost leases, or unconfirmed cleanup retain a durable quarantine
with no TTL or PID-based stale-owner recovery. Trusted recovery requires the original owner's
private journal credentials, exclusive native-host recovery ownership, and explicit proof that
owned processes stopped and the desktop was restored. Workspace recovery additionally matches
the persisted root, attempt, and ownership-file identities before removing checked entries.
Without a workspace ownership receipt, only a confirmed absent attempt directory can proceed;
unknown, replaced, or incompatible state remains blocked for operator investigation.

Configure bounded process duration,
process count, memory, and output through `PROCESS_TIMEOUT_MS`, `MAX_PROCESS_COUNT`,
`MAX_MEMORY_BYTES`, and `MAX_OUTPUT_BYTES`, each prefixed with `INVESTIGATION_WORKER_`.
`GIT_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `CLAIM_POLL_MS`, and `SHUTDOWN_TIMEOUT_MS` use the same prefix.
Task budgets are independently frozen by the Server and enforced across loop and plan receipts.

Artifact retention and aggregate upload quotas are configured on the Server through
`INVESTIGATION_EVIDENCE_*`; they are independent of Worker process and task limits. Quota exhaustion
rejects additional uploads without evicting content protected for active tasks, recovery, or
unfinished follow-ups. See the [Server evidence instructions](../server/README.md#evidence-retention-and-capacity)
for defaults and current artifact-availability reads.

SIGINT/SIGTERM shutdown stops new claims, cancels owned work, drains managed processes, and closes
ProcessHost. Unconfirmed cleanup produces a node fault and retains the affected workspace rather
than claiming a successful release. A new Worker must not reuse an uncertain attempt directory.
Cancellation, expiration, and report completion do not release an execution slot by themselves.
The original fenced Worker confirms process termination and desktop restoration through the
cleanup endpoint. A missing confirmation leaves the resource in `needs_cleanup` without a TTL.

## Execution cleanup recovery

Before an execution attempt acquires the desktop or prepares source, the Worker writes an
immutable, fsynced cleanup identity under `DATA_DIRECTORY\attempt-cleanup`. It retains the
original task, attempt, fenced lease credential, private guard capability, native ownership
generation, and workspace ownership receipts. Keep this Worker data directory private to its
service account. Never copy these records into reports, public artifacts, or diagnostic exports.

The production runtime enables ProcessHost `named-job-tree-v1` recovery. A replacement Host must
acquire the same instance mutex, terminate and drain the previous named Job, and verify zero
previous processes before accepting new launches. The proof covers the old Host and its managed
Job process tree; PID absence and mutex acquisition alone are insufficient. Upgrade and pin the
matching ProcessHost binary before deploying this Worker version.

Startup replays cleanup receipts, never the interrupted model or E2E test. A saved local cleanup
confirmation can finish releasing its matching guard and retry the original Server cleanup
acknowledgement. An interrupted execution additionally needs desktop-restoration confirmation.
Static work can continue while the Server retains the E2E resource in `needs_cleanup`.

Stop the owning Worker before a recovery confirmation. Using the same Worker configuration and
data directory, inspect only sanitized status:

```powershell
node dist/worker.mjs cleanup-recovery list
```

After restoring the dedicated desktop, confirm one exact attempt. This command obtains native
exclusive recovery ownership and reads the original lease from its private journal; it accepts
no lease-token argument and does not start a task:

```powershell
node dist/worker.mjs cleanup-recovery confirm <attempt-id> --desktop-restored --reason "Restored the dedicated desktop after the interrupted attempt."
```

Legacy receipts without native recovery capability, or processes launched through a service/WMI
broker outside the managed Job, also require independently verifying the original Host and every
owned process stopped, then adding `--owned-process-tree-stopped`. Do not use this confirmation
based only on a missing PID. Unmatched guards, redirected paths, unknown ownership markers, and
existing workspaces without a retained ownership receipt remain blocked rather than being deleted.
Old saved-plan `session-N.lock` markers require their own proven restoration; the attempt recovery
command does not guess or delete their independent ownership. A Server lease that has not yet
expired can temporarily reject a crash-recovery acknowledgement; the retained receipt is retried
on subsequent Worker startup and idle polling.

## Verification

Run project verification on the project-designated remote Windows worker. Linux-specific checks
may use `test-env`; local verification requires explicit authorization for the current task.
Tests use isolated state and injected model, filesystem, process, and GitHub transports. Linux
verification does not establish real Windows desktop or real-model acceptance.

Build with `pnpm --filter @agentic-review/worker build` in the authorized environment, then start
the configured Worker with `pnpm --filter @agentic-review/worker start`. Actual PR/Issue writes are
handled by the Server's separate confirmed action-intent path and require their own explicit scope.

The [investigation acceptance instructions](../../deploy/investigation-acceptance/README.md) describe
the opt-in harness for production entry points, consecutive synthetic tasks, cancellation,
graceful restart/resume, report export, and cleanup. A separate companion uses an already frozen
public Issue and the real configured CLI. Follow each script's prerequisites and evidence scope;
the presence of a harness is not proof that the deployment or a real model workflow passed.
