# PowerToys Agentic Review

PowerToys Agentic Review is a TypeScript control plane and Windows execution worker for multiple
GitHub repositories, issue triage, and pull request review with Codex CLI or GitHub Copilot CLI.
The product is unreleased. It does not preserve compatibility with the earlier split-worker or
artifact-storage prototypes.

See [ARCHITECTURE.md](./ARCHITECTURE.md),
[docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md), and
[ADR 0029](./docs/adr/0029-trusted-code-single-worker-and-shared-worktrees.md) for the current
baseline.

## Workspace

- `apps/server`: Linux control plane, GitHub ingestion, scheduling, fenced leases, operator
  authentication, and SQLite persistence.
- `apps/worker`: one outbound-only Windows Worker that prepares worktrees, runs the selected CLI and validation,
  and submits an inline structured result.
- `apps/dashboard`: React and Material UI operator dashboard with Vite and React Router.
- `packages/contracts`: runtime schemas and shared protocol types.
- `packages/domain`: pure state-transition and scheduling policy logic.
- `packages/codex`: shell-free model CLI launch specifications, structured output parsing, and result schemas.
- `native/process-host`: Windows Job Object process-tree and resource-control adapter.
- `config/prompts`: trusted, versioned prompts loaded outside reviewed repositories.
- `migrations`: ordered SQL initialization definitions for the current schema, version `31`.
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

The selected CLI runs with workspace write access and outbound network access so it can inspect, edit, build,
and test inside the disposable worktree. ProcessHost and Windows Job Objects still enforce lifetime,
process-count, memory, timeout, and output limits. Worker and Server credentials are not propagated
to child processes.

Model execution selects `WORKER_CLI_ENGINE=codex` or `copilot` and an absolute
`WORKER_CLI_EXECUTABLE_PATH`. `WORKER_CLI_HOME` and `WORKER_CLI_MODEL` are optional. Log in through
the selected CLI under the Worker account and intended CLI home. The CLI owns its authentication,
provider selection, configuration and network requests; the project does not inspect or copy its
authentication/provider files. Startup detects the CLI version with a bounded `--version` call,
without a manually supplied CLI version. `WORKER_CLI_SHA256` is an optional binary pin; it is not
required. Worker capabilities report nullable
`cliEngine` and `cliVersion`.

There is no global provider registry, model HTTP relay or provider request/response ledger in the
active architecture. The project records CLI configuration, process exit and schema-validated
structured output, without claiming independently verified provider model identity. See the
[CLI-owned model execution design](./docs/design/2026-09-10-cli-owned-model-execution.md).

ProcessHost also holds a Windows global mutex derived from the resolved Worker data root, preventing
overlapping execution Workers from mutating the same cache or workspace tree.
If initialization fails after ProcessHost starts, the Worker closes it before reporting the error.

Results use bounded inline, schema-validated completion payloads. Profile validation additionally
uses M16 bounded evidence upload and authenticated delivery for screenshots, traces, and structured
test evidence. There is no general-purpose artifact distribution service; see
[ADR 0031](./docs/adr/0031-profile-validation-runs-and-bounded-evidence.md).

Current result contracts separate model-reported verification from Worker-observed commands,
exit codes and final Git worktree state. Envelope versions and result versions are distinct;
ordinary and Evaluation workflows can use different result versions. Failures retain bounded,
redacted diagnostics. The unreleased product maintains schema 31 directly through the existing
SQL initialization machinery. This does not require old-version upgrades, database resets, data
conversion or compatibility migration work, and it does not authorize changing existing data.

Pull request execution defaults to authorization of the exact base/head revision in an explicit
webhook request. Polling still reconciles state and withdrawals but cannot approve a current SHA
using an old timeline actor. Operators that intentionally trust future commits of an authorized PR
can set `AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY=inherit_authorized_epoch`.
Issue triage retains its snapshot-based workflow. See [ADR 0030](./docs/adr/0030-explicit-pull-request-execution-authorization.md).

## Accepted scope and remaining work

[M39](./docs/handoff/2026-09-10-cli-workflow-handoff.md) accepted six real CLI PR review/Evaluation
tasks through complete Codex and Copilot sequences. M40 accepted six headless Issue summaries with
independent semantic review and confirmed cleanup. [M41](./docs/handoff/2026-09-10-approved-acceptance-handoff.md)
accepted the explicitly approved live publication workflow on `moooyo/PowerToys`: one production
PR review and one Issue comment, acknowledgement-loss reconciliation without duplicate POSTs,
and independently confirmed target cleanup and settings restoration. M42 installed the approved
Spectre components, passed the pinned PowerToys Restore/Runner/Settings UI build, and passed seven
selected Settings serialization/mocked-storage tests.

Remaining scope includes full Worker `main.ts` on the intended Windows VM, real PowerToys/UI
profiles, Issue triage and deployed OIDC. The seven tests do not establish full unit-test coverage;
no native PowerToys UI has been launched for this acceptance.
M40's three small quality cases do not establish broad review coverage or a general benchmark.
See [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) for CI, exact evidence, retained failures
and remaining work; each new live target or publication payload still requires its own authorization.

## Authentication

Each Worker uses a node-scoped Bearer Token. Operator authentication supports either:

- `loopback` for a loopback-only local deployment; or
- `oidc` for externally reachable deployments.

GitHub OIDC is not required. GitHub webhook verification and/or a read token are separate ingestion
credentials.

Operator access is scoped by repository with viewer, reviewer, maintainer, and admin roles. An
authenticated login without grants sees an empty repository directory. Platform administrators
come from trusted startup configuration. OIDC deployments must explicitly configure
`AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON` as a nonempty subset of authorized login subjects;
loopback mode uses its configured development identity. See
[repository access design](./docs/design/2026-09-07-operator-repository-access.md).

Run reports keep model advice, validation policy, and recorded human decisions separate. Operators
can record an exact-revision decision, a comment, or a withdrawal; maintainers can record a qualified
exception approval. Reruns and source changes make earlier decisions historical. These records
stay within the platform and do not publish GitHub reviews or comments. See
[the human decision workflow](./docs/design/2026-09-07-run-human-decisions.md).

The connected result drawer also records finding disposition and compares explicitly selected
results. Complete original findings remain available after acceptance, dismissal, resolution, or
reopening. Current policy distinguishes reported P0/P1 findings from unresolved blockers; finding
changes invalidate approvals of the old basis. A finding that is not observed again is not
automatically resolved. See [the finding lifecycle](./docs/design/2026-09-07-finding-lifecycle.md).

## Development

The repository requires Node.js 24.20.x and pnpm 11.24.x.
Run verification on `test-env` by default; local verification requires explicit authorization for
the current task. The 2026-09-05 Windows runtime E2E exercise passed; its tested configuration,
evidence, and environment closeout are recorded in the
[live validation handoff](./docs/handoff/2026-09-05-windows-e2e-live-validation.md).
Historical acceptance receipts apply to their recorded source and scope; they are not a claim that
the current branch's CI gates have passed.

Automated verification must not write to any repository's PRs or issues without the user's
explicit approval of the targets, operations, and content. This includes comments, reviews,
labels, assignments, review requests, and state changes, even in a test repository. Use isolated
fixtures or read-only live checks by default; see [the repository instructions](./AGENTS.md).

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
