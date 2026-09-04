# Implementation Status

Current as of 2026-09-05 on branch `codex/trusted-single-worker`.

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
- Per-attempt disk reservation, monitoring, cleanup, and startup orphan sweep.
- One persistent shared bare Git repository per configured public GitHub repository.
- Per-repository serialization of fetch and worktree metadata operations.
- Full-history fetch of `main` and the GitHub pull request head ref.
- Immutable base/head commit checks, merge-base validation, detached worktree creation, and final
  `HEAD` verification.
- Codex workspace-write execution with outbound network access for trusted admitted code.
- Pull request prompt authorization to inspect, edit, build, and test inside the disposable
  worktree.
- Inline schema-validated result submission.

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
- Task checkout: detached worktree below the per-attempt workspace directory.
- Completion: inline `{ resultDigest, result }` only.
- GitHub credentials: owned by the Server; not sent to the Worker or child processes.

## Deliberately not implemented

- Automatic Worker package distribution, installer, upgrade, repair, rollback, or signature
  verification.
- A repository-cache size limit or automatic Git garbage-collection policy.
- A repository base branch other than `main`.
- Private repository checkout credentials.
- GitHub review publication or merge operations.
- Optional execution-log and artifact retention.
- A repository checkout for issue-triage jobs.
- A repository-managed Windows service wrapper and cross-process single-instance lock.

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

On 2026-09-05, the complete staged snapshot passed on `test-env` with Node.js 24.20.0 and pnpm
11.24.0:

- workspace typecheck;
- 61 test files and 924 tests: Codex 86, Contracts 4, Domain 21, Dashboard 48, Worker 366, and
  Server 399;
- all workspace builds, including the Dashboard production bundle and single Worker bundle; and
- Biome lint/format checks across 196 files.

ProcessHost passed `go test ./...` and `go vet ./...` with Go 1.26.7. The same source cross-compiled
for Windows amd64 and arm64. A separate real-Git exercise created an origin, fetched `main` and a
GitHub-style pull request ref into a persistent bare cache, verified the immutable SHAs and merge
base, created a detached worktree, and removed its registration successfully.
