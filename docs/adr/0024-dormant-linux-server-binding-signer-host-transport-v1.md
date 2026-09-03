# ADR 0024: Dormant Linux Server Binding Signer Host Transport v1

## Status

Superseded by ADR 0025 on 2026-09-03. Production Worker authentication no longer requires a receipt
signer, signer-host child process, or the Linux signer-host verification matrix.

This decision defines only a dormant, process-isolated transport foundation for the Server binding
signer. It does not select or load a production private-key backend, compile production trust,
modify production configuration or `main.ts`, initialize the issuer singleton, register an HTTP
route, or grant Worker authentication, Claim, slot, installation, package, or execution authority.

## Context

ADR 0022 fixes the signed receipt and active-status document profiles. ADR 0023 implements the
dormant S1 persistence aggregate and an unavailable-by-default signer boundary. S1 deliberately
requires the signing provider to be asynchronous, cancellable, single-owned, and closed only after
its owner exit is proved. A synchronous native, HSM, PKCS#11, or remote-KMS SDK call inside the
Fastify process could block the event loop and prevent its own timeout, cancellation, or cleanup.

The Server runs as one Linux process or container replica. The existing Worker ProcessHost protocol
is an execution authority with broad process-launch semantics and must not be reused for signing.
The signer needs a smaller protocol that can express only the two S0 statement profiles, exposes no
general digest or byte-signing oracle, carries no private key or backend credential, and makes one
child process the explicit lifetime owner.

The protected private-key store, child executable release profile, independently compiled
production trust artifact, service identity, parent-death enforcement, backup, rotation, and
compromise procedure still require separate decisions. Combining those choices with the transport
would make the first review depend on deployment-specific security boundaries. Implementing S2
first would be worse: it would expose enrollment policy and routes before a production signer and
trust chain exist.

## Decision

### Delivery sequence

The required order is:

```text
A. dormant signer-host transport
-> B. protected key backend + compiled trust + signed host release
-> C. S2 enrollment authority and routes
```

This ADR governs A only. B and C remain blocked and separately reviewed.

### Implementation boundary

The A implementation slice may add or modify only the following production areas, their focused
tests, architecture guards, and documentation:

```text
apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts
apps/server/src/enrollment/server-binding-signer-host-client-v1.ts
apps/server/src/enrollment/server-binding-signer-host-profile-v1.ts
apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts
apps/server/src/enrollment/server-binding-signer-provider-v1.ts
apps/server/src/enrollment/server-binding-signer-v1.ts
apps/server/src/enrollment/server-binding-coordinator-v1.ts
packages/contracts/src/server-binding-authority-v1.test.ts
```

A source-excluded test child may live below:

```text
apps/server/testdata/server-binding-signer-host-fixture-v1.mjs
```

Any native signer host, protected key reader, production trust generator, Server release profile,
configuration field, `main.ts` import, route, database change, Worker change, Dashboard change, or
additional production consumer belongs to B or C and requires separate review.

The transport modules remain package-private. They are not exported from a package barrel or
`apps/server/package.json`. The production provider, host profile, and trust loaders continue to
return unavailable.

### Threat boundary

The transport isolates event-loop availability, native-library stalls, accidental private-key byte
handling, protocol authority, and child lifetime from the Fastify process. It is not by itself a
security boundary against root, the deployment supervisor, or a fully compromised Server identity.
Whether B must resist a compromised same-UID Server process is a separate key-backend decision.

The child is not a sandbox for arbitrary code. Its executable and key backend must later be trusted
release inputs. This ADR ensures that even a valid transport client cannot ask that executable to
sign an arbitrary caller-selected algorithm, domain, digest, or byte string.

### One private child owner

One signer-host client owns exactly one direct child process for its entire lifetime. The v1 client:

- never pools children;
- never shares a child between Server processes;
- accepts at most one signing request at a time;
- never automatically respawns in the same Server process; and
- treats unexpected exit, timeout, protocol corruption, or output overflow as terminal.

