# PowerToys Agentic Review Architecture

## Scope

This document describes the current pre-release architecture. ADR 0029 replaces the unpublished
Control/Executor split, local RPC protocols, result-artifact pipeline, and signed Worker package
flow. No compatibility or migration path is retained for those prototypes.

The system has three application processes and one native execution helper:

- a Linux Server;
- a browser Dashboard served by the Server;
- one outbound-only Windows Worker process per node; and
- `AgenticReview.ProcessHost.exe`, launched by the Worker for bounded child process execution.

## System flow

```text
GitHub webhook/poller
        |
        v
Linux Server ---- SQLite
    |  ^
    |  | HTTPS + Worker Bearer Token
    v  |
Windows Worker
    |
    +-- shared bare Git repository per GitHub repository
    +-- detached worktree per run attempt
    +-- ProcessHost -> Git / Codex / validation process trees
```

The Server is the only component that owns SQLite and GitHub ingestion credentials. The Worker
receives job envelopes and reports progress and terminal results. It does not receive a GitHub
publication credential and does not open the Server database.

## Trust model

Repositories, revisions, prompts, and executable validation selected by admission policy are
trusted execution inputs. The Worker is allowed to execute builds and tests from the admitted
worktree.

This trust decision removes the need for a separate credential-free Executor service. It does not
remove operational controls:

- Server leases and generations fence stale Workers and replayed terminal reports.
- ProcessHost creates Windows Job Objects with kill-on-close, timeout, process-count, memory, and
  combined-output limits.
- Git and Codex receive replacement environments.
- Worker Bearer Tokens and Server-side GitHub credentials are never propagated to child processes.
- Worktrees and task control, temporary, and user-profile directories are deleted after terminal
  reporting; the dedicated Codex authentication home persists.

ProcessHost is a reliability and resource-control boundary, not an adversarial same-user sandbox.

## Server

The Fastify Server owns:

- GitHub webhook verification and optional polling;
- authorization of configured repositories and actors;
- immutable work-item and revision projections;
- job creation, retry policy, claims, leases, heartbeats, and terminal fencing;
- inline result validation and persistence;
- Worker credential creation, rotation, revocation, and authentication;
- operator authentication and Dashboard APIs; and
- health and recovery-maintenance behavior.

SQLite has one process owner. The current schema is migrations `0001` through `0008`. Result bytes
are stored only in the database's bounded inline result fields; there is no artifact filesystem or
artifact Worker Thread.

### Worker API

The current Worker surface is intentionally small:

```text
POST /api/v1/worker/instances
POST /api/v1/worker/leases/claim
PUT  /api/v1/worker/instances/{workerInstanceId}/heartbeat
PUT  /api/v1/worker/leases/{runAttemptId}/heartbeat
POST /api/v1/worker/runs/{runAttemptId}/complete
POST /api/v1/worker/runs/{runAttemptId}/fail
```

Every request uses a node-scoped Bearer Token. Lease-token, Worker-instance, generation, and active
attempt checks are still required for progress and terminal operations.

## Operator authentication

Operator authentication has two explicit modes:

- `loopback`: for a Server whose listener and public origin are both loopback; and
- `oidc`: for an externally reachable deployment using Authorization Code plus PKCE.

OIDC is therefore a deployment choice, not a Worker execution dependency. GitHub webhook secrets
and GitHub read tokens are independent credentials and are unrelated to operator OIDC.

## Windows Worker

The Worker is one Node.js process built as `apps/worker/dist/worker.mjs`. A service manager may run
that process, but the repository does not currently ship a native Worker service wrapper or
installer. Manual trusted deployment is the supported pre-release path.

At startup the Worker:

1. loads its fixed Bearer Token profile;
2. checks persistent Codex and runtime directory identities using read-only `lstat`/`realpath`
   validation, rejecting links, aliases, overlap, and observed identity changes;
3. loads allowed Codex profile settings and validates executable paths and SHA-256 digests;
4. starts ProcessHost over its NDJSON standard-I/O protocol and acquires the data-root singleton;
5. sweeps abandoned attempt directories;
6. registers one Worker instance; and
7. enters the claim, heartbeat, execute, and terminal-report loop.

Any initialization failure after ProcessHost creation closes that client before rethrowing the
original error. Cleanup diagnostics are bounded and cannot mask the startup failure.

Only one Worker process may use a node's data, shared-repository, and workspace directories at a
time. ProcessHost holds a Windows global named mutex derived from the resolved Worker data root for
its complete lifetime. A service manager may restart the Worker, but it is not the exclusivity
boundary.

## Git repository and worktree lifecycle

Each configured public GitHub repository maps to one persistent bare repository:

```text
<git-shared-root>/repository-<githubRepositoryId>.git
```

For each pull request attempt, the Worker serializes repository metadata mutation for that
repository and performs the following operations:

1. initialize or reuse the bare repository;
2. set the canonical GitHub `origin` URL;
3. prune stale worktree registrations;
4. fetch the envelope's immutable `baseSha` and pull request head ref without shallow history,
   using `--no-auto-maintenance`;
5. verify the fetched pull request head equals the envelope's immutable `headSha`;
6. verify the envelope `baseSha` and `headSha` are commits and have a merge base;
7. create a detached worktree at the exact `headSha`; and
8. verify the worktree `HEAD` again before Codex starts.

