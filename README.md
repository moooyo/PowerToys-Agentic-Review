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
- `deploy/worker`: WinSW service templates and the least-privilege Windows installer.

Phase 1 supports authenticated, read-only GitHub ingestion and Dashboard views. Real Worker
execution remains disabled until the reviewed Windows primitives are composed into the split
Control/Executor services, installer, and native Windows verification suite. Approval persistence,
GitHub publication, and dynamic validation also remain deliberately disabled.
