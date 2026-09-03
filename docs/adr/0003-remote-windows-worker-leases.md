# ADR 0003: Coordinate Remote Windows Workers with Pull Leases

> Amended by ADR 0025: Worker identity is authenticated by one per-Worker Bearer Token instead of a
> client certificate. Lease-token generation fencing and pull-lease behavior remain unchanged.

- Status: Accepted
- Date: 2026-08-30

## Context

PowerToys review and validation require Windows machines. Multiple workers may run on different networks, and a crashed or disconnected worker must not permanently own a job. The system cannot guarantee both physical exactly-once execution and automatic recovery during a network partition.

## Decision

Windows workers are outbound-only TypeScript clients. They claim work from the central Server over HTTPS using long polling; the Server never initiates a connection to a worker.

Use mutual TLS for machine authentication. Each machine has a stable `worker_node_id` mapped from its certificate, while every process start creates a new `worker_instance_id`. Capabilities and available slots are reported during registration and heartbeat.

Every execution uses a time-limited lease containing:

- A `run_attempt_id` for the current attempt.
- A random secret lease token, stored hashed by the Server.
- A monotonically increasing lease generation used as a fencing token.
- A Server-defined expiration time.

Claim is atomic in a short SQLite `BEGIN IMMEDIATE` transaction. Every heartbeat, progress update, completion, and artifact association must match the attempt, instance, token, and generation. A stale worker receives `409 lease_lost` and must terminate its process tree.

Workers send independent liveness and progress heartbeats. The Server clock is authoritative. The lease reaper fails an expired attempt and either schedules a retry with a new generation or moves the logical job to a terminal failure state after its retry policy is exhausted.

Jobs may also have a hard execution deadline and a phase-specific no-progress timeout. One worker heartbeat may renew all active slots on that instance. Logs and artifacts are uploaded in bounded, checksummed batches rather than written directly to SQLite.

## Consequences

- At most one attempt generation is accepted by the Server at a time.
- A stale physical process may briefly overlap a replacement during a partition, but it cannot commit an accepted result.
- Job state and attempt state remain separate, preserving retry history.
- Worker machines require no inbound firewall rule and never receive GitHub or database credentials.
- Protocol compatibility, certificate enrollment, revocation, and rotation become operational responsibilities.
