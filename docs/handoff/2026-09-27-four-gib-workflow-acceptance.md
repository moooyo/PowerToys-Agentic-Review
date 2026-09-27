# Four-GiB synthetic workflow acceptance, 2026-09-27

## Scope

The user requested serial workflow acceptance on a Windows worker with a 4 GiB memory ceiling,
without compiling PowerToys. The current project's shared packages, Server, Worker, and Dashboard
were prebuilt in the separate Linux test environment. Windows only ran the prepared payload and
serial acceptance checks. No real model was invoked and no actual repository PR or Issue was changed.

The candidate is the operations-readiness working tree based on `c811082`, including the pending
operations implementation and the small acceptance/source-boundary corrections. The base revision
is not the complete snapshot identity. Private source, build, runtime, and evidence manifests
identify the exact bytes. The Windows runtime's 1,299 application output entries match the Linux
build manifest; its additional root files are four build/manifest records, not changed code.

## Completed software and native checks

- Shared packages, Server, Worker, and Dashboard builds passed; Worker type checking passed.
- 149 distinct targeted tests passed: 30 operations-tool tests, 108 Server tests, and 11
  production-source boundary tests. The Windows repeat passed all 30 operations-tool tests
  serially. Changed-file Biome passed with zero errors and 23 warning-level diagnostics.
- The native production-entry workflow passed all 10 checks, including password authorization,
  queued/running observations, two consecutive completed tasks on one Worker, active cancellation,
  Server/Worker restart, same-task checkpoint resume, and immutable retained partial reports.
- All five executed attempts retained released static resource leases. Owned process/workspace
  closure was checked, and no action intent or external publication was created by this harness.
- The optional short capacity observation passed its predeclared thresholds: two completed tasks
  over 60.36 seconds, no observed failures/blocked/cancelled/interrupted states, and confirmed
  observer logout. Sampled database growth was 179,666,944 bytes and maximum sampled WAL length was
  9,385,424 bytes. This deliberately large synthetic report workload is not a per-task production
  storage estimate or a sustained throughput benchmark.

An inherited build-cache mismatch was corrected only in the new Linux preparation directory.
A source-boundary check incorrectly rejected a formatted trailing comma; its exact reviewed-call
comparison and whole-file regression were corrected without broadening loader permissions.

The private PowerShell wrapper recorded a null exit code for the first native harness. That value
remains unknown; it is not rewritten to zero. The product's completed receipt and independent
owned-process closure are separate evidence. Later wrappers retain the process handle before exit.

## Browser and operations follow-up

The first browser run accepted login error recovery and PR-to-Task-to-Report navigation, then
failed an immediate checkbox-state assertion. Its failure screenshot already shows the checkbox
selected and the selected count updated. The follow-up helper uses one ordinary click, waits for
the actual rendered state, and additionally checks the exact finding IDs in native prepared
payloads. The original failed run is preserved; no product code was changed for this helper issue.

The second browser run exposed another helper readiness issue: the URL changed before the old
Source page left the DOM, causing a strict locator to match two old-page links. The final helper
waits for page-specific committed content and verifies navigation identities and stable control
state. Both earlier failures remain retained.

The third browser run passed all 11 steps with one browser/context/page and no page errors or
blocked application requests. It used the compiled production Dashboard, real HTTP/password
authentication, and isolated SQLite with an injected synthetic read-only GitHub transport. The
checks cover login error recovery, PR/Source/Task/Report navigation, exact selected finding IDs in
two native prepared previews, editing into a new payload while preserving the first, queued-task
cancellation after an injected HTTP 503, and 320px light/dark layouts without horizontal overflow.
The browser and native fixture closed successfully. No confirmation or GitHub execution occurred.

The browser fixture enabled preparation through a private injected capability configuration, with
no GitHub token/configuration, no actor execution permission, and outbound connection traps.
Its synthetic records are not a real Worker report or proof of repository behavior.

The stopped native investigation and authentication databases were copied, backed up, and restored
into fresh isolated directories. Both restored databases passed SQLite `quick_check`; all 25
investigation tables and four authentication tables retained identical row counts and content
digests. This includes four tasks, five reports, five resource leases, and the original synthetic
account. The original database files were only read/copied and hashed, not opened through SQLite.
Application-level reopening under the new host is a separate check.

The initial hosted preparation retained three private-helper failures before any account or
Server task was created: a PowerShell 5 `File.Replace` null-binding issue, a case-insensitive
switch/local-variable collision, and an overlong local-account description. These were corrected
in the helpers without changing product behavior. Function-level Windows checks passed before
continuing. The full copied development dependency tree contained 60,076 files; a separate lean
runtime layout was prepared to avoid repeatedly scanning unnecessary development tools.
The full copy and its verification records remain preserved. The lean copy contains 5,444
payload files and 81 installed dependency contexts, with all six application output trees
byte-identical to the original runtime manifest. Internal dependency junctions remain within
the new release; production ACL checks were not relaxed.

