# AgenticReview ServiceHost

`AgenticReview.ServiceHost.exe` is the native platform boundary planned for the split Windows
Control and Executor services. It is a small Go adapter. Scheduling, leases, repository policy,
prompt construction, result validation, and publication remain in TypeScript.

This directory contains the fail-closed foundation and reviewed, unconnected Windows building
blocks:

- a strict canonical JSON configuration contract;
- the structural 48-byte ARWX frame boundary;
- a byte-bounded bidirectional relay core;
- a first-instance, remote-rejecting message-mode Named Pipe endpoint;
- persisted CNG P-256 signing with non-exportability and signing-only policy checks;
- handle-bound NTFS object, volume, and protected-DACL evidence;
- a fixed-origin TLS 1.3 Worker API client that accepts a non-exportable signer;
- suspended Node launch with an inherited-handle allowlist, a non-breakaway root Job, exact
  pre-resume process and primary-token DACLs, and stable WinSW wrapper observation;
- platform interfaces and an explicit unavailable production platform factory; and
- pure Go tests for those contracts.

Secure configuration loading, complete ancestor validation, caller-token and service-SID
verification, peer lineage/image/Authenticode verification, certificate-store composition,
role-local RPC, and final platform orchestration are not implemented yet. Both the Windows and
non-Windows production platform factories therefore return an error. This binary cannot launch a
Worker payload and must not be used to enable production execution.

## Command line

The only accepted forms are:

```text
AgenticReview.ServiceHost.exe --config C:\ProgramData\AgenticReview\TrustedConfig\control-service-host.json
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

The schema version 2 Control document is:

```json
{"schemaVersion":2,"role":"control","ownService":{"name":"AgenticReview.Worker.Control","sid":"S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"},"peerService":{"name":"AgenticReview.Worker.Executor","sid":"S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"},"pipeName":"\\\\.\\pipe\\AgenticReview.Worker.ControlExecutor.v1","installation":{"root":"C:\\Program Files\\AgenticReview\\Worker","trustedConfigurationRoot":"C:\\ProgramData\\AgenticReview\\TrustedConfig","releaseId":"worker-2026.08.31.1","manifestPath":"C:\\Program Files\\AgenticReview\\Worker\\release-manifest.json","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedAuthenticodeSignerCertificateDerSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"node":{"executablePath":"C:\\Program Files\\AgenticReview\\Worker\\runtime\\node.exe","executableSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bundlePath":"C:\\Program Files\\AgenticReview\\Worker\\app\\control.mjs","bundleSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","dataRoot":"C:\\ProgramData\\AgenticReview\\Control","workingDirectory":"C:\\ProgramData\\AgenticReview\\Control\\Work","environment":{"NODE_ENV":"production","PATH":"C:\\Program Files\\AgenticReview\\Worker\\runtime","SYSTEMROOT":"C:\\Windows","TEMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","TMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","USERPROFILE":"C:\\ProgramData\\AgenticReview\\Control\\Profile"}},"control":{"serverOrigin":"https://review.example.test","serverName":"review.example.test","rootCertificatePath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\server-root.cer","rootCertificateSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","clientCertificateStore":"MY","clientCertificateDerSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","clientPrivateKeySecurityDescriptorSha256":"0000000000000000000000000000000000000000000000000000000000000000","localAuthorityCngKeyName":"AgenticReview.Worker.Control.LocalAuthority","localAuthorityKeySecurityDescriptorSha256":"9999999999999999999999999999999999999999999999999999999999999999","localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111"},"executor":null,"limits":{"rootJobMaximumProcesses":128,"rootJobMaximumMemoryBytes":"17179869184","maximumFrameBytes":1048576,"maximumQueuedBytesPerDirection":4194304,"connectTimeoutMilliseconds":30000,"shutdownTimeoutMilliseconds":120000}}
```

The matching Executor document uses the same release and pipe identity, reverses the service
identities, and exposes only public policy and executable inputs:

```json
{"schemaVersion":2,"role":"executor","ownService":{"name":"AgenticReview.Worker.Executor","sid":"S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"},"peerService":{"name":"AgenticReview.Worker.Control","sid":"S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"},"pipeName":"\\\\.\\pipe\\AgenticReview.Worker.ControlExecutor.v1","installation":{"root":"C:\\Program Files\\AgenticReview\\Worker","trustedConfigurationRoot":"C:\\ProgramData\\AgenticReview\\TrustedConfig","releaseId":"worker-2026.08.31.1","manifestPath":"C:\\Program Files\\AgenticReview\\Worker\\release-manifest.json","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedAuthenticodeSignerCertificateDerSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"node":{"executablePath":"C:\\Program Files\\AgenticReview\\Worker\\runtime\\node.exe","executableSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bundlePath":"C:\\Program Files\\AgenticReview\\Worker\\app\\executor.mjs","bundleSha256":"4444444444444444444444444444444444444444444444444444444444444444","dataRoot":"C:\\ProgramData\\AgenticReview\\Executor","workingDirectory":"C:\\ProgramData\\AgenticReview\\Executor\\Work","environment":{"CODEX_HOME":"C:\\ProgramData\\AgenticReview\\Executor\\Codex","GCM_INTERACTIVE":"never","GIT_CONFIG_NOSYSTEM":"1","GIT_TERMINAL_PROMPT":"0","NODE_ENV":"production","PATH":"C:\\Program Files\\AgenticReview\\Worker\\runtime","SYSTEMROOT":"C:\\Windows","TEMP":"C:\\ProgramData\\AgenticReview\\Executor\\Temp","TMP":"C:\\ProgramData\\AgenticReview\\Executor\\Temp","USERPROFILE":"C:\\ProgramData\\AgenticReview\\Executor\\Profile"}},"control":null,"executor":{"localAuthorityPublicKeyPath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\local-authority.spki","localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111","codexPolicyPath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\codex-requirements.toml","codexPolicySha256":"2222222222222222222222222222222222222222222222222222222222222222","processHostPath":"C:\\Program Files\\AgenticReview\\Worker\\bin\\AgenticReview.ProcessHost.exe","processHostSha256":"3333333333333333333333333333333333333333333333333333333333333333"},"limits":{"rootJobMaximumProcesses":128,"rootJobMaximumMemoryBytes":"17179869184","maximumFrameBytes":1048576,"maximumQueuedBytesPerDirection":4194304,"connectTimeoutMilliseconds":30000,"shutdownTimeoutMilliseconds":120000}}
```

Service names, service SIDs, role, and pipe name are a fixed production combination. Exactly one
of `control` and `executor` is an object for the selected role; the other property is explicitly
`null`. The release manifest and approved Authenticode signer certificate digest bind both
documents to one installed package. The Control origin is a canonical HTTPS origin with no user
information, path, query, fragment, or explicit default port, and `serverName` must equal its host.
The client certificate store is fixed to the Windows `MY` store. No certificate or private-key
bytes, CNG handle, mTLS key name, or provider selector is accepted in configuration. The mTLS
credential is selected only by the configured certificate DER digest. The expected raw security
descriptor digests bind the reviewed ACLs of both private keys. Native preflight fixes both keys to
the machine-scope Microsoft Software Key Storage Provider, proves they are non-exportable and
Control-only, and rejects reuse of one key for both mTLS and local-authority signing.

The immutable manifest, executables, Node payloads, and ProcessHost are strict descendants of
`installation.root`. Administrator-managed CA material, the local-authority public key, and the
machine-enforced Codex policy are strict descendants of `installation.trustedConfigurationRoot`.
That root, the installation tree, and `node.dataRoot` are pairwise disjoint. The working, temporary,
profile, application-data, Codex, home, and Git configuration paths are strict descendants of that
role's data root. Every `PATH` entry is inside the installation tree. Native preflight must
additionally prove the configured ownership, DACL, volume, reparse-point, file identity, manifest
membership, and Authenticode claims before use. The platform adapter must also prove that the
actual `--config` file is below the configured trusted-configuration root after parsing it.

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

The Windows build currently rejects every configuration before opening it because the handle-bound
reader has not yet been composed with complete ancestor traversal, expected ACL policy, manifest
verification, and the production platform factory. The ordinary `os.Open` reader exists only for
non-Windows contract tests.

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
