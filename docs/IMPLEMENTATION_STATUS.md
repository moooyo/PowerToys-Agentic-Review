# Implementation Status

Current as of 2026-09-05 on branch `main`.

## Implemented baseline

### Server

- Fastify control plane with Linux-only production SQLite ownership.
- GitHub webhook ingestion and optional authenticated polling.
- Repository and actor admission policy.
- Immutable issue and pull request projections.
- Job scheduling, retries, claims, leases, heartbeats, fencing, and terminal replay handling.
- Inline result validation and immutable result persistence.
- Per-Worker Bearer Token creation, rotation, revocation, and authentication.
- Operator Dashboard APIs and static Dashboard serving.
- Authenticated Job detail reads with structured PR-review and issue-triage result projections.
- Explicit `loopback` or `oidc` operator authentication.
- Loopback-only database recovery-maintenance mode.
- Current database schema migrations `0001` through `0008`.

### Windows Worker

- One production Worker entry point and bundle: `apps/worker/dist/worker.mjs`.
- Real execution is wired when `WORKER_EXECUTION_ENABLED=true`.
- Worker registration, long-poll claims, Worker and lease heartbeats, drain, and fenced terminal
  reporting.
- Pinned Git, Codex, and ProcessHost executable paths and SHA-256 verification.
- Replacement child environments that exclude the Worker Bearer Token.
- Native ProcessHost supervision with Windows Job Object lifetime and resource limits.
- A Windows global named mutex, held by ProcessHost, that prevents two execution Workers from using
  the same resolved data root concurrently.
- Per-attempt disk reservation, monitoring, cleanup, and startup orphan sweep.
- One persistent shared bare Git repository per configured public GitHub repository.
- Bounded shared-repository accounting with a total cache limit, minimum-free-disk guard, bounded
  scans, conservative age-based reflog expiry and GC, and node drain when reclamation is insufficient.
- A cancellable global shared-cache mutation lock for whole-root accounting and bare-repository
  setup/cleanup, plus per-repository operation ordering.
- Full-history fetch of `main` and the GitHub pull request head ref.
- Immutable base/head commit checks, merge-base validation, detached worktree creation, and final
  `HEAD` verification.
- Codex workspace-write execution with outbound network access for trusted admitted code.
- Pull request prompt authorization to inspect, edit, build, and test inside the disposable
  worktree.
- Inline schema-validated result submission.
- Progress deadline refreshes only on observed Codex stdout/stderr activity; silent execution no
  longer receives synthetic keepalive progress.

### Dashboard and repository gates

- The Jobs page exposes an on-demand detail drawer for execution state, failures, result digests,
  PR findings, and issue-triage projections.
- Repository CI runs Node typecheck, tests, builds, and lint on Linux; ProcessHost tests, vet, and
  Windows cross-builds on Linux; and Worker typecheck/tests/build, ProcessHost tests, and
  deployment-script checks on Windows.
- Manual Windows deployment has a complete configuration template, guarded launch helper, and an
  explicit E2E evidence runbook. The evidence helper records per-repository and per-attempt
  observations across capture stages, never certifies acceptance, and preserves previous captures.
  Standalone PowerShell regression checks cover the collector and run in Windows CI.

### Removed unpublished prototypes

The following are deliberately absent and have no migration or compatibility layer:

- Control/Executor Worker services and role bundles;
- the TypeScript and native local RPC protocols between those roles;
- the native ServiceHost, split installer, Worker package, and Ed25519 release-signing path;
- result-artifact contracts, upload routes, artifact database tables, artifact filesystem storage,
  reconciliation, and artifact Worker Threads; and
- artifact-backed completion modes.

ADR 0029 is the current architecture decision for these removals.

## Current contracts

- Worker authentication: one node-scoped Bearer Token stored at
  `C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json`.
- Operator authentication: explicit `loopback` or `oidc` mode.
- Pull request repository cache: `<git-shared-root>\repository-<githubRepositoryId>.git`.
- Shared repository policy: bounded total bytes and free-space guard with conservative Worker-owned
  maintenance only when worktree metadata is inactive.
- Local execution singleton: one global ProcessHost mutex per resolved Worker data root.
- Task checkout: detached worktree below the per-attempt workspace directory.
- Completion: inline `{ resultDigest, result }` only.
- GitHub credentials: owned by the Server; not sent to the Worker or child processes.

## Deliberately not implemented

- Automatic Worker package distribution, installer, upgrade, repair, rollback, or signature
  verification.
- A repository base branch other than `main`.
- Private repository checkout credentials.
- GitHub review publication or merge operations.
- Optional execution-log and artifact retention.
- A repository checkout for issue-triage jobs.
- A repository-managed Windows service wrapper, automatic restart policy, or service installer.

## Verification requirements

Repository verification is run on `test-env` because local validation is not authorized by the
workspace policy. The required branch gate is:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

ProcessHost Go tests and Windows cross-compilation are separate checks. A final Windows-native
end-to-end exercise is still required before deployment because Linux CI cannot prove Windows
service-manager, Job Object, path, ACL, Git, or Codex runtime behavior.

## Latest verification

On 2026-09-05, implementation commit `3826a40` passed on `test-env` with Node.js 24.20.0 and pnpm
11.24.0:

- workspace typecheck;
- 63 test files and 961 tests: Codex 86, Contracts 8, Domain 21, Dashboard 53, Worker 387, and
  Server 406;
- all workspace builds, including the Dashboard production bundle and single Worker bundle; and
- Biome checks across 198 files.

ProcessHost passed `go test ./...` and `go vet ./...` with Go 1.26.7. The same source cross-compiled
for Windows amd64 and arm64. The repository CI additionally runs ProcessHost tests and deployment
PowerShell parser checks on a native Windows runner. The remaining release-level validation is the
operator-driven Windows E2E exercise described above.

The E2E acceptance follow-up fixed misleading evidence heuristics and documented the supported
GitHub authorization lifecycle used to create and cancel real review jobs. Its portable collector
regressions passed on Linux `test-env` with PowerShell 7.6.5, and Biome still passed across 198
files. These checks do not establish Windows process inspection or real release acceptance.
The Windows host, deployment configuration, permitted public PR, Codex authentication behavior,
and actual command evidence must be available before the remaining exercise can be completed.