The client exposes both a read-only `terminalFailure` Promise and a synchronous
`readTerminalError()` snapshot. The Promise resolves exactly once with the first unexpected terminal
error and never rejects; orderly close does not resolve it. The provider and signer context retain
both facts.

Signer adoption atomically installs the Promise reaction and then reads the synchronous snapshot
without yielding a microtask. A non-null snapshot rejects adoption and leaves the one-shot database
handle unconsumed. If failure occurs after the snapshot, the already-installed reaction propagates
the same first error. The coordinator installs its signer-terminal reaction before database
initialization or authority publication and checks the signer terminal snapshot before and after
every awaited startup operation. An idle child exit, protocol error, stdout/stderr overflow, or
write failure therefore fail-stops a test-composed S1 coordinator instead of waiting for another
signing call. Tests cover a failure already latched before adoption without yielding a microtask and
require zero database requests. Production Server fail-stop wiring remains a B activation gate.

The A client fixes only these process-API mechanics:

```text
shell = false
detached = false
stdin = pipe
stdout = pipe
stderr = pipe
extra inherited handles = none
working directory = fixed protected empty directory
environment = exact replacement allowlist
arguments = fixed protocol mode only
```

A test client inherits the test runner's OS identity and makes no UID, GID, supplementary-group,
capability, namespace, seccomp, cgroup, or credential-isolation claim. B must freeze the complete
production process and credential profile before enabling this spawn path. The mechanics above do
not imply that ambient Linux credentials are safe to inherit.

No production-reachable request, runtime option, database row, environment fallback, HTTP input,
test hook, or package document can choose the executable, arguments, working directory, environment,
signer key, trust key, algorithm, or operation set. The production client has no injectable spawn constructor,
mutable registration hook, reflective attachment, or exported spawn adapter. Its independent
signer-host profile loader remains unavailable. Tests replace that profile module and, where a fake
spawn is required, `node:child_process` only through test-runner module isolation. Real-child tests
use the fixed source-excluded `apps/server/testdata/server-binding-signer-host-fixture-v1.mjs` path
supplied by the mocked profile.

### Dedicated framing

Signer IPC uses a dedicated binary frame and does not reuse NDJSON, ProcessHost, HostControl, ARWX,
or Worker API framing.

Each frame is:

```text
4-byte unsigned big-endian payload length
exact UTF-8 canonical JSON payload
```

The payload length is `1..8192` bytes and excludes the four-byte prefix. A peer must support stream
fragmentation and multiple coalesced frames. It rejects zero length, oversized length, truncated
EOF, invalid UTF-8, a non-object root, duplicate keys, extra keys, accessors introduced by an
in-process test double, noncanonical JSON, and trailing bytes inside a payload.

Canonical JSON has no insignificant whitespace, uses the exact field order defined below, and uses
only strings, booleans, safe integers, arrays with fixed ordering, plain objects, and the single
explicit `null` allowed for `error.requestId`. Parsing must be followed by exact re-marshalling and
byte comparison. All regular expressions use a strict final anchor that cannot accept a trailing
line terminator.

The fixed wire, transport, and client constants are:

```text
protocolVersion = "1.0"
maximumFrameBytes = 8192
maximumStatementBytes = 4096
maximumBufferedStdoutBytes = 16384
maximumBufferedStderrBytes = 16384
maximumConcurrentRequests = 1
maximumAssignedRequestIdsPerClient = 4096
handshakeTimeoutMilliseconds = 10000
signingTimeoutMilliseconds = 15000
gracefulShutdownTimeoutMilliseconds = 5000
forcedExitTimeoutMilliseconds = 10000
```

Timeouts are transport deadlines, not evidence that a child stopped. Only observed process exit is
exit proof.

### Closed message set

The parent-to-child union contains exactly:

```text
hello
sign_receipt_statement_v1
sign_active_status_statement_v1
cancel
shutdown
```

The child-to-parent union contains exactly:

