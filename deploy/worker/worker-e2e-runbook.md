# Worker Windows E2E Runbook

This runbook validates one manually deployed Windows Worker against a real public GitHub PR on
`main`. It is intentionally operator-driven and keeps the MVP model: no auto-installer and no
automatic rollout/distribution.

## Required inputs

- One Worker host with deployment artifacts already copied.
- `deploy/worker/worker-config.psd1` populated from the template.
- Worker auth profile provisioned at
  `C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json`.
- One real public repository and one real pull request against `main`.
- Server operator credential and dashboard access.

## Step 1: Preflight

1. Confirm the Worker auth profile file exists and has private ACLs.
2. Confirm pinned binary paths and SHA-256 values in `worker-config.psd1` are correct.
3. Confirm `WORKER_EXECUTION_ENABLED='true'`.
4. Confirm `WORKER_GIT_SHARED_ROOT_DIRECTORY` and `WORKER_WORKSPACE_ROOT_DIRECTORY` are separate.
5. Confirm shared Git cache and conservative GC policy values are configured.

## Step 2: Start worker

Run:

```powershell
.\deploy\worker\start-worker.ps1 -ConfigPath .\deploy\worker\worker-config.psd1
```

Expected evidence:

- Worker starts without exposing tokens/secrets in console output.
- Registration succeeds and node status is healthy in dashboard/API.

## Step 3: Real PR execution

Create one review task that targets a real public `main` pull request. Wait for completion.

Expected evidence:

- Shared bare repository created/updated under `WORKER_GIT_SHARED_ROOT_DIRECTORY`.
- PR head fetched and detached worktree prepared under `WORKER_WORKSPACE_ROOT_DIRECTORY`.
- Codex executes build/test commands requested by the review recipe.
- Exactly one inline completion payload is submitted.
- Dashboard and stored result are consistent.

## Step 4: Lease cancellation behavior

Run one new review task and cancel it while execution is active.

Expected evidence:

- Worker observes lease cancellation and transitions task to terminal cancellation status.
- No duplicate completion publication is emitted.

## Step 5: ProcessHost descendant cleanup

During or after cancellation, verify ProcessHost-managed descendants are terminated.

Expected evidence:

- No orphaned descendant process remains after task teardown.
- Worker process remains healthy for subsequent tasks.

## Step 6: Workspace cleanup

After each completed/cancelled attempt, verify the attempt directory is removed from
`WORKER_WORKSPACE_ROOT_DIRECTORY`.

Expected evidence:

- No stale attempt directories from just-finished runs.
- Shared repository remains available for reuse.

## Step 7: Shared Git policy evidence

Capture shared Git policy evidence using:

```powershell
.\deploy\worker\invoke-worker-e2e.ps1 `
  -ConfigPath .\deploy\worker\worker-config.psd1 `
  -PullRequestUrl '<public-pr-url>' `
  -TaskId '<review-task-id>'
```

Expected evidence:

- JSON output includes `shared-git-policy-config` with `observed` status.
- Runtime and deployment records indicate shared Git maintenance is Worker-side and conservative.
- No manual repository-wide GC operational dependency exists.

## Evidence bundle

Capture and archive:

- Start log snippets (registration and health).
- Review task IDs and associated PR URL.
- Inline completion payload identifier.
- Cancellation task ID and terminal status proof.
- Process list snapshot proving descendant cleanup.
- Workspace directory snapshots before/after cleanup.
- Shared Git policy evidence in `invoke-worker-e2e.ps1` output JSON.
