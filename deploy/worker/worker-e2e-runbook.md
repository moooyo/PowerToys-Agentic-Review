# Worker Windows E2E Runbook

This is an operator-driven release acceptance exercise for one manually deployed Windows Worker
and a real public GitHub pull request targeting an approved base branch. Running the evidence
collector alone does not perform this exercise or establish acceptance. Record each criterion as
passed, failed, or blocked, with evidence from the actual run.

The current 2026-09-05 follow-up has explicit local Windows verification authorization and an
approved PR targeting `dev`. That real E2E run is still in progress; this runbook does not certify
its outcome. Other tasks retain the default `test-env` verification policy unless locally authorized.

## Required inputs and execution authority

Prepare all of the following before starting:

- A Windows host explicitly authorized for this verification, its execution account, and the
  trusted Worker bundle, Node.js, Git, Codex CLI, and ProcessHost artifacts to deploy.
- PowerShell 7 or newer (`pwsh`) for the evidence collector and the commands in this runbook.
  Windows PowerShell 5.1 lacks the .NET path API used by the collector.
- `worker-config.psd1` populated from the template with absolute paths, pinned versions and
  SHA-256 digests, execution enabled, and distinct shared-cache and attempt-workspace directories.
- The node-scoped Worker authentication profile provisioned at
  `C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json` with private ACLs, and a reachable Server.
- Operator access to the Dashboard and read-only access to the deployed Server's job, attempt,
  authorization, and result records. The Dashboard provides reads; it has no create, cancel, or
  requeue action in this milestone.
- An approved public PR, its base ref, repository's numeric GitHub ID, PR number, immutable base SHA,
  and head SHA. The operator must have permission to change the selected PR's assignment or user
  review request for this exercise. Keep the PR revision stable during each attempt.
- Working GitHub ingestion for that repository, through a verified webhook and/or authenticated
  polling. The Server must configure `AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON`,
  `AGENTIC_REVIEW_GITHUB_TARGET_USER_ID`, and `AGENTIC_REVIEW_GITHUB_TARGET_LOGIN`, plus the selected
  ingestion credential. The acting user's numeric GitHub ID must be the configured reviewer or
  appear in `AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON`.
- Repository prerequisites and trusted instructions identifying real build and test commands,
  a way to retain their actual execution evidence, and an operation that remains active long
  enough to capture descendants and request cancellation.
- A documented Codex authentication mechanism for the pinned CLI under the Worker execution
  account and dedicated persistent profile described below. Current native CLI compatibility
  checks use Codex 0.145.0.

Missing host authorization, deployment files, credentials, permitted PR actions, or evidence
access blocks the corresponding acceptance step. Do not substitute a local development machine
without authorization. A Linux `test-env` can run Linux verification but cannot establish Windows
Job Object, keyring, descendant, or workspace behavior. Passing CI does not complete this runbook.

The Worker uses `WORKER_EXECUTION_PROFILE_DIRECTORY` as its dedicated persistent `CODEX_HOME`.
Provision a regular UTF-8 `config.toml` (at most 64 KiB) and supported file/keyring authentication or
provider `auth.command`/`auth.args` under the actual Worker identity. The Worker loads configuration
at startup, preserves authentication storage, and does not copy it into tasks. A successful login in
a different default profile is insufficient. Record only sanitized readiness facts and the selected
authentication mechanism; never include credential contents or process environments in evidence.

Before orphan cleanup, startup rejects profile/runtime directory links, aliases, overlap, and
observed identity changes. Task `USERPROFILE`, temporary files, control files, and the checkout
remain per-attempt. The loader allows only model/provider/auth settings. Codex then uses
`--ignore-user-config`, `--config approval_policy="never"`, and project trust `untrusted` to suppress
other configuration while retaining `AGENTS.md` and the trusted-code admission policy. MCP, plugins,
hooks, notifications, and inherited extra writable roots are disabled; only the current task
temporary directory is added to worktree write access.

Provider header values are carried in native-Codex-only `CODEX_PROVIDER_HEADER_<n>` variables,
not argv. Tool shells receive exactly `COMSPEC`, `PATH`, `PATHEXT`, `SYSTEMROOT`, `TEMP`, `TMP`, and
`USERPROFILE`, without the Codex home or credentials. Ambient API keys are not forwarded; provider
`env_key` and directly supplied `env_http_headers` are rejected. If the dedicated runtime cannot
authenticate, keep real execution blocked.

## Evidence setup and Worker registration

