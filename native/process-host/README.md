# AgenticReview ProcessHost

`AgenticReview.ProcessHost.exe` is the Windows process-tree boundary used by the remote worker. It
accepts the versioned NDJSON protocol on standard input and emits protocol events only on standard
output. Diagnostics are written to standard error.

Build the Windows binary from this module:

```powershell
go build -trimpath -o AgenticReview.ProcessHost.exe .
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

A Job Object is a lifetime and resource-control mechanism, not a security boundary for malicious
code running under the same Windows token. The current Worker therefore admits only code that the
deployment treats as trusted. ProcessHost still provides deterministic cleanup and resource limits,
but it must not be described as hostile-code containment.

## Windows verification

Run the module tests serially on Windows:

```powershell
go test -count=1 -p 1 -timeout 5m ./...
go vet -p 1 ./...
```

The Windows integration test launches the Go test helper through the production `CreateProcessW`
path, observes it in the configured Job Object while it is blocked on standard input, then verifies
standard-I/O closure, process exit, Job drain, and handle cleanup. A second test has that helper
spawn a real descendant, verifies both PIDs belong to the Job, terminates the Job, and confirms the
root, descendant, and Job all reach their terminal state without a residual process.
