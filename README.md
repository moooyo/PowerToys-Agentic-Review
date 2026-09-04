# PowerToys Agentic Review

PowerToys Agentic Review is a TypeScript control plane and Windows execution worker for GitHub
issue triage and pull request review with Codex CLI. The project is pre-release and intentionally
does not preserve compatibility with the earlier split-worker or artifact-storage prototypes.

See [ARCHITECTURE.md](./ARCHITECTURE.md),
[docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md), and
[ADR 0029](./docs/adr/0029-trusted-code-single-worker-and-shared-worktrees.md) for the current
baseline.

## Workspace

- `apps/server`: Linux control plane, GitHub ingestion, scheduling, fenced leases, operator
  authentication, and SQLite persistence.
- `apps/worker`: one outbound-only Windows Worker that prepares worktrees, runs Codex and validation,
  and submits an inline structured result.
- `apps/dashboard`: React and Ant Design Pro operator dashboard.
- `packages/contracts`: runtime schemas and shared protocol types.
- `packages/domain`: pure state-transition and scheduling policy logic.
- `packages/codex`: shell-free Codex launch specifications, JSONL parsing, and result schemas.
- `native/process-host`: Windows Job Object process-tree and resource-control adapter.
- `config/prompts`: trusted, versioned prompts loaded outside reviewed repositories.
- `migrations`: the current eight-step SQLite schema.
- `deploy/worker`: manual trusted deployment guidance for the unpublished Worker.

## Current execution model

Admitted repository revisions are trusted execution inputs. Pull request jobs use one persistent
shared Git object store per configured public repository. Before each job, the Worker fetches the
current `main` and exact pull request head, verifies the expected SHAs and merge base, and creates a
detached per-attempt worktree. Repeated reviews therefore transfer only missing Git objects.
The Worker enforces a separate shared-cache byte limit and free-space guard, performs conservative
age-based Git maintenance only when worktree metadata is inactive, and drains if reclamation cannot
restore the configured budget.

Codex runs with workspace write access and outbound network access so it can inspect, edit, build,
and test inside the disposable worktree. ProcessHost and Windows Job Objects still enforce lifetime,
process-count, memory, timeout, and output limits. Worker and Server credentials are not propagated
to child processes.

ProcessHost also holds a Windows global mutex derived from the resolved Worker data root, preventing
overlapping execution Workers from mutating the same cache or workspace tree.

The MVP has one result channel: an inline, schema-validated completion payload. There is no result
artifact upload or Server artifact store.

## Authentication

Each Worker uses a node-scoped Bearer Token. Operator authentication supports either:

- `loopback` for a loopback-only local deployment; or
- `oidc` for externally reachable deployments.

GitHub OIDC is not required. GitHub webhook verification and/or a read token are separate ingestion
credentials.

## Development

The repository requires Node.js 24.20.x and pnpm 11.24.x.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

The Windows Worker deployment and credential-file layout are documented in
[apps/worker/README.md](./apps/worker/README.md) and
[deploy/worker/README.md](./deploy/worker/README.md).

## Database recovery maintenance

Whole-database rollback uses `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true` with a loopback-only
listener. The Server keeps liveness available, reports not-ready, rejects Worker routes, suppresses
GitHub ingestion and lease reaping, and exposes only the operator recovery surface. Follow
[docs/operations/worker-token-recovery.md](./docs/operations/worker-token-recovery.md).