```text
ready
signature
cancelled
shutdown_ack
error
```

Unknown message types, unknown fields, wrong field order, a message in the wrong lifecycle state,
or a second response for one request are fatal protocol corruption.

IDs use lowercase canonical UUID v4. The parent obtains one `instanceId` and every accepted
`requestId` from a cryptographically secure UUID v4 generator; a value that merely has v4 layout
bits is insufficient. The child may only echo them. One request ID may recur only on frames for the
same logical signing, cancellation, or shutdown operation and is never assigned to a second
operation during one client lifetime.

The parent keeps an exact, bounded lifetime ledger. One client may assign at most 4096 request IDs.
At most 4095 are signing IDs; the final slot is reserved for orderly `shutdown`. A local busy
rejection assigns no ID. Settlement of the 4095th successful signing operation synchronously fences
new admission and enters orderly `closing`; the client sends the reserved shutdown request and does
not reopen or automatically spawn a replacement. An attempted over-limit signing transition is an
internal invariant failure, while public calls after the fence use the existing closed-admission
result. This is a fixed parent-local v1 limit, is not negotiable, and adds no wire field. A future B
activation that needs healthy rollover must define it separately and may begin a replacement only
after the old child has `exit_proven`; it must never reuse an ID ledger or restart a failed child.

### Handshake

Immediately after spawn, the parent sends:

```json
{"instanceId":"<uuid-v4>","protocolVersion":"1.0","type":"hello"}
```

Before the handshake completes, no signing, cancellation, or shutdown acknowledgement is accepted.
The child loads its one later-compiled backend internally, without any parent key selector, derives
its canonical uncompressed P-256 PKIX SPKI and issuer key ID, and returns:

```json
{"capabilities":{"maximumConcurrentRequests":1,"operations":["active_status_statement_v1","receipt_statement_v1"]},"hostPid":1234,"instanceId":"<uuid-v4>","issuerKeyId":"<64-lowercase-hex>","issuerPublicKeySpki":"<canonical-base64url>","protocolVersion":"1.0","type":"ready"}
```

The operations array has that exact order. The SPKI is exactly the canonical 91-byte P-256 form used
by S0. `hostPid` is a positive safe integer and must equal the PID exposed by the direct child
handle.

ADR 0024 does not add a third issuer-key signature domain. The issuer key is used only for the two
S0 domains frozen by ADR 0022. Consequently, `ready` is not cryptographic proof of possession to the
parent. It proves only that the trusted transport process reports its backend initialized. A future
B composition must compare the returned SPKI and key ID with independently compiled trust and then
with the ADR 0023 database singleton. Actual key possession is accepted only after the child signs
one exact receipt or active-status statement and the parent verifies that S0 signature. The child
cannot bootstrap trust by self-reporting matching values.

The A implementation uses only an exact test key embedded in the out-of-tree fixture and its public
SPKI in focused test data. Tests replace the unavailable trust and host-profile modules through
test-runner isolation. No production-reachable API accepts caller-supplied trust. Production trust
loading remains unavailable.

### Statement-specific signing

The transport accepts canonical S0 statement bytes, never a raw digest or general preimage.

A adds a distinct internal provider shape with exactly these members:

```text
kind = "binding-statements-v1"
issuerPublicKeySpki
terminalFailure
readTerminalError
signReceiptStatementV1
signActiveStatusStatementV1
close
```

The signer core validates the canonical SPKI and derives the issuer key ID itself; provider-reported
key ID is not an input. This is the sole extension of ADR 0023's previously closed two-shape provider
union. The existing `preimage-sha256` and `digest-native` shapes and their single-hash semantics
remain byte- and behavior-exact. The new provider never masquerades as either shape and never parses
an already domain-separated byte string. The signer core passes exact canonical statement bytes to
it. This avoids prefix recognition, accidental prehashing, double hashing, and widening either
existing provider interface.

A receipt request is:

```json
{"protocolVersion":"1.0","requestId":"<uuid-v4>","statementJson":"<unpadded-base64url-canonical-receipt-statement>","type":"sign_receipt_statement_v1"}
```

An active-status request is:

```json
{"protocolVersion":"1.0","requestId":"<uuid-v4>","statementJson":"<unpadded-base64url-canonical-active-status-statement>","type":"sign_active_status_statement_v1"}
```

Every frame repeats the exact protocol version. Each decoded statement is `1..4096` bytes. The child
must parse the applicable S0 schema, re-marshal the exact canonical bytes, compare them
byte-for-byte, construct the fixed S0 domain-separated preimage, perform exactly one SHA-256, sign
with ECDSA P-256, normalize to low-S if necessary, and verify the complete result with its derived
SPKI.

The receipt success response is:

```json
{"operation":"receipt_statement_v1","protocolVersion":"1.0","requestId":"<uuid-v4>","signature":"<86-char-base64url>","type":"signature"}
```

The active-status success response is:

```json
{"operation":"active_status_statement_v1","protocolVersion":"1.0","requestId":"<uuid-v4>","signature":"<86-char-base64url>","type":"signature"}
```

The operation value must exactly match the request. The parent independently re-parses and
re-marshals its retained statement bytes, reconstructs the complete signed S0 document, validates
P1363 scalar range and low-S, and verifies the signature with independent trust before resolving.

Neither side assumes ECDSA determinism. A lost response never implies failure or success. ADR 0023
retains the first valid receipt through compare-and-swap and exact replay.

If one signing request is already active, a second parent API call sends no frame and rejects with
`SIGNER_HOST_BUSY`. That result is recoverable, does not resolve `terminalFailure`, and cannot cancel,
delay, or otherwise mutate the first request. The caller may retry the exact ADR 0023 pending claim
after the first request settles. A wire `REQUEST_BUSY` response means the parent violated the
single-concurrency protocol and remains child-terminal.

### Cancellation and late results

Cancellation is best-effort for a responsive backend and a mandatory admission fence in the parent.
The parent sends:

```json
{"protocolVersion":"1.0","reason":"caller_abort","requestId":"<uuid-v4>","type":"cancel"}
```

The `reason` field has exactly three literals: `caller_abort`, `deadline`, or `shutdown`. Spelling,
case, separators, combinations, and every other value are rejected.

The only cancellation response is:

```json
{"protocolVersion":"1.0","requestId":"<uuid-v4>","type":"cancelled"}
```

A successful cancellation response is not proof that a synchronous backend stopped. Every caller
abort, deadline, or shutdown cancellation therefore makes the entire v1 client terminal; cancellation
never returns it to `ready` and no new request is admitted. The client fences all pending and future
requests with the first terminal cause, attempts cancellation if the pipe is writable, and enters
forced shutdown. A signature after cancellation, an unsolicited cancellation response, or any
response for an unknown or completed ID is terminal protocol corruption. The client never reuses or
respawns that child.

### Stable child errors

The child may emit:

```json
{"code":"<one-stable-code>","protocolVersion":"1.0","requestId":null,"type":"error"}
```

The exact child code union is:

```text
HANDSHAKE_REJECTED
REQUEST_INVALID
REQUEST_BUSY
SIGNING_FAILED
CANCEL_FAILED
SHUTDOWN_REJECTED
INTERNAL_FAILURE
```

`requestId` may instead be one lowercase UUID v4 when the error belongs to a valid request. Messages
contain no free-form detail. `requestId = null` is process-fatal. Any signing error is terminal for
v1 because backend health and key usability are no longer proved. Parent-side errors use only these
stable categories:

```text
SIGNER_HOST_UNAVAILABLE
SIGNER_HOST_MISMATCH
SIGNER_HOST_PROTOCOL_FAILURE
SIGNER_HOST_OUTCOME_UNKNOWN
SIGNER_HOST_EXIT_UNPROVEN
SIGNER_HOST_BUSY
SIGNER_HOST_CLOSED
```

