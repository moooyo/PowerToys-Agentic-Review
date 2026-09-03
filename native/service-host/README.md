# AgenticReview ServiceHost

`AgenticReview.ServiceHost.exe` is the native platform boundary planned for the split Windows
Control and Executor services. It is a small Go adapter. Scheduling, leases, repository policy,
prompt construction, result validation, and publication remain in TypeScript.

This directory contains the fail-closed foundation and a composed Windows runtime candidate:

- a strict canonical JSON configuration contract;
- a canonical dual-root release manifest and typed config-to-manifest binding evidence;
- the structural 48-byte ARWX frame boundary;
- a byte-bounded bidirectional relay core;
- a first-instance, remote-rejecting message-mode Named Pipe endpoint;
- handle-relative secure configuration traversal with owned AccessCheck tokens and final descriptor
  reinspection;
- exact restricted virtual-service identity and token preflight;
- persisted CNG P-256 signing and Local Machine mTLS certificate acquisition with fixed provider,
  non-exportability, exact key-DACL digests, detached key identities, and signing-only policy checks;
- handle-bound NTFS object, volume, and protected-DACL evidence;
- retained role-data verification with protected installer boundaries, exact inherited descendant
  ACLs, closed fixed layout, bounded content traversal, and final pre-launch reinspection;
- handle-bound, embedded-only Authenticode verification with an exact leaf-certificate pin;
- a fixed-origin TLS 1.3 Worker API client that accepts a non-exportable signer;
- a source-only fixed-origin TLS 1.3 Bearer client and strict reader for the fixed per-Worker
  `worker-auth-v1.json` profile, without a generic header or Token source;
- stable pipe-peer process, lineage, token, image-file, and signer-pin verification contracts;
- bounded canonical role-local RPC with cancellation, timeouts, and sanitized errors;
- suspended Node launch with an inherited-handle allowlist, a non-breakaway root Job, exact
  pre-resume process and primary-token DACLs, and stable WinSW wrapper observation;
- a per-launch HostControl endpoint with bounded overlapped-I/O ownership, cancellation,
  completion publication, cleanup, and fatal-operation quarantine;
- a sealed zero-execution Claim policy derived from the committed runtime bootstrap;
- a Control-only, bootstrap-bound `ShutdownRequested` notification serialized through the sole
  HostControl writer, with one absolute graceful deadline and forced termination only after that
  deadline or an earlier terminal failure;
- a Windows platform factory that composes the verified startup, relay, supervision, and cleanup
  chain, plus an explicitly unavailable non-Windows factory; and
- pure Go tests for those contracts.

The Windows factory now composes release authority, secure service bootstrap, current-image and
installation verification, role-owned data roots, role credentials, preflight, peer verification,
runtime bootstrap, guarded Node launch, HostControl, role-specific RPC, ARWX relay, lifecycle
supervision, and bounded cleanup. Ordinary builds intentionally contain no compiled production
release profile and fail closed before using installed configuration. The current TypeScript role
payloads remain zero-execution foundations: Executor can emit only the authenticated disabled
`Ready` state (`ready=false`, `availableSlots=0`, `reasonCode=EXECUTION_DISABLED`), and Control never
claims work. This source must not be used to enable production execution. The non-Windows production
factory remains unavailable.

The accepted per-Worker Bearer Token design is not selected by this production composition yet.
The committed exact role configuration is still schema version 3 and still identifies an mTLS
credential. Selecting the source-only Bearer constructor before a versioned replacement profile
would silently reinterpret that signed contract, so startup remains fail-closed on the existing
composition until that profile and its exact data-root layout are replaced together.

## Command line

The only accepted forms are:

```text
AgenticReview.ServiceHost.exe --config C:\ProgramData\AgenticReview\TrustedConfig\control-service-host.json
AgenticReview.ServiceHost.exe --version
```

`--config=<path>` is also accepted. Positional arguments, single-dash options, repeated options,
environment overrides, and child-process arguments are rejected. The Windows adapter constructs the
Node command line itself from the pinned executable and bundle fields.

## Configuration

Configuration is canonical UTF-8 JSON without a byte-order mark, whitespace, duplicate keys,
unknown properties, trailing bytes, or alternative number spellings. The complete document is
limited to 64 KiB. Windows paths are lexical local-drive paths; production composition must read
them through the included handle-relative Windows security adapter.

