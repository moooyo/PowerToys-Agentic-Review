# Windows production supervision

These scripts were initially added before Windows execution was available. The
[four-GiB workflow handoff](../../docs/handoff/2026-09-27-four-gib-workflow-acceptance.md)
records subsequent isolated registration, native startup and data-reopening evidence,
alongside its remaining acceptance limits. A successful script installation alone
does not establish application readiness, boot behavior, or production acceptance.

## Process and account model

- The Server runs in a Windows Scheduled Task under a dedicated, least-privilege
  account with a password logon and an at-startup trigger. It can start without an
  interactive user. The installer accepts a `PSCredential`; Windows Task Scheduler
  manages the stored credential. The scripts do not save or print its password.
  Provision **Log on as a batch job** (`SeBatchLogonRight`) for that exact identity
  and ensure no applicable **Deny log on as a batch job** policy overrides it. Task
  registration can succeed while execution is rejected with Windows logon status
  `0xC000015B`; that rejection occurs before the product launcher runs. The installer
  does not silently change local security policy or grant rights to account groups.
- The Worker runs under its configured user's `Interactive` principal with an
  at-logon trigger. That user must remain logged in. The launcher rejects Session 0
  and a non-interactive environment. Logon alone does not prove that the desktop is
  unlocked, connected, or suitable for UI work: the production desktop capability
  and owned application checks must still pass before accepting E2E work.
- `start-windows-task.ps1` holds a named Windows mutex for the operations state
  directory throughout the supervisor's lifetime. Always use this launcher through
  its Scheduled Task. Do not invoke the Node supervisor directly.
- The supervisor forks only the fixed Server or Worker entry inside the configured
  release. Its private IPC bridge invokes the existing `SIGTERM` handler, including
  a stop request received during asynchronous startup. This uses the application's
  normal cleanup and ProcessHost ownership protocol.
- The supervisor copies only an explicit Windows environment allowlist, then adds
  the role's `INVESTIGATION_*` configuration. Inherited `NODE_OPTIONS`, `NODE_PATH`,
  unrelated credentials, and legacy `WORKER_*` configuration are not accepted.

The existing `deploy/worker/start-worker.ps1` uses the legacy `WORKER_*` deployment
format. It is not an entry point for the native investigation deployment described
here. The new examples follow the current investigation runtime configuration.

## Prepare an immutable release and private state

Do this only after the Windows worker becomes available and deployment is scheduled.
The installer does not build, package, copy, upgrade, or replace any release.

1. Stage a reviewed, prebuilt release with the existing monorepo runtime layout:
   Server `apps/server/dist/main.js`, its compiled modules and runtime dependencies;
   Worker `apps/worker/dist/worker.mjs` and all bundled helpers; Dashboard
   `apps/dashboard/dist`; and this `deploy/operations` directory. Use the supported
   Node version from the root `package.json`. Keep the release immutable to the
   runtime accounts. Dependency links must resolve to physical targets inside the
   same release; external package-store links are rejected.
2. Pre-create separate directories for the release, application data, operations
   state, and configuration. For example, use `D:\AgenticReview\Releases\release-id`,
   `D:\AgenticReview\Data\Server`, `D:\AgenticReview\Operations\Server`, and
   `D:\AgenticReview\Config\Server\server.json`. Give the Worker different data and state
   directories. No directory may contain another of these runtime directories.
3. Administrators or SYSTEM must own and exclusively control writes to the release,
   its ancestors, installed Node, and configuration. The dedicated runtime account
   needs read access to its configuration and release, and write access only to its
   own private data and operations state. Private configuration/state/data ACLs may
   grant access only to that account, Administrators, and SYSTEM. Configure safe ACLs
   before copying secrets. Use separate private Server and Worker configuration directories;
   a shared configuration directory readable by both runtime identities fails the private ACL check.
   Ancestor ACLs must not let unrelated users delete child
   directories, change permissions, or take ownership. The scripts inspect these
   rights rather than silently changing ACLs.
4. Copy `windows-server.example.json` and `windows-worker.example.json` to the private
   configuration directory and replace every placeholder. Obtain entry SHA256
   digests from the staged Server/Worker files and the Dashboard `index.html`.
   Record the reviewed source commit in `artifact.sourceRevision`. Entry hashes
   observe selected prebuilt bytes; they do not prove that all release files were
   built from that source. Retain the build and full artifact receipts separately.
5. Provision runtime credentials and trusted executable pins through the existing
   account and Worker procedures. Keep the CLI account home outside disposable
   Worker data. The Worker template intentionally leaves static configuration
   verification false; set it true only after the corresponding evidence exists.
   Configure the existing MSBuild, UI adapter, repository, and model settings for the
   actual installation. No toolchain or desktop readiness is inferred from the
   example.

