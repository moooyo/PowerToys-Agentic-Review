# AgenticReview ProcessHost

`AgenticReview.ProcessHost.exe` is the Windows process-tree boundary used by the remote worker. It
accepts the versioned NDJSON protocol on standard input and emits protocol events only on standard
output. Diagnostics are written to standard error.

Build the Windows binary from this module:

```powershell
go build -buildvcs=false -trimpath -o AgenticReview.ProcessHost.exe .
```

The worker starts the binary with an absolute path, the required `--stdio` flag, and a validated
`--instance-key` derived from the resolved Worker data root. On Windows, ProcessHost holds
`Global\AgenticReview.Worker.<instance-key>` for its lifetime and exits deterministically if another
ProcessHost already owns that key. Every `start` request supplies a replacement environment and
explicit timeout, process-count, memory, and combined-output limits. ProcessHost does not invoke a
shell or inherit its own environment.

On Windows, ProcessHost creates the target with `CREATE_SUSPENDED`, restricts inherited handles to
the three standard-I/O pipes, and uses `PROC_THREAD_ATTRIBUTE_JOB_LIST` to place the process in its
preconfigured Job Object atomically during `CreateProcessW`. It then resumes the primary thread.
The Job Object applies both per-process and total-job memory limits, an active process limit, and
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. ProcessHost does not emit `exited` until the root process has
stopped and the Job Object reports no active processes.

Resource observations are an optional protocol extension. The Worker client enables them only
when configured with `captureResourceUsage: true`, which adds `spec.captureResourceUsage: true`
to each start request. The Worker environment switch is
`WORKER_PROCESS_HOST_RESOURCE_DIAGNOSTICS=true`; it defaults to false. Enable it only with a
ProcessHost binary built with this extension. An older binary rejects the explicitly requested
extension. Ordinary start requests and exit events retain their previous format.

For opted-in requests, an `exited.resourceUsage` object can contain:

- `peakJobMemoryBytes`: peak aggregate Job memory reported by Windows.
- `peakProcessMemoryBytes`: the largest memory peak of any single process ever associated with
  the Job, including processes that have exited. This is not restricted to the root process.
- `activeProcesses`: an object with `sampledPeak`, successful `sampleCount`, and
  `sampleIntervalMs: 250`. The host samples while waiting for the root and once before closing the
  Job handle. This interval is a target cadence; scheduling and termination can change the actual
  spacing. The sampled maximum can miss transient peaks.

Memory peaks are queried from `JobObjectExtendedLimitInformation` before the Job handle closes;
they are maintained by Windows, independently of active-process sampling. Failed queries omit
the affected observations. If all observations are unavailable, `resourceUsage` is omitted.
Diagnostic failure never changes the exit code or the existing tree-drain and handle-cleanup
requirements. These values contain no command text, environment values, or process paths.

The observations do not establish whether a memory or process-count limit was reached. A failed
allocation can leave the recorded peak below a limit, and an active-process sample can miss a
brief attempted launch. Do not interpret these memory fields as RSS or working-set measurements.
See Microsoft's [extended limit information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information),
[basic accounting information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information),
and [Job query API](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject).

A Job Object is a lifetime and resource-control mechanism, not a security boundary for malicious
code running under the same Windows token. The current Worker therefore admits only code that the
deployment treats as trusted. ProcessHost still provides deterministic cleanup and resource limits,
but it must not be described as hostile-code containment.

## Opt-in crash recovery ownership

The Worker opts in with `namedJobRecovery: true`, which supplies `--named-job-recovery`.
After acquiring its instance mutex, the Host opens or creates
`Global\AgenticReview.Worker.Recovery.v1.<instance-key>`, terminates any previous members,
and waits for the aggregate active-process count to reach zero. For an existing Job, it closes
the drained handle, waits for the old name to disappear, and creates a fresh same-named Job before joining it.
An external handle retaining the previous Job blocks startup within the same 15-second budget
used for drain; it never permits reusing a terminated Job or publishing unproved readiness.
The raw creation call preserves `ERROR_ALREADY_EXISTS`, which distinguishes an existing Job
from a fresh container. Any open, limit, termination, query, drain, close, or assignment error
aborts startup without recovery evidence. Child creation atomically assigns the outer recovery Job before the
per-request resource Job. Neither Job permits breakaway, and their handles are excluded
from the inherited handle list.

The `ready.capabilities.namedJobRecovery` object contains `capability: "named-job-tree-v1"`,
the exact `instanceKey`, a fresh random `generation`, and `previousTreeDrained: true`.
The Host retains its non-inheritable recovery handle until Windows closes it at process
exit; explicitly closing the last handle while running would kill the Host itself.
Normal shutdown still drains each request and returns its normal exit code.

