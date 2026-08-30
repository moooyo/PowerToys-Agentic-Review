# AgenticReview ServiceHost

`AgenticReview.ServiceHost.exe` is the native platform boundary planned for the split Windows
Control and Executor services. It is a small Go adapter. Scheduling, leases, repository policy,
prompt construction, result validation, and publication remain in TypeScript.

This directory currently contains only the first fail-closed foundation:

- a strict canonical JSON configuration contract;
- the structural 48-byte ARWX frame boundary;
- a byte-bounded bidirectional relay core;
- platform interfaces and explicit unsupported-platform implementations; and
- pure Go tests for those contracts.

The Windows identity, process and token DACL, Job Object, Named Pipe, CNG, pinned-file, and Node
launch adapters are not implemented yet. Both the Windows and non-Windows platform factories return
an error. This binary therefore cannot launch a Worker payload and must not be used to enable
production execution.

## Command line

The only accepted forms are:

```text
AgenticReview.ServiceHost.exe --config C:\Program Files\AgenticReview\config\control-service-host.json
AgenticReview.ServiceHost.exe --version
```

`--config=<path>` is also accepted. Positional arguments, single-dash options, repeated options,
environment overrides, and child-process arguments are rejected. The eventual Windows adapter will
construct the Node command line itself from the pinned executable and bundle fields.

## Configuration

Configuration is canonical UTF-8 JSON without a byte-order mark, whitespace, duplicate keys,
unknown properties, trailing bytes, or alternative number spellings. The complete document is
limited to 64 KiB. Windows paths are lexical local-drive paths and are verified again by the future
handle-based Windows security adapter.

```json
{"schemaVersion":1,"role":"control","ownService":{"name":"AgenticReview.Worker.Control"},"peerService":{"name":"AgenticReview.Worker.Executor"},"pipeName":"\\\\.\\pipe\\AgenticReview.Worker.ControlExecutor.v1","installation":{"root":"C:\\Program Files\\AgenticReview\\Worker","manifestPath":"C:\\Program Files\\AgenticReview\\Worker\\release-manifest.json","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"node":{"executablePath":"C:\\Program Files\\AgenticReview\\Worker\\runtime\\node.exe","executableSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bundlePath":"C:\\Program Files\\AgenticReview\\Worker\\app\\control.mjs","bundleSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","workingDirectory":"C:\\ProgramData\\AgenticReview\\Control","environment":{"NODE_ENV":"production","PATH":"C:\\Program Files\\AgenticReview\\Worker\\runtime","SYSTEMROOT":"C:\\Windows","TEMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","TMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","USERPROFILE":"C:\\ProgramData\\AgenticReview\\Control\\Profile"}},"limits":{"rootJobMaximumProcesses":128,"rootJobMaximumMemoryBytes":"17179869184","maximumFrameBytes":1048576,"maximumQueuedBytesPerDirection":4194304,"connectTimeoutMilliseconds":30000,"shutdownTimeoutMilliseconds":120000}}
```

The environment object is the eventual Node replacement environment, not an overlay on the
ServiceHost environment. It uses a role-specific allowlist; unknown variables and variables that
can inject Node, TLS, proxy, or OpenSSL startup behavior are rejected. Application configuration
and secrets will use separate typed, protected inputs rather than arbitrary environment values.
No Server lease token, private key bytes, arbitrary executable path from Control, or free-form
command belongs in this configuration.

Lexical environment-path validation is not sufficient for execution. The Windows adapter must
bind `PATH` to manifest or trusted system directories, bind profile and temporary paths to the
selected role's protected data root, and verify every directory by handle, volume identity, and
DACL before launching Node.

The Windows build currently rejects every configuration before opening it because the native
handle-bound NTFS, file-ID, reparse-point, hard-link, owner, and DACL reader is not implemented.
The ordinary `os.Open` reader exists only for non-Windows contract tests.

## Framing and relay

The framing package checks only the native transport boundary: magic, fixed header length, version,
known message ID range, zero flags and reserved fields, positive sequence, declared payload length,
and the 1 MiB frame ceiling. Canonical JSON, exact sequence progression, correlation semantics,
message schemas, signatures, and execution capabilities remain the responsibility of
`@agentic-review/local-protocol`.

Each relay direction uses a byte reservation. A dequeued frame remains charged until the writer
calls `Release`, so a slow write cannot silently exceed the configured queue budget. The relay
requires endpoints whose `ReadFrame` and `WriteFrame` calls return when their context is cancelled
or `Close` is called.

Relay shutdown has a hard deadline. A shutdown timeout is host-fatal: the process must exit and let
WinSW recovery create a fresh host; the same process must never reconnect or reuse endpoints whose
closure was not confirmed. The timeout result retains the primary transport failure and every
close failure observed before the deadline.

## Verification

Run verification outside the developer workstation according to the repository test policy:

```powershell
go test -count=1 ./...
go test -count=1 -race ./...
go vet ./...

$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
go build -trimpath .
$env:GOARCH = 'arm64'
go build -trimpath .
Remove-Item Env:GOOS, Env:GOARCH
```

Cross-compilation is not Windows security evidence. Production enablement still requires native
Windows x64 and arm64 token, DACL, Named Pipe, Job Object, process-tree, tamper, and failure tests.
