# PowerToys Agentic Review

Agentic Review investigates GitHub pull requests and issues, produces complete structured
reports, and prepares explicit follow-up actions. The application is unreleased. Its active
execution model uses `Task`, `Attempt`, `LoopCheckpoint`, `Report`, and `ActionIntent`.
The refactor does not provide legacy API compatibility, dual writes, data conversion, or
migration scripts.

The [current design](./docs/design/2026-09-15-structured-investigation-results-and-loop.md)
describes the result contract, complete investigation loop, and action rules. The
[architecture](./ARCHITECTURE.md) and application instructions document the active runtime and
deployment boundaries.

## Runtime components

- `apps/server`: the new SQLite-backed Task/Report API, built-in password accounts and scoped sessions,
  Worker credentials, immutable checkpoints and reports, action preparation, and delivery.
- `apps/worker`: an outbound Windows Worker using the new task protocol. ProcessHost owns
  process trees; disposable workspaces hold exact source, model inputs, and captured artifacts.
- `apps/dashboard`: the Material UI PR, Issue, Task, Report, and repository workspaces.
- `packages/contracts`: runtime schemas and semantic validators for the new protocol.
- `packages/domain`: investigation loop transitions, completion rules, action recommendations,
  and permissions computed from the complete result collection.
- `packages/codex`: shared low-level CLI launch and output handling.
- `native/process-host`: managed Windows process lifetime and resource enforcement.

The production Server starts through `apps/server/src/main.ts`; the Worker starts through
`apps/worker/src/main.ts`, bundled as `dist/worker.mjs`. Both select the new investigation
runtime. Older source modules and acceptance receipts describe their original scope and
are not alternate production endpoints or migration inputs.

## Structured investigations

PR and Issue investigation use a persistent discovery and recheck loop. Every retained finding
contains its priority, trigger, impact, root cause or explicit uncertainty, evidence, repair
advice, feedback draft, and final-version recheck. Priorities order presentation; they never
silently limit the final report to top-k findings.

Completion requires handled coverage and candidate records, valid final rechecks, and a sealed
report. Budget exhaustion, cancellation, unavailable inputs, and protocol failures produce
explicit partial outcomes. A successful CLI exit does not establish investigation completeness.
Checkpoints support continuation without discarding confirmed findings or replaying uncertain
execution steps.

Reports distinguish original PR revisions, Issue snapshots, explicitly selected commits, local
patches, and verified remote branches. Verification results preserve their exact subject and
evidence. Passing checks on a local patch do not certify the original PR or an upstream fix.

## Recommendations and actions

The Server computes recommendations separately from current operation permissions. A confirmed,
unresolved P0 on the current original PR blocks Approve. P1 findings, missing required E2E,
and incomplete analysis change the recommendation but do not add that content prohibition.
Actual actor permissions, target state, SHA, and unresolved delivery are checked independently.

Saved plans and validated `nextActions` drive follow-up preparation. Missing source or environment
inputs can be supplied in a preparation form; execution still requires real prerequisites.
Linked verification preserves the parent report and selected scenarios instead of repeating a
full review. Implementation produces separately identified edits and patches. Creating a PR
requires an existing, verified remote branch and never implicitly commits or pushes.

GitHub writes require a prepared and confirmed action intent. Unknown delivery is reconciled
with read-only requests, not automatically resent. The default Server configuration disables
external writes. Automated tests must not write to real PRs or issues; see [AGENTS.md](./AGENTS.md).

## Configuration and development

Use Node.js 24.20.x and pnpm 11.24.x. The Server uses `INVESTIGATION_*` configuration; the Worker
uses `INVESTIGATION_WORKER_*`. Read the [Server instructions](./apps/server/README.md) and
[Worker instructions](./apps/worker/README.md) before starting a deployment. New investigation databases are
initialized directly with the `investigation-v2` schema; an incompatible existing database is
rejected without conversion or deletion.

The Dashboard development server uses clearly labeled synthetic data, including PowerToys PR,
Bug, Feature, incomplete-report, and page-two P0 examples:

```powershell
pnpm --filter @agentic-review/dashboard dev
```

Production Dashboard requests use the authenticated new API and never fall back to sample data.

## Built-in accounts

The console uses application-owned username/password accounts. The first administrator is
initialized from deployment configuration, with no default production password. Administrators
manage accounts and explicit repository/action grants; account administration does not implicitly
grant access to every repository. Password changes, resets, disabled accounts, and permission
changes revoke existing sessions.

Read the [Server account setup and recovery instructions](./apps/server/README.md) before starting
a new deployment. The account database is initialized separately from investigation data;
third-party login and conversion of the previous authentication database are outside this scope.
GitHub API credentials and Worker credentials remain independent of console login.

The [account design](./docs/design/2026-09-15-built-in-accounts.md) records the API, session behavior,
and acceptance scope. Dedicated PowerToys UI scenarios and model-quality evaluation are not part
of this delivery, following the user's current scope decision.

Run verification on the project-designated remote Windows worker. Linux-specific checks may use
`test-env`; local verification requires explicit authorization for the current task. Standard
package build, typecheck, test, and lint scripts remain available. The
[investigation acceptance instructions](./deploy/investigation-acceptance/README.md) describe the
opt-in synthetic lifecycle harness and real CLI companion, including prerequisites and exclusions;
their availability does not imply a completed acceptance run. Tests should use mocked transports
and isolated databases, with no real repository mutations.

## Evidence and project status

Evidence retention defaults to 30 days, 1 GiB of resident original content, and 10,000 resident
artifacts. Bounded cleanup preserves recovery and follow-up source dependencies. Current artifact
availability is separate from immutable reports, and inherited patches retain their original
producer identities in `sourceArtifacts`. See the [Server evidence instructions](./apps/server/README.md#evidence-retention-and-capacity)
for configuration, HTTP availability responses, and physical SQLite storage limits.

[Implementation Status](./docs/IMPLEMENTATION_STATUS.md) distinguishes this refactor from historical
milestones. M39/M40 model workflows, M41 publication acceptance, M42 selected PowerToys tests, and
the later fork build receipts retain their exact recorded revisions and scope. They do not by
themselves accept the new Task protocol, a new Windows deployment, or a new model/UI scenario.