The A implementation extends the internal signer error set with `SIGNER_OUTCOME_UNKNOWN` and the
coordinator maps that code to its existing terminal `PERSISTENCE_OUTCOME_UNKNOWN` category. The
phase-specific mapping is exact:

| Condition | Signer result | Coordinator effect |
| --- | --- | --- |
| Profile unavailable or spawn proved not started | `SIGNER_UNAVAILABLE` | no context; authority is never ready |
| Handshake deadline, pre-ready child error or exit, pipe write failure, or stdout/stderr overflow | `SIGNER_UNAVAILABLE` | no context; authority is never ready |
| Invalid UTF-8, frame, canonical JSON, version, type, order, field set, or correlation during handshake | `SIGNER_MISMATCH` | no context; terminal startup rejection |
| Ready identity, capability, PID, SPKI, or key-ID mismatch | `SIGNER_MISMATCH` | no context; terminal startup rejection |
| Invalid returned signature | `SIGNATURE_INVALID` | terminal `SIGNER_MISMATCH` |
| Any timeout, abort, child error, protocol failure, unexpected exit, write failure, or output overflow after context publication | `SIGNER_OUTCOME_UNKNOWN` | terminal `PERSISTENCE_OUTCOME_UNKNOWN` |
| Close failure or unproved exit after context publication | `SIGNER_OUTCOME_UNKNOWN` | terminal close; no reopen |
| Second local signing call while one is active | `SIGNER_UNAVAILABLE` | recoverable busy result; first request and authority remain active |
| New call after a completed close | `SIGNER_UNAVAILABLE` | rejected by closed admission |

No post-publication host failure maps to the coordinator's recoverable `SIGNER_UNAVAILABLE`
operation result; local busy admission is not a host failure. Raw child errors, paths, PIDs,
statements, digests, signatures, and stderr never cross an HTTP response or ordinary log boundary.

### Output handling

Stdout is protocol-only. The parent continuously drains it through the frame parser. More than
`maximumBufferedStdoutBytes` without complete consumption or any bytes after a terminal frame are
fatal. EOF while the logical state is `starting`, `ready_idle`, or `signing` is fatal. EOF during
`closing` or after `failed` is only one cleanup fact and never substitutes for process exit.

Stderr is diagnostic-only. The parent continuously drains and counts it but never parses it as
protocol and never includes its contents in an error, log, metric label, test snapshot, or response.
Exceeding `maximumBufferedStderrBytes` is terminal and triggers forced shutdown. Tests assert that
secret-shaped fixture text is absent from serialized errors and logs.

### Lifecycle

The client maintains separate logical and cleanup states.

```text
logicalState = new | starting | ready_idle | signing | closing | failed | closed
cleanupState = no_spawn_attempt | spawn_not_started | child_live | termination_requested |
               exit_proven | exit_unproven
```

Logical transitions are:

```text
new -> starting -> ready_idle -> signing -> ready_idle
new -> closed
starting | ready_idle | signing -> closing
any nonterminal failure -> failed
closing + (no_spawn_attempt | spawn_not_started | exit_proven) -> closed
```

`failed` and `closed` are logical terminal states. Cleanup may continue after `failed`, but it never
changes that logical first cause or restores readiness. `closed` is reached only after no spawn was
attempted, spawn was proved not to have started, or child exit was proved. Signing is accepted only
in `ready_idle`. Repeated close returns the same promise.

`spawn_not_started` is valid only when `spawn()` synchronously throws before returning a child, or
when the returned object emits `error` before `spawn`, never exposes a positive child PID, and later
emits `close` after all created stdio streams close. This is the only attempted-spawn path that does
not require an `exit` event. Once `spawn` or a positive PID is observed, cleanup is `child_live` and
only an actual child `exit` event plus all stdio close facts can produce `exit_proven`.