Create a private evidence directory outside Worker data and repository worktrees. Record the
deployed commit, binary versions and digests, host identity, execution account, UTC start time,
repository ID, PR URL, and expected base/head SHAs. Preserve the non-secret policy values used for
this run. Use a distinct output filename for each capture; the collector does not overwrite files.
Preparation fetches the immutable base SHA and PR head with full history, without a `main` fallback.
`--no-auto-maintenance` suppresses fetch's implicit maintenance; Worker-controlled budget and GC
policies remain active.

Capture a baseline of the configured shared repository, workspace root, and relevant process
identities before requesting work. Use the numeric GitHub repository ID, not the Server's internal
repository UUID:

```powershell
.\deploy\worker\invoke-worker-e2e.ps1 `
  -ConfigPath .\deploy\worker\worker-config.psd1 `
  -PullRequestUrl '<public-pr-url>' `
  -TaskId 'pending' `
  -RepositoryId 123456 `
  -CaptureStage baseline `
  -EvidenceOutputPath 'D:\E2E-Evidence\01-baseline.json'
```

The baseline has no job or attempt identity yet. Replace `pending` in subsequent captures with the
actual job ID; do not infer an attempt ID from a PR number or a job ID. For an existing shared
repository, retain its path and metadata across both attempts instead of deleting it for the test.

Start the Worker in the authorized Windows session and retain its JSON console output through
the host's approved log capture facility:

```powershell
.\deploy\worker\start-worker.ps1 -ConfigPath .\deploy\worker\worker-config.psd1
```

The launcher resolves Node.js to an absolute executable, places its directory first in `PATH`, and
removes empty and duplicate entries. Runtime path checks still apply. Do not add the removed
`WORKER_RECIPE_IDS` setting. If startup fails after ProcessHost creation, confirm that the failed
Worker and its ProcessHost exit and release the data-root mutex before retrying; startup cleanup
must preserve the original failure rather than leave a child process holding the singleton.

Save the `Worker registered.` record and the authenticated
`GET /api/v1/dashboard/workers` response identifying this node and instance. Confirm current
heartbeats, an online healthy node, and available capacity. If terminal acknowledgements are
needed in the console evidence, use `WORKER_LOG_LEVEL = 'debug'` for the acceptance deployment;
`Server terminal decision received.` is a debug record. Log verbosity does not retain Codex command
output.

## Create the successful review through GitHub

1. On the approved PR, have the configured reviewer or allowlisted actor assign the configured
   reviewer as an assignee, or request a review from that specific GitHub user. A team request,
   label, comment, or request by an unauthorized actor does not establish this authorization.
   Prefer one request kind for the exercise so its withdrawal has an unambiguous effect.
2. Wait for the webhook or polling cycle to ingest the action. Retain the GitHub action's time,
   actor ID, target ID, delivery/event identity, authorization decision, and opened request epoch.
   Confirm that the event created a `pull_request_review` job for the expected revision. Mere PR
   visibility in the Dashboard is not proof of authorization or scheduling.
3. Save the job detail from `GET /api/v1/dashboard/jobs/<job-id>`. While it is running, record the
   node, lease generation, phase, and revision. Read the `runAttemptId` from the matching
   `Lease claimed.` Worker log or a read-only Server attempt export. The Dashboard's `attempt`
   field is a count; its job detail does not expose the attempt identifier.
4. Before execution finishes, make an `active` collector capture with `-TaskId`, `-AttemptId`,
   `-RepositoryId`, and a new evidence path. Record the exact checkout and shared repository
   paths. The layouts are `repository-<githubRepositoryId>.git` under the shared root and
   `attempt-<lowercase SHA-256 of UTF-8 runAttemptId>\checkout` under the workspace root.

Capture the worktree while it still exists. In the authorized Windows session, using the pinned
Git executable and the exact paths from the active capture, retain these read-only outputs:

```powershell
$e2eConfig = Import-PowerShellDataFile -LiteralPath '.\deploy\worker\worker-config.psd1'
$e2eGit = [string]$e2eConfig['WORKER_GIT_EXECUTABLE_PATH']
$e2eSharedRepository = '<exact-shared-repository-path>'
$e2eCheckout = '<exact-attempt-checkout-path>'
$e2eBaseSha = '<immutable-job-base-sha>'
$e2eHeadSha = '<immutable-job-head-sha>'
& $e2eGit "--git-dir=$e2eSharedRepository" rev-parse --is-bare-repository
& $e2eGit "--git-dir=$e2eSharedRepository" worktree list --porcelain
& $e2eGit "--git-dir=$e2eSharedRepository" rev-parse --verify "${e2eBaseSha}^{commit}"
& $e2eGit "--git-dir=$e2eSharedRepository" merge-base $e2eBaseSha $e2eHeadSha
& $e2eGit -C $e2eCheckout rev-parse --verify 'HEAD^{commit}'
& $e2eGit -C $e2eCheckout rev-parse --git-common-dir
& $e2eGit -C $e2eCheckout symbolic-ref -q HEAD
$e2eDetachedHeadExitCode = $LASTEXITCODE
```