Windows retains a Job until all handles have closed and all associated processes have
terminated; kill-on-close terminates the associated processes before destroying the Job.
That lifetime rule makes a newly created name meaningful only for a previous journal that
already records this containment capability. A validated subsequent generation with the same
instance key proves the previous Host and its process trees exited. A legacy journal, PID
absence, or acquiring the singleton mutex alone never proves a complete process-tree cleanup.
This startup receipt says nothing about desktop restoration and cannot authorize test replay.
It covers the Host and Job member trees; a service or WMI broker that creates processes outside
that tree requires separate ownership and cleanup evidence.
Without the flag, the legacy ready payload and launcher remain unchanged. An older binary
rejects the opt-in flag rather than silently supplying unproved recovery.

The underlying contracts are Microsoft's [Job Object lifetime and containment rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[named Job creation and existing-object result](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createjobobjecta),
[ordered process-creation Job list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
and [nested Job accounting and termination](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).

## Windows verification

Run the module tests serially on Windows:

```powershell
go test -buildvcs=false -count=1 -p 1 -timeout 5m ./...
go vet -buildvcs=false -p 1 ./...
```

The Windows integration test launches the Go test helper through the production `CreateProcessW`
path, observes it in the configured Job Object while it is blocked on standard input, then verifies
standard-I/O closure, process exit, Job drain, and handle cleanup. A second test has that helper
spawn a real descendant, verifies both PIDs belong to the Job, terminates the Job, and confirms the
root, descendant, and Job all reach their terminal state without a residual process.

The named recovery tests additionally verify normal exit of a Host contained in its own
kill-on-close Job. The crash fixture retains both the outer and per-request Job handles so a
root and grandchild deliberately survive the old Host; the replacement Host must drain those
exact process handles and the outer Job before the fixture releases its retained references.
No readiness may appear while the old Job name is retained. Only a newly created container
permits the new recovery generation; another test holds the old name until startup fails
without proof. These tests need Windows and must run in the designated verification environment.

## Opt-in interactive standard input

Start the Host with `--interactive-stdin` only when its client supports the versioned extension.
The default ready event, noninteractive started event and one-shot `standardInput` write/EOF
behavior are unchanged. Interactive launches require `spec.interactiveStdin: true`; they cannot
also contain `standardInput`, including an empty string. There is no automatic fallback to an
older Host. The enabled ready capability is exactly:

```json
{"interactiveStdin":{"version":1,"maximumChunkBytes":65536,"maximumTotalBytes":8388608,"maximumOperations":1024,"maximumPendingOperations":1,"writeTimeoutMs":10000}}
```

Each interactive `started` event adds a fresh 64-character lowercase hexadecimal `stdinStreamId`.
Both `stdin_write` and `stdin_close` identify the start request, stream generation and next sequence
number. Sequences begin at one, include close, and are independent of output stream sequence numbers.
Writes carry canonical padded base64 for 1–65,536 arbitrary bytes; splitting a UTF-8 frame across
chunks is valid. Accepted writes total at most 8 MiB and accepted operations total at most 1,024.
Only one operation may await pipe completion. A committed result may be publishing while the next
operation is admitted, but the single writer publishes that result before executing the next one.
Admission failures do not advance the sequence; accepting close immediately prevents later writes.

Every operation returns `stdin_result` with the exact request/stream/sequence/operation tuple.
Success means only that bytes reached the pipe or EOF close completed. It does not mean that the
child parsed, accepted or executed an application request. Partial failure, write timeout or close
failure stops the affected process without replaying data. Internal failure does not emit an
unsolicited `terminated(cancelled)` event; the correlated input result explains the failure.
Zero observed written bytes on failure does not establish that the child received no bytes.

The controller uses three fixed goroutines per interactive process: writer, pipe closer and
deadline observer. Child pipe I/O does not occupy the Host control loop. `os.File.Close()` cancels
pending Windows pipe I/O through the Go runtime; raw handles are never closed behind `os.File`.
Every accepted input result finishes publication before `exited`. Normal EOF-driven exit preserves
a completed close, and a late deadline cannot cancel an operation whose completion already won.
The Host's existing synchronous stdout emitter is a separate backpressure boundary: clients must
continue draining protocol output. This extension does not make that output queue unbounded.

The `TestInteractiveInputWindows*` tests use only the owned Go test helper. They exercise real
blocked Windows pipe writes while another process remains controllable, the advertised ten-second
write timeout, explicit termination, byte-exact multi-chunk input and EOF. A duplicated Job Object
handle independently verifies zero remaining processes; all original pipe/process handles must
be closed. They invoke neither Codex nor a model, repository command, account setup or firewall
change. Interactive input alone does not establish command/network isolation or enable evaluation
model execution. The complete wire contract is in
[`docs/design/2026-09-08-process-host-interactive-stdin.md`](../../docs/design/2026-09-08-process-host-interactive-stdin.md).