The full release tree is inspected for unsafe write ACLs before launch, including
compiled modules, dependencies, and Dashboard files. The scan is bounded at 250,000
entries and five minutes; a larger release requires a deliberate packaging/review
decision. Reparse points in private/configuration paths are rejected. The runtime
entry and shutdown bridge must be physical files under the immutable release.

The supervisor derives the Server database paths as `investigation.sqlite` and
`investigation-accounts.sqlite` inside its data directory, fixes the Dashboard path
to the configured release, and derives the Worker's data root from `dataDirectory`.
These settings cannot be overridden in `environment`. Existing database migration
and Worker journal recovery remain the application's responsibility. Never point an
unreviewed release at existing production data to test a migration.

Server `_PATH` credential files, including TLS keys and passphrases, receive private
file/parent ACL checks. Keep all bootstrap files and tokens out of the repository,
Task Scheduler arguments, acceptance receipts, and shared logs. Remove initial
bootstrap password settings after establishing the account through the documented
account lifecycle. Keep `INVESTIGATION_ENABLE_EXTERNAL_WRITES=false` during isolated
acceptance. A general deployment approval does not approve actual PR/issue writes.

## Register, start, stop, and restart

For Codex Workers that need response-boundary token stop controls, set
`INVESTIGATION_WORKER_CODEX_TRANSPORT=app-server` and select an explicit model with
`INVESTIGATION_WORKER_CLI_MODEL`. This uses the installed CLI's stdio protocol and
existing provider configuration. The default `exec` transport remains available
for older CLIs and synthetic fixtures; its token usage arrives only at turn end.

Native `pr-e2e` tasks also discover [bundled PowerToys Run recipes](../worker/e2e-recipes.md)
from their repository and changed paths. A single `run-recipe` request performs the
controlled build, query scenarios, assertions, screenshots and owned-process cleanup.
The model reviews the receipts and any remaining PR coverage; no private helper path
or additional Worker configuration is required.

The app-server transport receives cumulative usage during an invocation and
interrupts when the remaining task allowance is exhausted. The task deadline
also covers preparation and cancellation has a bounded native teardown fallback.
Interrupted calls retain observed usage as partial, including any excess, and
cannot contribute accepted model output. Accounting regressions, compaction and
unexpected model changes stop the call instead of admitting more work.

This is a response-boundary stop control, not an exact prepaid token or currency
cap: an in-flight response and notification latency can overshoot, and provider
accounting may not expose every charge. Keep the task duration bounded and do not
restart an interrupted call without reviewing its retained usage and remaining
allowance.

Run the installed scripts from the configured release. These examples are future
operator commands, not records of executed actions. Registration requires an
elevated administrator; runtime tasks use the limited account configured above.

```powershell
$release = 'D:\AgenticReview\Releases\release-id'
$serverConfig = 'D:\AgenticReview\Config\Server\server.json'
$workerConfig = 'D:\AgenticReview\Config\Worker\worker.json'
$serverCredential = Get-Credential -UserName 'HOSTNAME\review-server'
& "$release\deploy\operations\register-windows-task.ps1" -ConfigPath $serverConfig -Credential $serverCredential
& "$release\deploy\operations\register-windows-task.ps1" -ConfigPath $workerConfig
```

Registration never starts a task and refuses an existing task name. Inspect the
actions, principal, trigger, and settings before starting. Both tasks disable
independent Task Scheduler restart attempts, execution time limits, and forced task
termination. Do not use Task Scheduler's End action, `Stop-ScheduledTask`,
`Stop-Process`, or a process-name kill as the ordinary stop procedure.

```powershell
Start-ScheduledTask -TaskPath '\AgenticReview\' -TaskName 'AgenticReview-Server'
# Start only while the configured Worker user is logged in to the interactive desktop.
Start-ScheduledTask -TaskPath '\AgenticReview\' -TaskName 'AgenticReview-Worker'

& "$release\deploy\operations\stop-windows-task.ps1" -ConfigPath $workerConfig
& "$release\deploy\operations\stop-windows-task.ps1" -ConfigPath $serverConfig
```

Stop intake and drain work before maintenance, then stop the Worker and Server in
that order. A stop script publishes a generation-specific request with a flushed
atomic rename and waits for the same generation's terminal status. It does not kill
processes or stop the Scheduled Task forcibly. Restart the same reviewed release
with `Start-ScheduledTask` only after successful cooperative shutdown and review of
any retained failure. For a release change, retain the old release/configuration,
back up data through the supported consistent-backup procedure, and explicitly
review replacement task registration. The scripts provide no automatic upgrade or
database downgrade protocol.