Close during `starting` sends no `cancel`, `shutdown`, or other protocol frame because no valid
session exists. It fences a late `ready` and closes admission. If spawn is proved not to have
started, close completes from `spawn_not_started`; otherwise it sends `SIGKILL` and waits for
`exit_proven`. A late `ready`, `shutdown_ack`, or any other frame during that path is ignored only as
untrusted bytes while the child is already fenced; it can never publish readiness or change the
close result.

For an established session, the shutdown request and acknowledgement are exactly:

```json
{"protocolVersion":"1.0","requestId":"<new-uuid-v4>","type":"shutdown"}
```

```json
{"protocolVersion":"1.0","requestId":"<same-uuid-v4>","type":"shutdown_ack"}
```

The shutdown request ID differs from every signing request ID. An acknowledgement with any other ID
is terminal protocol corruption.

Orderly close from `ready_idle`:

1. synchronously fences admission;
2. sends one `shutdown` request if the pipe remains valid;
3. waits up to `gracefulShutdownTimeoutMilliseconds` for `shutdown_ack` followed by child exit;
4. if either is missing, sends `SIGKILL` once; and
5. waits up to `forcedExitTimeoutMilliseconds` for actual child exit and stdio close.

Close from `signing`, plus every caller abort or signing deadline, first fences the public operation,
sends best-effort `cancel` if the pipe is writable, and proceeds directly to `SIGKILL` without
waiting for `cancelled`, backend settlement, or `shutdown_ack`. The public wrapper rejects or closes
promptly while the raw child, streams, and process exit remain owned through cleanup or quarantine.

`shutdown_ack`, stdin completion, stdout EOF, `ChildProcess.kill()` returning true, a signal event,
or a PID no longer being queryable is not sufficient. Success requires the child `exit` event, all
three stdio streams closed, and the process handle reaped by Node. Cleanup then records
`exit_proven`; only afterward may an orderly `closing` state become `closed`. A logical `failed`
state remains failed even after cleanup records `exit_proven`, and `close()` rejects with the same
first terminal error after cleanup.

Unexpected child exit, nonzero exit, signal exit before forced shutdown, `error`, protocol EOF, or a
failed write latches the first terminal cause. All pending wrappers reject immediately with that
same object while raw stream and child settlement remain owned until exit or quarantine.

The child maintains its own closed state machine:

```text
booting -> awaiting_hello -> ready_idle -> signing -> ready_idle
ready_idle -> shutting_down -> exited
signing + cancel -> cancelling -> exited
any invalid message or internal error -> failed -> exited
```

Every child `error` frame is terminal. After emitting at most one `error`, the child closes protocol
output and exits nonzero. `cancelled` is also terminal for the child session: after emitting it, the
child releases its backend and exits rather than returning to `ready_idle`. `shutdown_ack` is emitted
only from `shutting_down` immediately before a clean exit. If a synchronous backend prevents the
child from processing cancel or shutdown, the parent forced-termination path remains authoritative.

### Forced termination and quarantine

The signer host is forbidden from spawning descendants. A later native host must enforce that
property in source and platform tests. For A, a test child that violates it is rejected as outside
the transport contract; A does not claim complete process-tree containment.

When forced termination does not produce observed exit within the fixed deadline, the client rejects
with `SIGNER_HOST_EXIT_UNPROVEN`, retains the child object, streams, listeners, and provider in a
process-lifetime quarantine, and makes the dormant client, provider, and any test-composed
coordinator terminal. It must not report a successful close, release the signer owner, or initialize
a replacement.

A does not connect this dormant client to `server-storage-runtime.ts` or its database owner lock.
Before B can activate the signer host, B must define the complete Server shutdown and supervisor
policy for unproved child exit. The current runtime may continue its existing database and artifact
cleanup because no production signer-host client is reachable.

Linux uninterruptible D-state can delay `SIGKILL`; this is a host-level failure and has no bounded
in-process recovery claim. Parent-death cleanup also remains a B deployment decision. Production
activation must later require either a verified systemd/cgroup `KillMode=control-group` profile or a
reviewed native `PR_SET_PDEATHSIG` launcher with the parent-death race closed.

