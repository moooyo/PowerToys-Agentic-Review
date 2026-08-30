# Agentic Review Windows Worker

The Worker is a headless, outbound-only Windows service. It registers with the central Server, long-polls for work, maintains fenced leases through instance heartbeats, and delegates all job execution to an injected `JobExecutor`.

The Worker never receives GitHub credentials and never opens the Server SQLite database.

## Current skeleton

Implemented boundaries:

- HTTPS/mTLS Worker API client.
- Stable node identity and per-process instance identity.
- Capability registration and deterministic capability digest.
- Capacity-aware long-poll claim loop.
- Batched instance heartbeat for every active lease.
- Lease generation fencing and local self-abort before lease expiry.
- Server command handling for cancel, stale, drain, and upgrade requests.
- Absolute execution deadlines and graceful service drain.
- Injectable `JobExecutor` and versioned ProcessHost protocol types.

The default build uses `PlaceholderJobExecutor` and advertises execution as disabled. This
milestone rejects `WORKER_EXECUTION_ENABLED=true`; a later release must wire and verify the Codex
executor and ProcessHost transport before removing that guard.

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
