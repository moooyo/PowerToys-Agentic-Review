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