The repository must be bare, the worktree listing must identify this checkout as detached, and
checkout `HEAD` must equal the recorded PR head SHA. `--git-common-dir` must resolve to the expected
shared repository. The immutable base SHA must resolve as a commit and have a merge base with the
head, regardless of the base branch name or current tip. `symbolic-ref -q HEAD` returns exit code 1
with no branch reference for a detached HEAD; retain that expected exit code explicitly. A missing
checkout or another nonzero result is not proof of detachment. Do not run repository-wide maintenance
manually.

## Real build/test execution and accepted inline result

The trusted review prompt permits relevant build and test commands; it does not guarantee that
Codex chooses both. `requestedRecipeIds` remains empty because commands run within the review,
not through a separate recipe runner. Arrange the acceptance repository and trusted instructions
before scheduling so both required commands are meaningful and their evidence can be retained.

For each actual build and test, retain the command, checkout identity, start/end times, exit code,
and tool-produced output or test report, linked to this attempt. The evidence must show that the
managed Codex run launched the commands; an operator running them independently does not meet
this criterion. A Codex summary claiming success, a log containing the word `codex`, or an online
Worker is insufficient.

The Worker parses Codex JSONL in memory, discards stderr while draining it, uses ephemeral Codex
execution, and removes the attempt workspace. It has no persistent execution-log channel. Arrange
trusted host-side capture of the relevant process events and command logs before the run, and
retain worktree-produced reports before automatic cleanup. Do not weaken workspace cleanup or
add credential contents to capture output. If actual command evidence cannot be obtained, leave
the build/test criterion blocked instead of treating the structured review result as a substitute.

Wait for the successful job and its run attempt to reach `succeeded`. Export the job detail and
read-only Server result evidence. Record `reviewResultId`, `resultDigest`, job ID, attempt ID, and
the matching immutable revision. Confirm exactly one `review_results` row for this job and attempt
and consistency with the Dashboard projection. A permitted read-only SQL session on the Server
can bind the actual job ID as `:job_id` and use:

```sql
SELECT job.id AS job_id, job.status AS job_status, job.resource_revision,
       attempt.id AS run_attempt_id, attempt.attempt_number,
       attempt.worker_node_id, attempt.worker_instance_id, attempt.lease_generation,
       attempt.status AS run_status, attempt.started_at, attempt.ended_at,
       attempt.failure_code, attempt.result_digest,
       result.id AS review_result_id, result.result_digest AS accepted_result_digest
FROM jobs AS job
LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id
LEFT JOIN review_results AS result ON result.run_attempt_id = attempt.id
WHERE job.id = :job_id
ORDER BY attempt.attempt_number;

SELECT COUNT(*) AS accepted_result_count
FROM review_results
WHERE job_id = :job_id;
```

The count must be 1 for the successful job, with matching result digests. This is one accepted
inline result. HTTP completion submissions may retry after transient network errors, and the
Server can acknowledge the same payload idempotently. Do not count HTTP requests as distinct
accepted results or require exactly one network transmission. Do not export lease tokens, token
hashes, or the full database as evidence.

## Create a second attempt, prove cache reuse, and cancel its lease

1. After the first attempt has completed and cleaned up, remove its assignment or user review
   request on GitHub. If both request kinds are active, remove both for the configured reviewer.
   Wait until Server ingestion has closed all active authorization epochs for that PR. Repeated
   events while an epoch remains active can reuse an existing job; they are not a requeue action.
2. Have the authorized actor add the selected assignment or user review request again. Confirm
   a new epoch and a distinct job ID, then record its distinct `runAttemptId` from `Lease claimed.`
   or the Server. Use the same repository and unchanged PR revision to isolate shared-cache reuse.
3. While the new job is in `codex_review` and a known managed command/descendant is active, capture
   the second checkout, its detached HEAD, and its shared Git common directory. Compare with the
   first attempt: the bare repository persists at the same repository-ID path, the two attempt
   directories differ, and both checkouts use that shared repository. A generic `HEAD` file
   somewhere under the cache root does not prove reuse.
4. Retain a process-tree snapshot before requesting cancellation. Identify the configured
   ProcessHost executable and its Worker parent, then the Codex process and the known command's
   descendants. Record PID, parent PID, executable identity where available, and creation time.
   These observations must be associated with the active attempt and capture time. If a process
   exits before it can be identified, repeat the scenario with a suitably observable command.