### Crash and restart

The same Server process never restarts a failed signer host. The external supervisor may restart the
whole Server only after the old process and its signer child are gone.

A crash before signing leaves the ADR 0023 binding in `signing_pending`. A crash after the child
produces a signature but before receipt commit also leaves `signing_pending`. A crash after commit
replays the stored receipt bytes. Startup audits the database and independently validates signer
identity; it never infers success from a child exit, log, or prior request ID.

### Dormant production boundary

ADR 0024 does not make a production signer reachable. After A:

- `loadProductionServerBindingSignerProviderV1()` still throws unavailable;
- `loadProductionServerBindingTrustProfileV1()` still throws unavailable;
- production config has no signer-host path, key path, key backend, or trust input;
- `main.ts` does not import or instantiate the transport;
- a fresh database remains uninitialized; and
- retained S1 authority state still prevents startup without a future exact B profile.

Tests may use a source-excluded child fixture and ordinary ephemeral test key. No private test key,
test executable path, spawn hook, or test trust key may appear in production output or a package
export.

### Architecture guards

The current production graph rejects `node:child_process` outside exact allowlists. A may add one
direct import only in `server-binding-signer-host-client-v1.ts`. Guards must pin:

- the exact direct consumer set for every signer-host module;
- the exact top-level export set and normalized source SHA-256 for every sensitive consumer;
- the fixed `spawn` callee and option shape;
- no shell, detached process, dynamic executable, caller environment, or extra inherited handle;
- no import from routes, config, `main.ts`, database code, Worker code, Dashboard code, or native
  production entrypoints;
- one exact provider-to-signer-to-coordinator `terminalFailure` consumer chain and no alternate
  listener, callback, or polling path;
- no re-export through a barrel, package subpath, tsconfig alias, or package import map;
- the test fixture and its private key remaining outside every TypeScript compiler input, `dist`
  tree, production package or container inventory, script entrypoint, and runtime import graph;
- production provider and trust loaders remaining unavailable;
- zero route, Worker-auth, Claim, lease, slot, installation, package, or execution consumer; and
- zero private-key, PEM, PKCS#8, PIN, credential path, HSM module, or KMS endpoint string in A
  production sources.

The general ProcessHost client and protocol must reject any signer-host import or role. Signer code
must not import ProcessHost.

## Verification Requirements

The A implementation must cover the exact candidate with focused unit and real child-process tests:

- every message golden vector, exact field order, canonical re-marshal, strict regex anchor, invalid
  UTF-8, duplicate key, extra field, wrong type, zero frame, oversized frame, truncation,
  fragmentation, coalescing, and multiple frames;
- handshake UUID and key-ID grammar, canonical SPKI, wrong curve, changed PID, changed instance, and
  operation-capability mismatch;
- exact receipt and active-status statement acceptance, cross-profile substitution, noncanonical
  statement bytes, oversize statement, wrong response operation, and complete parent verification;
- single concurrency, duplicate request IDs, unknown IDs, duplicate responses, response before
  request, response after cancellation, and late results after terminal failure;
- cryptographically generated UUID v4 IDs, exact lifetime duplicate rejection, the 4094/4095/4096
  assignment boundaries, the reserved shutdown ID, automatic healthy close fencing, and no A-side
  replacement after capacity retirement;
- all three exact cancellation reasons plus rejection of alternate spelling, case, separators, and
  combined reason strings;
- a second local signing call returning recoverable busy without sending a frame, settling the first
  request, resolving terminal failure, or changing client state;
- caller abort, request deadline, child signing error, pipe write error, malformed stdout, stdout
  flood, stderr flood, stdin close, phase-specific stdout EOF, nonzero exit, signal exit, synchronous
  spawn throw, and error-before-spawn without an exit event;
- close before open, close during handshake, close during signing, repeated close, shutdown
  acknowledgement without exit, exit without acknowledgement, forced kill, kill failure, exit race,
  stdio-close race, and unproved-exit quarantine;