## Failure and capacity behavior

- `status.json` records a generation ID, boot identity, supervisor/child PIDs,
  declared artifact identity, timestamps, restart count, and terminal outcome. Its
  `running` state means the child process spawned; it is not a health check.
- Unexpected Server exits receive at most `restartLimit` retries for one supervisor
  lifetime, with exponential delays capped at `restartMaximumDelaySeconds`. A clean
  but unexpected Worker exit may retry within the same bound. A nonzero/signal
  Worker exit may mean cleanup was not confirmed, so it stops with
  `recovery-required` and does not automatically restart.
- Requested shutdown never retries. A Worker shutdown failure, including a nonzero
  exit after an operator stop, also becomes `recovery-required`. The Worker deadline
  must cover three configured runtime shutdown deadlines plus 60 seconds for
  journals and scheduling. The Server deadline must cover its 30-second close
  deadline plus 60 seconds.
- If cooperative shutdown exceeds its deadline, the supervisor keeps the owned
  child and mutex alive, writes `shutdown-timeout` when storage is available, and
  disables restart. A later exit still retains failure. No cleanup success is
  fabricated and no process-name termination occurs. If status or log persistence
  fails, the supervisor requests cooperation and holds ownership until the child
  closes; storage failure is not permission to launch a replacement child.
- A retained active or `recovery-required` generation blocks takeover within the
  same Windows boot, even if its recorded PIDs disappeared. This covers a crash
  before a child PID could be persisted. Inspect the native ProcessHost ownership
  and cleanup journals, exact processes, leases, and desktop state. After resolving
  them, retain the exact status as a recovery receipt before explicitly moving it
  aside. Do not delete Worker journals, task records, or evidence to clear a gate.
  A new Windows boot permits startup because the old processes cannot survive it;
  application recovery must still confirm the retained journals.
- Completed generation receipts are retained in `stateDirectory\history` before a
  new generation replaces `status.json`. They are not automatically deleted.
  Runtime output uses `logs\runtime.log` plus four rotated files, each capped at
  approximately 8 MiB. Lines above 64 KiB are discarded. Known configured secret
  values are redacted, but logs still require private ACLs: arbitrary application
  output may contain sensitive information the supervisor cannot classify.

Capacity acceptance must observe the actual database/WAL/SHM allocation, Worker
workspaces, caches, journals, evidence, operations history, and volume free space.
This supervisor only bounds its own runtime logs. It does not vacuum databases,
prune Worker state, promise disk reclamation, or establish sustained throughput.
Use the operations capacity receipt workflow with isolated fixtures and explicitly
record blocked measurements while the worker is unavailable.

## Verification to execute after the worker is ready

The pure configuration tests passed in the scoped remote workflow. Re-run them when validating
a changed release:

```powershell
node --test deploy/operations/tests/windows-supervisor.test.mjs
```

Run verification in the designated Windows environment, with synthetic data and
outbound PR/issue writes disabled. Retain evidence for each case below. This matrix
defines the full intended coverage; consult the workflow handoff for the cases and
limits actually accepted. Unrecorded cases remain pending.

| Case | Required observation |
| --- | --- |
| Startup and reboot | Server starts without a user logon; Worker does not start without its interactive user; repeated triggers create no duplicate generation. |
| Actual readiness | Authentication, Dashboard served bytes, API/Worker registration, and desktop capability match the reviewed release and configuration. |
| Cooperative stop during startup and work | IPC reaches late-installed signal handlers; Worker journals, owned process closure, lease release, and terminal status agree. |
| Bounded retry | Synthetic Server crash and clean Worker exit follow the configured delay/budget; Worker failure or abnormal signal requires recovery. |
| Restart safety | Same-boot active/recovery receipts block takeover; a new boot preserves the prior receipt and runs native recovery before work admission. |
| Shutdown timeout | A synthetic stuck child stays retained; no new child starts; a later exit remains a failed receipt. |
| Storage failure | Injected status/log write failure after spawn cannot drop ownership or launch a replacement; no credential values enter public output. |
| Permission and path rejection | Unsafe file/ancestor ACLs, dependency escape links, Session 0, changed entry bytes, and inherited loader hooks fail closed. |
| Stop concurrency | Duplicate stop requests and rapid child exits remain generation-safe and do not report false parse failures. |
| Data retention and capacity | Restart preserves accounts/tasks/journals/evidence; sustained isolated workloads provide measured storage and throughput receipts. |

Complete the separate latest Dashboard browser, publication, E2E cleanup, historical
scenario, and capacity acceptance matrix before claiming production acceptance.
Live repository mutations need their own explicit target/payload/scope approval.