The fetch is independent of the base branch name or its current tip. It supports PRs targeting
`dev` or any other base ref without assuming or falling back to `main`. Queued jobs retain their
immutable base SHA when the branch advances.

The current Worker uses an anonymous GitHub HTTPS URL and disables credential helpers. Private
repository checkout is not supported by this MVP.

Worktrees live below the attempt workspace root. The bare repository persists across jobs, so
subsequent fetches transfer only missing objects. A cancellable shared-cache mutation lock serializes
global accounting and bare-repository setup or cleanup across repositories; per-repository locks
preserve ordering for each repository. Once prepared, worktrees for different jobs can execute
concurrently.

The shared repository root has a separate total-byte limit and minimum-free-disk guard. Accounting
is bounded by entry count and wall-clock time and fails closed on reparse points or unstable paths.
The Worker checks the budget before and after fetch and after worktree cleanup. When the budget is
violated, it first prunes stale worktree metadata, verifies that no registered or in-memory worktree
is active, expires reflogs only to the configured conservative age, and runs repository-local GC
with the same prune age. A cache that remains over budget is reported as a node infrastructure
fault so the Worker drains instead of accepting more work.

Issue-triage jobs currently use an isolated non-repository workspace because their envelope contains
an issue snapshot rather than a repository revision.

## Codex execution

The Server renders a trusted versioned prompt and sends its digest and authoritative output schema
in the job envelope. The Worker independently selects the matching compiled schema, verifies the
envelope, and writes only the per-attempt schema and result control files. The persistent
`WORKER_EXECUTION_PROFILE_DIRECTORY` is the dedicated `CODEX_HOME`; the Worker does not overwrite its
operator-provisioned `config.toml` or copy authentication files into worktrees.

The profile loader allows only supported model, selected-provider, and authentication settings.
Provider HTTP header values are converted to `CODEX_PROVIDER_HEADER_<n>` environment variables for
native Codex; their values are not serialized into command-line overrides. Build/test shells get
exactly `COMSPEC`, `PATH`, `PATHEXT`, `SYSTEMROOT`, `TEMP`, `TMP`, and `USERPROFILE`, with no Codex
home, provider credentials, Worker Token, or GitHub credentials.

Codex runs with:

- `sandbox_mode = "workspace-write"`;
- `--ignore-user-config` and fixed CLI overrides after the allowed operator settings;
- `--config approval_policy="never"` rather than the unsupported exec `--ask-for-approval` form;
- outbound network access enabled inside that sandbox;
- the prepared worktree as its working directory;
- project instructions such as `AGENTS.md` enabled;
- project trust `untrusted`, suppressing repository config without changing the trusted-code policy;
- MCP, plugins, hooks, notifications, and inherited extra write roots disabled, with only the current
  task temporary directory added to the worktree's write access;
- a replacement environment without Worker credentials; and
- ProcessHost resource and lifetime limits.

The pinned native CLI used for the current compatibility checks is Codex 0.145.0. The dedicated
profile must have `config.toml` and supported file/keyring authentication or a supported provider
authentication command; a login in another default profile does not establish Worker readiness.

The pull request prompt explicitly permits inspection, edits, builds, tests, and other validation
inside the disposable worktree. It forbids publishing, pushing, merging, or mutating external
systems.

## Result contract

The MVP has one completion form:

```json
{"resultDigest":"<sha256>","result":{}}
```

The Worker validates the model output against the job schema, canonicalizes it, computes its digest,
and submits the inline result. The Server revalidates the result before the fenced database
transaction completes the attempt.

Operators can read the structured persisted result through the authenticated Dashboard job-detail
endpoint. The response projects the validated PR findings or issue-triage fields and does not create
or expose a second raw-result or artifact channel.

There are no artifact-create, chunk-upload, artifact-finalize, or artifact-backed-completion routes.
Optional log or artifact retention may be designed later without becoming a second authoritative
result channel.

## Deployment

The Server is expected to run on Linux with private SQLite storage. The Worker is manually deployed
to Windows with pinned Node.js, Git, Codex CLI, `worker.mjs`, and ProcessHost binaries. Automatic
package distribution, Ed25519 release signing, upgrades, repair, and rollback are outside the MVP.

Production network deployments use HTTPS. Loopback development may explicitly allow HTTP. The
Worker initiates all Server connections; no inbound Worker listener is required.

## Recovery maintenance

`AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true` starts a loopback-only recovery boundary. It keeps
liveness open, readiness closed, Worker routes closed, GitHub ingestion stopped, and lease reaping
stopped while operators reconcile the restored database and Worker credentials. See
`docs/operations/worker-token-recovery.md`.

The authorized Windows runtime E2E exercise passed, including healthy success, active cancellation,
cache reuse, and recovered cleanup. Its tested scope, evidence, and environment closeout are in the
[live validation handoff](./docs/handoff/2026-09-05-windows-e2e-live-validation.md).

## Known pre-release gaps

- Automatic Windows service installation, restart policy, and upgrade management remain
  deployment-owned.
- Repository checkout currently supports only anonymously readable public GitHub repositories.
- GitHub publication, approval workflows, and optional execution-log retention are not implemented.
