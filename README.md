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
immutable `baseSha` and pull request head with full history, verifies both SHAs and their merge base,
and creates a detached per-attempt worktree. Any PR base branch is supported; there is no `main`
assumption or fallback. Fetch disables Git auto-maintenance so the Worker owns maintenance timing.
Repeated reviews therefore transfer only missing Git objects.
The Worker enforces a separate shared-cache byte limit and free-space guard, performs conservative
age-based Git maintenance only when worktree metadata is inactive, and drains if reclamation cannot
restore the configured budget.

Codex runs with workspace write access and outbound network access so it can inspect, edit, build,
and test inside the disposable worktree. ProcessHost and Windows Job Objects still enforce lifetime,
process-count, memory, timeout, and output limits. Worker and Server credentials are not propagated
to child processes.

`WORKER_EXECUTION_PROFILE_DIRECTORY` is a dedicated persistent Codex home. The Worker validates its
canonical path before cleanup, loads only allowed model/provider/auth settings, and enforces task
settings with `--ignore-user-config` and CLI overrides. Codex's project trust is `untrusted` only to
suppress repository configuration; admitted code remains trusted and `AGENTS.md` is still loaded.
Provider header credentials reach only native Codex, while build/test tools receive seven explicit
non-secret environment variables.

ProcessHost also holds a Windows global mutex derived from the resolved Worker data root, preventing
overlapping execution Workers from mutating the same cache or workspace tree.
If initialization fails after ProcessHost starts, the Worker closes it before reporting the error.

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
Run verification on `test-env` by default; local verification requires explicit authorization for
the current task. The authorized Windows runtime E2E exercise passed; its tested configuration,
evidence, and environment closeout are recorded in the
[live validation handoff](./docs/handoff/2026-09-05-windows-e2e-live-validation.md).

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
