# Worker Cache Governance and Result Operations Handoff

Status date: 2026-09-05

Branch: `main`

Base commit: `8ecac63f49dd4ba984ed37b4dddb758942d55325`

Implementation commit: `3826a4056145add877110c815d2ceb87cbed4e09`

GitHub Actions: [CI run 33930740444](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/33930740444)

## Outcome

The prioritized implementation scope is complete on `main`: operators can inspect persisted job
results, the Worker no longer fabricates progress, shared Git storage has bounded accounting and
conservative automatic maintenance, Windows execution has a cross-process singleton, and the
repository has Linux and Windows CI gates. The system remains intentionally limited to one trusted
Windows Worker, public GitHub repositories, `main` pull-request bases, inline results, optional
operator OIDC, and manual deployment.

No pull request or intermediate branch was created. The implementation was committed and pushed
directly to `main` as requested.

## Completed scope

### Structured job result details

- Added authenticated `GET /api/v1/dashboard/jobs/:jobId`.
- Added the database `getJob` read operation and projections for PR findings and issue triage.
- Added a responsive Jobs-page detail drawer with execution, failure, digest, finding, and triage
  information.
- Kept the response structured and bounded. The Dashboard endpoint does not repeat canonical raw
  result JSON and does not create an artifact channel.
- Added strict contract, database, route, adapter, and mapper coverage, including result limits,
  invalid line ranges, canonical 404 handling, and stale-request suppression.

### Execution progress policy

- Removed the unused `maxCodexTurns` policy and all `--max-turns` launch-spec remnants.
- Removed timer-generated Git and Codex progress.
- Codex progress now advances only when stdout or stderr activity is observed, with throttling.
- Silent execution is therefore eligible for the Server's configured no-progress deadline.

### Shared Git cache capacity and safe GC

The Worker now consumes these deployment controls:

- `WORKER_GIT_SHARED_CACHE_MAX_BYTES`
- `WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES`
- `WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT`
- `WORKER_GIT_SHARED_SCAN_TIMEOUT_MS`
- `WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES`
- `WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS`

The production defaults are 64 GiB total cache, 10 GiB minimum free disk, 250,000 scan entries,
30 seconds scan time, 60 minutes minimum GC interval, and a 168-hour prune age.

The implementation:

- performs bounded whole-root accounting before and after fetch and after worktree cleanup;
- rejects reparse points, unstable paths, unsupported entries, and scan-limit overruns;
- serializes whole-cache accounting and bare-repository mutations through a cancellable global
  shared-cache lock, while retaining per-repository ordering;
- prunes stale worktree metadata before maintenance;
- checks both in-memory active worktrees and real bare-repository worktree metadata;
- expires reachable and unreachable reflogs only to the configured age;
- runs repository-local `git gc --prune=<configured-age>` without `--aggressive` or `--prune=now`;
- best-effort removes the attempt directory even when worktree or maintenance cleanup fails; and
- reports `GIT_SHARED_CACHE_LIMIT_EXCEEDED` as a node infrastructure fault so the Worker drains when
  reclamation cannot restore the configured budget.

Prepared worktrees may execute concurrently. Shared-cache preparation and cleanup are serialized so
another repository cannot mutate the root during global accounting.

### Windows single-instance enforcement

- The Worker resolves its configured data root and derives a deterministic lowercase SHA-256
  instance key from that canonical root.
- ProcessHost requires the key through `--instance-key`.
- On Windows, ProcessHost holds `Global\AgenticReview.Worker.<instance-key>` for its lifetime.
- A duplicate ProcessHost receives `ERROR_ALREADY_EXISTS` and exits with the dedicated duplicate
  instance exit code.
- The launch PowerShell process scan remains a convenience preflight; the named mutex is the actual
  cross-session exclusivity boundary.

The same-user environment remains trusted. The mutex and Job Object are reliability boundaries, not
hostile same-token isolation.

### CI and deployment assets

- Added `.github/workflows/ci.yml` for pushes to `main`, pull requests, and manual dispatch.
- Linux CI runs the complete Node typecheck, test, build, and lint gates.
- Linux ProcessHost CI runs Go tests, vet, and Windows amd64/arm64 cross-builds.
- Windows CI runs Worker typecheck, tests, and bundle build; native ProcessHost tests, vet, and
  build; and parses every `deploy/worker/*.ps1` file.
- Added `worker-config.template.psd1`, `start-worker.ps1`, a Windows E2E runbook, and an evidence
  collection helper.
- No standalone maintenance script is shipped. Git maintenance is Worker-owned.
- Deployment remains manual and trusted. There is no Worker package distribution, installer,
  upgrade protocol, rollback protocol, or release-signing requirement in this milestone.

## Verification evidence

The final committed snapshot was verified on `test-env` with Node.js 24.20.0 and pnpm 11.24.0:

```text
Workspace typecheck:                 passed
Test files:                          63 passed
Tests:                               961 passed
  Codex:                              86
  Contracts:                           8
  Domain:                              21
  Dashboard:                           53
  Worker:                             387
  Server:                             406
Workspace production build:         passed
Biome:                               passed; 198 files checked
ProcessHost go test ./...:           passed
ProcessHost go vet ./...:            passed
Windows amd64 ProcessHost build:     passed
Windows arm64 ProcessHost build:     passed
```

GitHub Actions run `33930740444` completed successfully for commit `3826a40`:

- Node Linux Checks: passed;
- ProcessHost Linux Checks: passed; and
- Windows Worker Checks: passed, including the real Windows named-mutex tests and PowerShell parser
  checks.

The only CI annotation is GitHub's platform notice that some upstream actions still target the
deprecated Node.js 20 action runtime and are currently forced onto Node.js 24. It is not a project
test failure.

## Remaining release acceptance

One operator-driven Windows E2E exercise is still required before deployment. Follow
`deploy/worker/worker-e2e-runbook.md` with a real public pull request targeting `main` and capture:

- Worker registration and healthy status;
- shared bare-repository reuse and detached worktree creation;
- real Codex execution of repository build and test commands;
- exactly one inline completion;
- active lease cancellation;
- ProcessHost descendant cleanup; and
- attempt workspace cleanup.

`invoke-worker-e2e.ps1` only collects evidence. It must not be treated as the executor of that E2E
workflow.

## Deferred scope

The following are not required for this completed milestone and remain explicit future work:

- private repository credentials;
- pull-request base branches other than `main`;
- GitHub review publication, approval, or merge operations;
- Dashboard cancel, requeue, and drain mutations;
- optional execution-log or artifact retention;
- automatic Worker distribution, installation, upgrade, rollback, or signing; and
- repository checkout for issue-triage jobs.
