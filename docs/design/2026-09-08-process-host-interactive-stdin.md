# Opt-in interactive ProcessHost input

Status: implemented and verified with native helpers and a same-process Codex metadata session.
This enables app-server RPC; it does not accept model execution, enable evaluation claims, or
establish command/network isolation. Production task/session composition remains outstanding.

## Transport decision

Use the existing Job Object and dedicated stdio pipes. The pinned Codex 0.145.0 app-server exits
its single-client stdio mode after stdin EOF. WebSocket would add a listener, capability-token
authentication and a dynamically assigned address exposed through a human-readable stderr banner.
Its last-client disconnect does not terminate the server. In either case, only the ProcessHost
exit/stream lifecycle can establish process-tree cleanup.

## Explicit opt-in and compatibility

ProcessHost receives a new `--interactive-stdin` flag. Without it, its ready event and existing
single-shot input lifecycle remain unchanged. A new Worker requests the flag only through an
explicit `interactiveStdin: true` client option. An old Host that rejects the flag is unsupported;
there is no silent retry without it. Existing default clients continue using existing binaries.

The extension uses protocol version `1.0` and advertises its own versioned capability only when
enabled:

```json
{
  "interactiveStdin": {
    "version": 1,
    "maximumChunkBytes": 65536,
    "maximumTotalBytes": 8388608,
    "maximumOperations": 1024,
    "maximumPendingOperations": 1,
    "writeTimeoutMs": 10000
  }
}
```

The field is nested inside `ready.capabilities`. Exact values are part of this extension's
contract. A client must observe the capability before sending any interactive launch. A launch
uses `spec.interactiveStdin: true`, mutually exclusive with `spec.standardInput` even when that
string is empty. The Host rejects interactive launches if its extension is disabled.

An interactive `started` event contains `stdinStreamId`, a cryptographically random lowercase
64-hex identifier generated for that process instance. Noninteractive starts omit it. This
prevents delayed input from reaching a later process that reuses a request ID. The client must
receive exactly the requested input mode before exposing a process handle.

## Wire operations

```json
{"protocolVersion":"1.0","type":"stdin_write","requestId":"process:example","stdinStreamId":"<64 lowercase hex characters>","sequence":1,"dataBase64":"e30K"}
{"protocolVersion":"1.0","type":"stdin_close","requestId":"process:example","stdinStreamId":"<same stream ID>","sequence":2}
```

Sequences start at one and are independent of stdout/stderr output sequence numbers. Write data
is canonical padded base64 for 1 through 65,536 bytes. Input is bytes, so a UTF-8 RPC frame may be
split across chunks. At most one operation is pending per process; the Host control loop performs
only validation and nonblocking admission, never the child pipe write or close. Invalid stream,
wrong sequence, busy, closed and exceeded-budget operations do not advance the accepted sequence.
Accepted writes and close share the 1,024-operation budget; cumulative accepted write bytes cannot
exceed 8 MiB. Close admission immediately prevents later writes.

Each operation has one result:

```json
{"protocolVersion":"1.0","type":"stdin_result","requestId":"process:example","stdinStreamId":"<same stream ID>","sequence":1,"operation":"write","status":"succeeded","bytesWritten":3,"code":null}
```

`operation` is `write` or `close`; `status` is `succeeded` or `failed`. A successful write reports
the exact submitted byte count; successful close reports zero. Success has `code: null`. Failed
results report actual observed partial bytes, from zero through the requested chunk size, and one
of these codes:

- `STDIN_NOT_ENABLED`
- `STDIN_PROCESS_NOT_FOUND`
- `STDIN_PROCESS_NOT_RUNNING`
- `STDIN_STREAM_MISMATCH`
- `STDIN_SEQUENCE_MISMATCH`
- `STDIN_BUSY`
- `STDIN_CLOSED`
- `STDIN_LIMIT_EXCEEDED`
- `STDIN_PROCESS_EXITED`
- `STDIN_WRITE_FAILED`
- `STDIN_WRITE_TIMEOUT`
- `STDIN_CLOSE_FAILED`
- `STDIN_CANCELLED`

Admission rejection has zero written bytes. A partial write, write failure or timeout terminates
the affected process; no payload is retried. Zero observed written bytes does not prove the child
received nothing. A successful acknowledgement proves only completion of the pipe operation,
not parsing, application acceptance or execution of the JSON-RPC request.