5. While execution remains active, remove the final assignment/review request that authorizes
   this PR. Record the GitHub action, its actor/target, and ingestion evidence. Removing only one
   of two active request kinds does not request cancellation. Wait for the Server to set
   `cancel_requested`, the Worker to observe a heartbeat `cancel`, and both job and attempt to
   reach `cancelled`. If the job had already completed, the cancellation criterion was not tested.

The expected acknowledgement uses `CANCELLED_BY_SERVER` through the failure endpoint; it does not
publish a successful review. Retain the cancelled attempt's terminal state and confirm zero
`review_results` rows for the cancellation job, using the same read-only queries above. A lease
expiry, no-progress timeout, queued job becoming `stale`, or killing the Worker is a different
scenario and does not establish active lease cancellation.

The supported actions follow [GitHub event normalization](../../apps/server/src/github/normalize-webhook.ts),
[actor authorization](../../docs/adr/0006-github-ingestion-and-actor-authorization.md), and
[request-epoch scheduling and withdrawal](../../apps/server/src/database/github-ingestion.ts).
This exercise does not publish a GitHub review, merge a PR, or add Dashboard mutations.

## Descendant and workspace cleanup

After each terminal response, allow the configured teardown interval for deferred worktree and
process cleanup. A terminal Server status can precede cleanup completion. Fixed Git cleanup and
maintenance commands retain cleanup path guards, managed timeouts and resource limits, and shared
Git accounting. They do not run execution-phase attempt scans while removing link targets; pnpm
store links can temporarily dangle until final attempt deletion, which must not follow the links.
Retain an after snapshot and correlate it with the active snapshot:

- Every captured descendant of that attempt must be gone by PID and creation time. Match both
  fields because Windows can reuse PIDs. To establish no surviving descendant, also retain the
  approved host process-lifecycle capture covering the cancellation interval; one late snapshot
  cannot recover ancestry that disappeared before capture.
- The Worker and its long-lived ProcessHost should remain healthy after task teardown. The
  absence of ProcessHost is not proof of descendant cleanup, and a running ProcessHost is not
  itself an orphan. Retain subsequent Worker heartbeats and available capacity. If health is
  uncertain, schedule another permitted review through a fresh authorization epoch.
- The specific attempt directory observed during execution must now be absent, and its entry
  must be absent from the shared repository's `worktree list --porcelain` output. Do not manually
  delete it to satisfy the check. A missing root, an empty root never observed during execution,
  or unrelated attempt directories cannot establish this attempt's cleanup.
- The shared bare repository must remain available for the next attempt. Capture the six shared
  Git policy values and any maintenance/drain records without invoking manual GC. Policy settings
  establish configuration evidence, not proof that a particular GC cycle ran.

Capture collector observations with the real identities and distinct paths:

```powershell
.\deploy\worker\invoke-worker-e2e.ps1 `
  -ConfigPath .\deploy\worker\worker-config.psd1 `
  -PullRequestUrl '<public-pr-url>' `
  -TaskId '<successful-job-id>' `
  -AttemptId '<successful-run-attempt-id>' `
  -CancelTaskId '<cancelled-job-id>' `
  -CancelAttemptId '<cancelled-run-attempt-id>' `
  -RepositoryId 123456 `
  -CaptureStage cancelled `
  -WorkerLogPath 'D:\E2E-Evidence\worker.log' `
  -EvidenceOutputPath 'D:\E2E-Evidence\04-cancelled.json'
```

Use `active` for captures during each attempt, `completed` after successful cleanup, and
`cancelled` after cancellation cleanup. Optional identity parameters improve correlation; omitted
or unavailable observations leave those facts unestablished. The collector reports observations
with `acceptanceStatus = 'unverified'`; it does not turn manual criteria into passes.

## Final evidence bundle and decision

Archive a manifest linking the deployed commit and non-secret configuration to:

- Worker registration, node/instance identity, and before/after health responses.
- GitHub repository/PR/revision identity, authorized opening/withdrawal actions, and request epochs.
- Both job IDs and all their attempt IDs, phases, lease generations, and terminal states.
- Active detached-worktree and shared-repository evidence from both attempts.
- Actual Codex-launched build/test command evidence and exit results.
- The single accepted success result ID/digest and absence of a success result for cancellation.
- Before/during/after descendant identities, lifecycle capture, and per-attempt cleanup evidence.
- Timestamped collector JSON files, source logs/reports, and any missing or failed observations.

Only mark release acceptance complete when every required criterion has evidence from this real
Windows exercise. Preserve failures and unresolved prerequisites as failed or blocked; neither the
collector's JSON output nor successful CI runs can replace the missing run.