- a real fixture that blocks its event loop indefinitely while parent timers continue, is killed,
  and is actually reaped;
- first-terminal-cause reuse and immediate rejection of all public pending work while raw child and
  stream settlements remain tracked;
- terminal failure before context mint, between context mint and coordinator construction, during
  database initialization, while ready and idle, during signing, and during close, including the
  synchronous pre-adoption snapshot path with zero database requests;
- bounded stderr redaction with injected secret-shaped text;
- production loader, trust loader, config, `main.ts`, routes, Worker-auth, Worker bundles, Dashboard,
  Go production packages, and package barrels remaining unchanged and unreachable; and
- source and bundle architecture verification proving zero authority activation.

Linux process tests are mandatory before A can be called complete. Windows-local tests may verify
codec and generic Node child lifecycle behavior but are not evidence for Linux signal, reaping,
cgroup, credential, executable ownership, or parent-death semantics.

## Compatibility

The wire documents, signature algorithms, domain separation, P1363 low-S rules, identifier grammar,
and maximum 4096-byte S0 statement documents remain byte-exact. ADR 0023 database schema 12,
transactions, replay, revocation, startup audit, opaque database capability, and production
unreachability remain unchanged.

The signer-host protocol is private and versioned independently from Worker API, ARWX, HostControl,
ProcessHost, database schema, and S0 document schema. Version `1.0` has no minor negotiation or
fallback. Any message or capability change requires a new reviewed protocol version.

## Consequences

- Blocking or hung signer work can be isolated to a killable direct process instead of the Fastify
  event loop.
- The child cannot be used through this protocol as a generic signing oracle.
- Parent verification remains independent from child self-report.
- Exact cancellation, fail-stop, close, exit proof, and quarantine behavior can be implemented and
  tested without selecting production key storage.
- Production enrollment remains unavailable after A, so no authority is accidentally activated.
- A second review is still required for the key backend, compiled trust, executable release, and
  deployment supervision.

## Deferred Decisions

- whether the production key is software PKCS#8, PKCS#11/HSM, cloud KMS, or another non-exportable
  backend;
- whether the backend must resist compromise of the same-UID Server process;
- signer service identity, credential delivery, PIN or token session ownership, library loading,
  audit, and network policy;
- signed signer-host executable assembly, fixed path, digest, ancestor ownership, container image,
  and rollback policy;
- compiled trust artifact generation, signing root, anti-rollback, release binding, and rotation;
- systemd cgroup versus native parent-death enforcement;
- issuer-key generation, backup, restore, escrow, rotation, and compromise runbook;
- production provider and trust loading in `main.ts`;
- S2 OIDC policy, authorization lifetime, rate limit, administration, candidate mTLS listener,
  issuance, confirmation, active-status, recovery, and revocation routes; and
- every Windows enrollment writer, reader, live-evidence, destination, installer, Worker-auth,
  Claim, slot, package, or execution decision.

## Non-Goals

- selecting or storing a production private key;
- passing private-key bytes, a PIN, credential path, backend module, or KMS endpoint over IPC;
- implementing a remote signing service, high-availability signer pool, or automatic respawn;
- reusing ProcessHost or allowing arbitrary process launch;
- accepting a generic `sign(bytes)`, `signDigest`, caller domain, algorithm, or key selector;
- changing S0 or S1 persistence semantics;
- exposing an enrollment HTTP route or producing active-status evidence for a caller;
- treating a signer-host ready event, receipt, status, or database row as Worker authentication; or
- enabling installation, package, Claim, lease, slot, or execution authority.

## References

- ADR 0002: Linux Fastify and `node:sqlite` Server
- ADR 0004: Windows Service and ProcessHost lifetime principles
- ADR 0007: Control/Executor key separation and fixed-origin signing
- ADR 0022: Dormant Server enrollment binding authority v1
- ADR 0023: Dormant Server binding persistence v1