## Native lifecycle

Use a per-process input controller with fixed, bounded workers/queues. A blocked pipe write must
not block another process's control requests, cancellation or shutdown while the Worker continues
draining Host output. Never perform pipe Close or event emission while holding lifecycle/input
locks. Do not spawn an unbounded goroutine for each request or rejection.

Use the existing Go pipe's `os.File.Close()` to interrupt pending Windows I/O; the installed Go
runtime uses `CancelIoEx` for pipe close. Do not use thread-affine `CancelIo` or close the raw
handle behind `os.File`. Close can itself wait for the writer, so it belongs outside the control
loop and locks. Final `process.Close()` must remain idempotent.

An independent input-stop signal is required. Waiting only for `managedProcess.done` would
deadlock because that signal currently follows `streams.Wait()`. After process Wait returns,
and on termination/timeout, stop input admission and release the input worker before waiting for
all streams. Every accepted input operation must finish emitting its result before that process's
`exited` event. Idle interactive input must not prevent normal process exit.

Stopping after spontaneous process exit must not invalidate an already completed pipe write or
successful EOF close merely because their result publication races with the exit observation.
Conversely, a queued operation that never wrote cannot be reported as successful.

The existing synchronous Host output emitter is a separate backpressure boundary. This change
does not claim that a Worker which stops draining the Host's protocol output can keep issuing
commands indefinitely. The client still bounds Host control-pipe writes and fails/terminates the
Host when that transport becomes unusable.

## Worker API and lifecycle

`ManagedProcess.stdin` is optional and exists only for a verified interactive start:

```ts
interface ManagedProcessStandardInput {
  readonly streamId: string;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}
```

Write captures bytes before its first await. Calls are not queued: a concurrent operation fails
locally without sending another frame. Repeated close returns the same operation promise. Never
automatically resend an operation after transport uncertainty, timeout or cancellation.

The client validates exact request/stream/sequence/operation identity, result status and byte
count. A malformed or impossible Host event remains a protocol failure. A legitimate input
failure/timeout cancels only its process and continues draining; it must not reuse the generic
Host-fatal deadline helper. Escalation to Host failure is reserved for a broken control transport
or inability to terminate/drain.

An exit that races ahead of a rejected input request cannot resolve `completed` successfully
while its acknowledgement is unsettled. Retain bounded request/stream acknowledgement state,
release PID ownership at the actual exit, and settle completion after the exact result or a
bounded timeout. Late-result handling must have both a capacity and lifetime bound; PID reuse
must not let delayed finalization remove a newer process's ownership entry.

## Verification required

- Default ready/launch behavior, single-shot stdin and legacy tests remain valid.
- Both parsers reject malformed, ambiguous, oversized and inconsistent extension messages.
- Byte mutation, interleaving, sequence/stream mismatch, duplicate close and budget boundaries
  are covered in the Worker client and native controller.
- Cancellation, timeout, partial writes, exit-before-result and late-result races settle once
  and retain process/stream cleanup without replaying bytes.
- On Windows, a real helper that does not read stdin fills the pipe while another process remains
  controllable. Timeout and explicit termination release the blocked writer; accepted input results
  precede exited, the Job Object empties, and handles close. Fake writers cannot replace this test.
- A bounded same-process app-server metadata exercise through the new ProcessHost transport
  verifies real bidirectional input and EOF/process closure without a model turn or sandbox setup.

All fixtures are owned synthetic data. No real PR/Issue mutation is authorized by these checks.

## Verification outcome

The corrected source passed 2,231 Worker tests with 28 conditional skips, type checking and build.
Windows native tests/vet and amd64/arm64 builds passed; Linux native tests also passed with the
race detector. Real Windows blocked-write, peer-control, timeout, EOF and handle/Job cleanup cases
passed. The new Host and Worker transport completed eight metadata RPCs against the pinned Codex
0.145.0 process and then confirmed EOF, both output streams, CLI exit 0 and Host exit 0.

The real integration exposed a writer ownership-handoff race. Its failed run and the separate
notification-consumer regression are retained; ownership release now occurs within each async
consumer loop. The final native source is unchanged from its earlier full verification.
See the [delivery evidence](../../artifacts/m32-evaluations-20260908/interactive-stdin-delivery-notes.md)
for exact source/binary digests, retained failures and acceptance boundaries.
