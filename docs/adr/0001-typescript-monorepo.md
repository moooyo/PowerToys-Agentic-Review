# ADR 0001: Use a TypeScript Monorepo

- Status: Accepted
- Date: 2026-08-30

## Context

The control plane, remote workers, dashboard, API contracts, and domain rules must evolve together. Maintaining separate languages and duplicated data transfer objects would increase protocol drift and operational overhead.

## Decision

Use a `pnpm` workspace monorepo with TypeScript as the application language.

The repository will contain these primary units:

- `apps/server`: the Linux control plane.
- `apps/worker`: the remote Windows worker.
- `apps/dashboard`: the React dashboard.
- `packages/contracts`: transport schemas, protocol versions, and error codes.
- `packages/domain`: state machines and platform-independent policies.
- Dedicated infrastructure packages for GitHub, Codex, configuration, and observability.

Contracts must be runtime-validated as well as statically typed. The worker must not depend on Server persistence or GitHub publication modules. Native Windows integration is isolated behind a small external helper and is not application business logic.

## Consequences

- Server, worker, and dashboard share one versioned contract source.
- One package manager and lockfile govern application dependencies.
- CI can detect forbidden dependency directions.
- Platform-specific behavior must remain behind explicit interfaces.
- A Node.js runtime is required on both Linux Server and Windows workers.

