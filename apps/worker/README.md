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

The legacy single-process build still uses `PlaceholderJobExecutor` and advertises execution as
disabled. The reviewed Control and Executor bundles currently establish only their zero-execution
ServiceHost foundations; they do not install business role supervisors or emit ARWX `Ready`. This
milestone rejects `WORKER_EXECUTION_ENABLED=true` until the zero-slot shadow runtime, production
release profile, dual-service installer and signing pipeline, and native Windows x64 and arm64
preflight and attack-test evidence described by ADR 0007 are complete.

## Role bundle trust boundary

The role-bundle AST scanner is a review-time hazard lint for known runtime-loader patterns. It is
defense in depth, not a JavaScript sandbox and not authority for hostile source. Production
authority must come from the exact path and SHA-256 input manifest inside a trusted, signed release
build, together with the ServiceHost and Windows identity, ACL, Job Object, and pipe boundaries.

The bounded `RuntimeBootstrapV1` foundation uses a three-stage HostControl exchange: ServiceHost
sends the bootstrap, Node acknowledges a validated role configuration and a running ARWX receive
loop, ServiceHost activates the retained Node, and Node accepts a bootstrap-bound commit before the
RPC session is published. The Control and Executor entrypoints then remain in a zero-execution
foundation state: they advertise no slots, claim no work, and emit no ARWX `Ready` until the
business role supervisors are implemented. The dormant role bundles also implement the bounded,
one-shot `ArmArwxShutdownV1` lifecycle gate: only an actual final `Drain` or `Drained` frame receipt
from the same committed bootstrap and ARWX channel can authorize shutdown, and the role-local
`shutdownId` does not claim cross-role transaction identity. The zero-execution entrypoints never
send either final frame or arm shutdown themselves. Before ServiceHost enables either payload, its
fixed Node launch contract must include `--disallow-code-generation-from-strings` and `--no-addons`;
neither flag replaces the operating system boundaries above.

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