The schema version 3 Control document is:

```json
{"schemaVersion":3,"role":"control","workerNodeId":"powertoys-node:01","ownService":{"name":"AgenticReview.Worker.Control","sid":"S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"},"peerService":{"name":"AgenticReview.Worker.Executor","sid":"S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"},"pipeName":"\\\\.\\pipe\\AgenticReview.Worker.ControlExecutor.v1","installation":{"root":"C:\\Program Files\\AgenticReview\\Worker","trustedConfigurationRoot":"C:\\ProgramData\\AgenticReview\\TrustedConfig","releaseId":"worker-2026.08.31.1","manifestPath":"C:\\Program Files\\AgenticReview\\Worker\\release-manifest.json","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedAuthenticodeSignerCertificateDerSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"node":{"executablePath":"C:\\Program Files\\AgenticReview\\Worker\\runtime\\node.exe","executableSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bundlePath":"C:\\Program Files\\AgenticReview\\Worker\\app\\control.mjs","bundleSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","dataRoot":"C:\\ProgramData\\AgenticReview\\Control","workingDirectory":"C:\\ProgramData\\AgenticReview\\Control\\Work","environment":{"APPDATA":"C:\\ProgramData\\AgenticReview\\Control\\Profile\\AppData","LOCALAPPDATA":"C:\\ProgramData\\AgenticReview\\Control\\Profile\\LocalAppData","NODE_ENV":"production","PATH":"C:\\Program Files\\AgenticReview\\Worker\\runtime","SYSTEMROOT":"C:\\Windows","TEMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","TMP":"C:\\ProgramData\\AgenticReview\\Control\\Temp","USERPROFILE":"C:\\ProgramData\\AgenticReview\\Control\\Profile"}},"control":{"serverOrigin":"https://review.example.test","serverName":"review.example.test","rootCertificatePath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\server-root.cer","rootCertificateSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","clientCertificateStore":"MY","clientCertificateDerSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","clientPrivateKeySecurityDescriptorSha256":"0000000000000000000000000000000000000000000000000000000000000000","localAuthorityCngKeyName":"AgenticReview.Worker.Control.LocalAuthority","localAuthorityKeySecurityDescriptorSha256":"9999999999999999999999999999999999999999999999999999999999999999","localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111"},"executor":null,"limits":{"rootJobMaximumProcesses":128,"rootJobMaximumMemoryBytes":"17179869184","maximumFrameBytes":1048576,"maximumQueuedBytesPerDirection":4194304,"connectTimeoutMilliseconds":30000,"shutdownTimeoutMilliseconds":120000,"forceTerminationReserveMilliseconds":15000}}
```

The matching Executor document uses the same release and pipe identity, reverses the service
identities, and exposes only public policy and executable inputs:

