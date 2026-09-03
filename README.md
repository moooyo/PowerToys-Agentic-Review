# PowerToys Agentic Review

PowerToys Agentic Review is a TypeScript control plane and remote Windows worker system for
GitHub issue triage and pull request review with Codex CLI.

The repository is an early implementation. See [ARCHITECTURE.md](./ARCHITECTURE.md) and the
architecture decision records in [docs/adr](./docs/adr). The exact implemented and deliberately
disabled boundaries are tracked in [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md).

## Workspace

- `apps/server`: Linux control plane, GitHub integration, scheduling, leases, and SQLite.
- `apps/worker`: remote Windows worker, Codex CLI execution, heartbeats, and artifacts.
- `apps/dashboard`: React and Ant Design Pro operator dashboard.
- `packages/contracts`: runtime schemas and shared protocol types.
- `packages/domain`: pure state transition and policy logic.
- `packages/codex`: shell-free Codex launch specifications, JSONL parsing, and result schemas.
- `config/prompts`: trusted, versioned prompts loaded outside reviewed repositories.
- `migrations`: forward-only SQLite schema for leases, GitHub projections, OIDC sessions, and
  polling checkpoints.
- `deploy/worker`: legacy execution-disabled WinSW installer scaffold; the split-service installer is
  pending.

Phase 1a supports authenticated, read-only GitHub ingestion, immutable result projections, and
Dashboard views. The native Windows ServiceHost composition is connected in zero-execution mode,
but real Worker execution remains disabled until the TypeScript Control and Executor business
runtimes, production release profile, dual-service installer and signing pipeline, and native
Windows x64 and arm64 verification suite are complete. Phase 1b result artifacts, immutable diff
validation, approval persistence, and GitHub publication also remain deliberately disabled. Dynamic
validation remains a separate stronger-isolation milestone.

## Database recovery maintenance

Whole-Server database rollback uses `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true` with a loopback-only
listener and configured operator authentication. On each maintenance start, the Server atomically
invalidates restored operator login transactions, sessions, and browser bindings before listening;
it keeps liveness available, reports not-ready, rejects every Worker API route, and leaves local
operator credential reconciliation and Dashboard reads available. GitHub ingestion and the lease
reaper remain stopped until normal mode returns. A database-only maintenance runtime owns SQLite
without opening, enumerating, creating, or reconciling the artifact root.

The listener is not a network isolation boundary by itself. Remove the ordinary reverse-proxy
upstream and any container published port, then use only the designated local terminal or an SSH
tunnel to the loopback listener. For containers, use host networking or a local tunnel sidecar in
the same network namespace; ordinary bridged-container recovery is unsupported. Follow
[`docs/operations/worker-token-recovery.md`](./docs/operations/worker-token-recovery.md) for the
complete sequence.