The production registration script successfully created the previously absent Task Scheduler
folder and registered the isolated Server. Its first execution was rejected by Windows before
the launcher ran because the new temporary identity lacked `SeBatchLogonRight` (`0xC000015B`).
This account prerequisite is now explicit in the Windows runbook. Registration alone is not
evidence that the account can execute the task.

After adding only the missing batch-logon right to the recorded temporary account, the actual
production launcher and supervisor started the Server under that account in Session 0. Liveness
returned HTTP 200. Native password login and scoped API reads reopened all four tasks and all
five reports; report exports matched the original native acceptance hashes, and logout completed.
The prior Windows logon refusal remains preserved separately from the successful product startup.

Duplicate Server start requests preserved the same supervisor generation and child process, with
no additional restart. The actual hosted Worker then started under the existing interactive
identity in Session 1, authenticated with an isolated token and empty repository scope, and
advertised only the intended static task kind with E2E disabled. It did not execute a task or model.
The new production stop script and IPC bridge stopped the Worker, ProcessHost, supervisor and
wrapper; independent process observations confirmed closure. The Server also stopped cooperatively.
The first immediate wrapper observation was still exiting; a later independent observation
confirmed all Server processes absent rather than rewriting that initial observation.

The original Worker launcher separately rejected a Session 0 invocation before Node startup,
preserving the distinction between unattended Server hosting and interactive Worker requirements.

The stopped hosted investigation and authentication databases were then backed up and restored
to another fresh data directory. File hashes and all 25 plus four table digests matched. A new
supervisor generation opened that restored directory, passed liveness, accepted the preserved
test credentials, and returned the same four tasks and five report export hashes. It logged out
and stopped cooperatively; all owned processes were confirmed absent. An initial private backup
helper used the earlier harness's authentication filename instead of the hosted filename; its
failed receipt and partial copy were retained before the narrowly corrected continuation.

The minimal failure cases also passed. An invalid Server authentication configuration produced
four child launches in total, with 1/2/4-second backoff and three retries before terminal `failed`
with no child. The valid configuration was restored without starting another application. A
separate interactive Worker missing its token exited with code 1, retained `recovery-required`
and zero automatic retries. Another explicit start in the same boot was rejected without changing
the original status bytes or generation. These expected failures did not create tasks or models.

## Memory observations

The guest remained within a 4 GiB ceiling. Across the observation window, 242 samples were taken
at 20-second intervals with no sampling errors or skipped process observations. The lowest
observed available guest memory was 552,120,320 bytes (526.54 MiB), during the native workflow.
That phase had seven samples; the normal hosted phase had ten samples and at least 1,184.09 MiB
available at those observations. These values are sampled extrema, not exact peaks.

The successful browser run had only one memory sample; the two earlier short runs had none.
No browser peak-memory guarantee follows from those observations. The complete window also
includes preparation, copying, and idle periods, so its totals are not application-only usage.
The evidence supports 4 GiB for this prebuilt, serial, synthetic workflow. It does not establish
capacity for concurrent work, real model subprocesses, PowerToys builds, or sustained production.

## Cleanup

All 12 owned temporary Scheduled Tasks, the newly created Server account, and only its recorded
new batch-logon right were removed. Four plaintext fixture credential files were deleted, and
one-time bootstrap/Worker credentials were removed from the isolated configurations. Nonsecret
configuration, runtime manifests, databases, reports, and evidence remain available for review.

The first cleanup helper removed the tasks and then stopped on a PowerShell 5 JSON-array handling
error before changing the account or its rights. Its failed receipt remains intact. A constrained
continuation checked the recorded boundary and exact account SID before completing the remaining
cleanup. Final independent readback confirmed no owned tasks, fixture account, application or
wrapper processes, or isolated listeners. The original native database hashes still matched the
stopped baseline. The temporary artifact-transfer listener and its files were also removed.

The Worker VM remains running with both its maximum and balloon minimum set to 4 GiB. No previous
production service was started by this exercise, and this isolated acceptance is not a production
cutover. No further verification process or scheduled run remains active.

## Acceptance limits

This scope does not accept PowerToys compilation or feature behavior, the historical Peek/Launcher
scenarios, actual GitHub publication or the old external HTTP 401 cause, a VM reboot/power-loss
scenario, or long-term production capacity. Cached relay duplicates and actual Server receiver
re-entry have separate targeted test coverage. The new operations scripts do not turn these
explicitly excluded cases into successful runs.

Previous deployment data, accounts, histories, source seals, and deduplication records are preserved.
Detailed machine identities, private credentials, raw receipts, and operational records remain
outside the repository.
