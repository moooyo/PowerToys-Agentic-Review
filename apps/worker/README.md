# Agentic Review Windows Worker

The Worker is a headless, outbound-only Windows service. It registers with the central Server, long-polls for work, maintains fenced leases through instance heartbeats, and delegates all job execution to an injected `JobExecutor`.

The Worker never receives GitHub credentials and never opens the Server SQLite database.

## Current state

Implemented boundaries:

- HTTPS/mTLS Worker API client.
- Stable node identity and per-process instance identity.
- Capability registration and deterministic capability digest.
- Capacity-aware long-poll claim loop.
- Batched instance heartbeat for every active lease.
- Lease generation fencing and local self-abort before lease expiry.
- Server command handling for cancel, stale, drain, and upgrade requests.
- Absolute execution deadlines and graceful service drain.
- Injectable `JobExecutor` and a strict, versioned ProcessHost NDJSON client.
- Negotiated ProcessHost concurrency, bounded frames and output, replacement environments,
  timeout/cancellation race handling, and fail-closed control-channel behavior.
- Native Go ProcessHost source with Windows Job Object process-tree supervision.
- Disposable exact-revision workspaces, static Codex execution, strict structured results,
  disk-budget enforcement, deferred cleanup, and immutable installation-manifest contracts.
- Separate reviewed Control and Executor bundles with strict ServiceHost launch contracts,
  HostControl bootstrap clients, and bounded ARWX standard-I/O channels.
- Candidate zero-slot Control and Executor supervisors with a signed local handshake, disabled
  `Ready` attestation, one-slot maximum registration with zero advertised availability, and a
  bounded graceful-drain choreography that still requires remote and native verification.

The legacy single-process build still uses `PlaceholderJobExecutor` and advertises execution as
disabled. The reviewed Control and Executor bundles now install candidate zero-slot supervisors.
After the authenticated local handshake, Executor can emit only `ready=false`, `availableSlots=0`,
and `reasonCode=EXECUTION_DISABLED`; Control registers with a one-slot maximum but advertises zero
available slots and never claims work. This candidate has not been verified yet. The milestone
continues to reject `WORKER_EXECUTION_ENABLED=true` until the production release profile,
dual-service installer and signing pipeline, and native Windows x64 and arm64 preflight and
attack-test evidence described by ADR 0007 are complete.

## Role bundle trust boundary

The role-bundle AST scanner is a review-time hazard lint for known runtime-loader patterns. It is
defense in depth, not a JavaScript sandbox and not authority for hostile source. Production
authority must come from the exact path and SHA-256 input manifest inside a trusted, signed release
build, together with the ServiceHost and Windows identity, ACL, Job Object, and pipe boundaries.

The bounded `RuntimeBootstrapV1` foundation starts the ARWX router before acknowledgement, accepts
the bootstrap-bound commit, transfers the exact HostControl owner, and resolves a role-level
`activated` barrier only after the connector result passes owner, bootstrap, role, and nominal
session validation. The candidate supervisors create no identities, timers, API facades, or ARWX
messages before that barrier. Control signs the exact handshake transcript through HostControl;
Executor verifies it with the pinned local-authority public key before publishing its disabled
`Ready` attestation. Control does not receive lease capacity from that attestation and keeps every
heartbeat at zero available slots with no active leases.

The role bundles contain a candidate bounded, one-shot `ArmArwxShutdownV1` lifecycle choreography.
Control sends the final `Drain`; Executor returns the exact final `Drained`; and each side arms
HostControl only from its own post-dispatch final-frame receipt before joining both EOF directions.
The Control-only native relay path can forward the validated `Drain` before Control EOF while
retaining an immutable copy for later HostControl authorization; Executor `Drained` remains held
until its authorized EOF. A compromised Control payload can therefore force a bounded Executor
shutdown, but this path grants no Claim, lease, or execution authority; the native attack matrix
must cover that denial-of-service tradeoff before any execution-enabled release. This choreography
has not been verified. In addition, the production
ServiceHost still lacks the Go-to-Node shutdown-request bridge needed to invoke Control runtime
close while relay, HostControl, and Node remain alive under one graceful deadline. The candidate is
not publishable until that bridge and the remote/native shutdown matrix are complete. The
role-local `shutdownId` does not claim cross-role transaction identity. Before ServiceHost enables
either payload, its fixed Node launch contract must include `--disallow-code-generation-from-strings`
and `--no-addons`; neither flag replaces the operating system boundaries above.

The ServiceHost role-local RPC server derives Claim authority only from the exact role configuration
sealed into that committed bootstrap. Both current role configurations set
`executionEnabled=false`, so Claim terminates the local RPC session with
`OPERATION_NOT_ALLOWED` before dispatcher or request resources are acquired.

## Worker API

The Worker currently calls:

```text
POST /api/v1/worker/instances
POST /api/v1/worker/leases/claim
PUT  /api/v1/worker/instances/{instanceId}/heartbeat
POST /api/v1/worker/runs/{runAttemptId}/complete
POST /api/v1/worker/runs/{runAttemptId}/fail
```

Registration, claim, heartbeat, lease identity, execution envelopes, and terminal submissions all
use runtime-validated schemas from `@agentic-review/contracts`.

## Development launch

Use a development-only HTTP endpoint explicitly:

```powershell
$env:WORKER_SERVER_URL = 'http://127.0.0.1:3000'
$env:WORKER_ALLOW_INSECURE_HTTP = 'true'
$env:WORKER_NODE_ID = 'development-worker'
$env:WORKER_EXECUTION_ENABLED = 'false'
node --enable-source-maps .\dist\worker.mjs
```

Production deployments must use HTTPS with a unique mTLS certificate for each worker node.