```json
{"schemaVersion":3,"role":"executor","workerNodeId":"powertoys-node:01","ownService":{"name":"AgenticReview.Worker.Executor","sid":"S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"},"peerService":{"name":"AgenticReview.Worker.Control","sid":"S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"},"pipeName":"\\\\.\\pipe\\AgenticReview.Worker.ControlExecutor.v1","installation":{"root":"C:\\Program Files\\AgenticReview\\Worker","trustedConfigurationRoot":"C:\\ProgramData\\AgenticReview\\TrustedConfig","releaseId":"worker-2026.08.31.1","manifestPath":"C:\\Program Files\\AgenticReview\\Worker\\release-manifest.json","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedAuthenticodeSignerCertificateDerSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"node":{"executablePath":"C:\\Program Files\\AgenticReview\\Worker\\runtime\\node.exe","executableSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bundlePath":"C:\\Program Files\\AgenticReview\\Worker\\app\\executor.mjs","bundleSha256":"4444444444444444444444444444444444444444444444444444444444444444","dataRoot":"C:\\ProgramData\\AgenticReview\\Executor","workingDirectory":"C:\\ProgramData\\AgenticReview\\Executor\\Work","environment":{"APPDATA":"C:\\ProgramData\\AgenticReview\\Executor\\Profile\\AppData","CODEX_HOME":"C:\\ProgramData\\AgenticReview\\Executor\\Codex","GCM_INTERACTIVE":"never","GIT_CONFIG_GLOBAL":"C:\\ProgramData\\AgenticReview\\Executor\\Profile\\.gitconfig","GIT_CONFIG_NOSYSTEM":"1","GIT_TERMINAL_PROMPT":"0","HOME":"C:\\ProgramData\\AgenticReview\\Executor\\Profile","LOCALAPPDATA":"C:\\ProgramData\\AgenticReview\\Executor\\Profile\\LocalAppData","NODE_ENV":"production","PATH":"C:\\Program Files\\AgenticReview\\Worker\\runtime","SYSTEMROOT":"C:\\Windows","TEMP":"C:\\ProgramData\\AgenticReview\\Executor\\Temp","TMP":"C:\\ProgramData\\AgenticReview\\Executor\\Temp","USERPROFILE":"C:\\ProgramData\\AgenticReview\\Executor\\Profile"}},"control":null,"executor":{"localAuthorityPublicKeyPath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\local-authority.spki","localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111","codexPolicyPath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\codex-requirements.toml","codexPolicySha256":"2222222222222222222222222222222222222222222222222222222222222222","processHostPath":"C:\\Program Files\\AgenticReview\\Worker\\bin\\AgenticReview.ProcessHost.exe","processHostSha256":"3333333333333333333333333333333333333333333333333333333333333333"},"limits":{"rootJobMaximumProcesses":128,"rootJobMaximumMemoryBytes":"17179869184","maximumFrameBytes":1048576,"maximumQueuedBytesPerDirection":4194304,"connectTimeoutMilliseconds":30000,"shutdownTimeoutMilliseconds":120000,"forceTerminationReserveMilliseconds":15000}}
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

Both documents must contain the same `workerNodeId`. It is a 1-through-128-byte ASCII entity
identifier: the first byte is alphanumeric, and subsequent bytes may also use `.`, `_`, `:`, or
`-`. The ARWX frame and queue limits, connection timeout, total shutdown timeout, and force-
termination reserve must also match exactly across the pair.

`shutdownTimeoutMilliseconds` is the total shutdown budget.
`forceTerminationReserveMilliseconds` must be positive and strictly less than that total. ARWX and
HostControl use `shutdownTimeoutMilliseconds - forceTerminationReserveMilliseconds` as their
graceful interval; the Node root-Job launcher receives only the reserve for forced termination.
These intervals are sequential parts of one configured deadline, not two copies of the total.
The Control ServiceHost sends the original Unix-millisecond deadline once over HostControl. Control
maps it to a monotonic deadline without extending the local configured budget and copies the same
Unix deadline into `Drain`; Executor applies the same non-extending mapping. Executor HostControl
rejects `ShutdownRequested`, and native code never fabricates `Drain` or `Drained`.

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

### Per-Worker Bearer transport candidate

`internal/workertransport` contains the reusable Token-only transport selected by ADR 0025. Its
only production reader path is:

```text
C:\ProgramData\AgenticReview\Control\worker-auth-v1.json
```

The reader accepts one regular UTF-8 JSON file of at most 4 KiB with exactly `profileId`, `token`,
and `workerNodeId`. It rejects duplicate, unknown, missing, wrongly typed, malformed, trailing,
or byte-order-marked input. The Token must be exactly `arw1_` plus the canonical unpadded base64url
encoding of 32 bytes, and the profile Worker node ID must match the expected runtime Worker node.
No alternate path, environment variable, command-line argument, registry value, package member,
or local RPC field is accepted.

The Bearer client retains the existing private Server root pool, fixed `serverName`, TLS 1.3
minimum, proxy disablement, fixed routes, redirect rejection, byte bounds, deadlines, concurrency,
and lifecycle cancellation. It installs no TLS client certificate or client-signing callback and
adds exactly one `Authorization: Bearer <token>` header inside the private transport for every
Worker and artifact request. The Token, its SHA-256 digest, and the Authorization value are not
exposed by the parsed profile API, formatting, errors, response forwarding, runtime bootstrap,
HostControl, or Control-to-Executor RPC. Closing the client clears its retained Token bytes after
active requests drain.

This source-only capability is deliberately not a second positive production authentication path.
A later versioned role configuration and data-root profile must make the fixed file an exact
Control-only layout member and then replace, rather than coexist with, the schema-v3 mTLS
composition.

Both roles require `APPDATA` and `LOCALAPPDATA` below their role-owned profile. Executor also
requires `HOME`, `CODEX_HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_TERMINAL_PROMPT=0`, and `GCM_INTERACTIVE=never`. `GIT_CONFIG_GLOBAL` is a canonical file path
that must be a direct child of `HOME`; being somewhere else below the data root is not sufficient.

Lexical environment-path validation is not sufficient for execution. The Windows adapter must
bind `PATH` to manifest or trusted system directories, bind profile and temporary paths to the
selected role's protected data root, and verify every directory by handle, volume identity, and
DACL before launching Node.

## Runtime Authenticode policy

The Windows Authenticode verifier consumes the same already-open file handle used for image
identity and hashing. `WinVerifyTrust` receives `WTD_CHOICE_FILE`, that handle in
`WINTRUST_FILE_INFO.hFile`, a null path, and the PE subject GUID. There is no path reopen, catalog
fallback, detached signature, UI, or URL-reference input. Verification state is always closed with
`WTD_STATEACTION_CLOSE`, and a close failure makes the verification fail.

Runtime verification accepts exactly one embedded primary signature at index zero. Secondary and
nested signatures, multiple primary SignerInfo values, and a timestamp selected as the primary
signer fail closed. Timestamp countersigners may exist, but signer identity is the DER SHA-256 of
the chain leaf whose issuer and serial exactly match the verified primary SignerInfo. A timestamp
countersigner, CA certificate, unrelated PKCS#7 certificate, or signer from another signature can
never satisfy the configured leaf-certificate pin.

The digest policy is `sha256-only`. WinVerifyTrust receives
`CERT_STRONG_SIGN_PARA_OS_CURRENT`, and verification additionally requires the selected primary
SignerInfo digest OID and the same provider state's PE indirect-data digest OID to both be SHA-256.
The indirect digest must contain exactly 32 bytes, and a certificate chain carrying
`CERT_TRUST_HAS_WEAK_SIGNATURE` is rejected. Every reported countersigner is separately resolved
from the primary signer, required to be an error-free timestamp signer with a complete bounded
chain, and never used as the executable signer identity.

The runtime revocation evidence value is `runtime-cache-only-no-revocation-check`. WinVerifyTrust is
called with `WTD_REVOKE_NONE`, `WTD_REVOCATION_CHECK_NONE`, and
`WTD_CACHE_ONLY_URL_RETRIEVAL`; it performs no CRL or OCSP check and blocks trust-provider CRL and
AIA retrieval. The verifier supplies no URL reference. The release pipeline, installer, and
signer-pin rotation process must perform online code-signing revocation checks before authorizing a
release. Independently, the Server remains the live Worker revocation authority. The current
schema-v3 composition uses mTLS; its versioned ADR-0025 replacement will use the per-Worker Token
database state and can deny a revoked Worker regardless of its locally pinned executable signature.

The Windows platform factory is composed, but an ordinary build rejects startup while loading its
release authority because `compiled_unavailable.go` contains no production release template. A
release build must receive that template through the controlled release pipeline and build tag; no
runtime configuration, installed manifest, or environment variable can substitute for it. The
ordinary `os.Open` reader exists only for non-Windows contract tests.

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

The Windows inter-service endpoint returns the exact `io.EOF` sentinel only when a read observes
zero bytes with an unwrapped pipe-disconnect status and all OVERLAPPED cleanup succeeds. Partial,
wrapped, joined, or cleanup-bearing EOF observations remain terminal transport failures. The
Control-owned server endpoint also exposes a deadline-required `FlushThenClose`: it waits for
active I/O ownership to settle, uses `FlushFileBuffers` to prove the client consumed queued writes,
then disconnects and closes the handle. If that synchronous flush outlives its deadline, or an
abortive close arrives while it is in flight, the whole flush owner is retained in the
process-lifetime quarantine and the current ServiceHost must exit; no goroutine may race the flush
by closing the same handle.

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
The shutdown bridge has passed the Linux `test-env` source, bundle, activation, and lifecycle
matrices, but remains only a candidate until actual signed dual-role material, a production
installer, physical installation evidence, and the paired native Windows service-stop and
forced-termination matrix are complete.
