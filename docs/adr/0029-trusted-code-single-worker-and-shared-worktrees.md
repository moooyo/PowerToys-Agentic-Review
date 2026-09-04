# ADR 0029: Trusted Code, Single Worker, and Shared Worktrees

## Status

Accepted on 2026-09-05.

## Context

The project has not shipped any Worker package, installer, or runtime compatibility promise. We are
still in a pre-release phase, so we can simplify execution architecture and repository lifecycle
without migration obligations.

ADRs 0007-0024 and 0026-0028 developed split-worker, package, local-channel, Server-binding, and
artifact trajectories that no longer match the selected MVP direction. ADR 0025 remains the
selected per-Worker Bearer Token profile. We need one coherent baseline for trusted execution,
repository materialization, and result reporting.

## Decision

1. Release posture:
   - No backward compatibility or migration path is required for this decision set.
   - Existing unpublished split-service and local-channel trajectories are replaced.

2. Trust model for execution code:
   - Execution code admitted by policy is treated as trusted code.
   - OIDC and signed distribution are not MVP prerequisites.
   - If and when automatic distribution is introduced, signature-based distribution controls will be
     added at that time.

3. Runtime service architecture:
   - Replace the Control/Executor split with one Windows Worker process, managed as a service when
     deployed.
   - Keep the per-Worker Bearer Token model for Server authentication.
   - Keep lease and fencing semantics for server-coordinated ownership and replay safety.
   - Keep ProcessHost and Job Object based process containment.
   - Keep explicit resource limits.
   - Do not pass server credentials to child processes.

4. Pull request repository and worktree model:
   - Maintain one persistent shared Git repository/object store per upstream repository.
   - Before each pull request task, fetch from remote to make required objects available.
   - Create a detached worktree at the exact pull request task `headSha`.
   - Retain enough commit history to compute `merge-base` reliably for task and review workflows.
   - Remove the task worktree after task completion.

5. Result and log contract:
   - Inline result is the only result delivery path for MVP.
   - Ordinary execution logs are not a second result channel.
   - Ordinary execution logs may be exposed later as optional artifacts.

## Consequences

- The MVP implementation surface is reduced: one Worker process, one credential boundary, one
  result channel.
- Unpublished split-service compatibility code and migration logic are unnecessary and should not be
  carried forward.
- Shared per-repository object stores reduce repeated clone cost while preserving per-task isolation
  through detached worktrees.
- Security hardening focus remains on policy admission, lease/fencing correctness, process
  containment, and credential non-propagation to child processes.

## Supersedes / Replaces

- ADRs 0007 through 0024 are retained only as historical records of the unpublished split-worker,
  package, artifact, installer, and Server-binding designs.
- ADRs 0026, 0027, and 0028 are also superseded before publication.
- ADRs 0002, 0003, and 0004 are amended only where they previously required artifact storage,
  Worker mTLS, ServiceHost, signed packaging, or untrusted-code execution restrictions.

ADR 0025 remains authoritative for Server authentication by one node-scoped Bearer Token, with its
single Worker storage path and schema version updated to match this decision.
